import * as net from 'net';

export type EndpointCheckType = 'http' | 'tcp' | 'keyword';

export type EndpointCheckFailureType =
  | 'timeout'
  | 'dns_failure'
  | 'connection_refused'
  | 'http_4xx'
  | 'http_5xx'
  | 'keyword_not_found'
  | 'connection_error';

export interface EndpointCheckConfig {
  type: EndpointCheckType;
  target: string;
  timeoutMs: number;
  keyword?: string;
}

export interface EndpointCheckResult {
  status: 'pass' | 'fail';
  statusCode: number | null;
  latencyMs: number;
  errorType: EndpointCheckFailureType | null;
  errorDetail: string | null;
}

function boundedTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return 10_000;
  return Math.min(30_000, Math.max(1_000, Math.round(timeoutMs)));
}

function networkErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === 'string') return causeCode;
  }
  return undefined;
}

function classifyNetworkError(error: unknown, timeoutMs: number): EndpointCheckResult {
  const code = networkErrorCode(error);
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED') {
    return {
      status: 'fail',
      statusCode: null,
      latencyMs: 0,
      errorType: 'timeout',
      errorDetail: `Request timed out after ${timeoutMs}ms`,
    };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      status: 'fail',
      statusCode: null,
      latencyMs: 0,
      errorType: 'dns_failure',
      errorDetail: `DNS lookup failed${code ? ` (${code})` : ''}`,
    };
  }
  if (code === 'ECONNREFUSED') {
    return {
      status: 'fail',
      statusCode: null,
      latencyMs: 0,
      errorType: 'connection_refused',
      errorDetail: 'Connection refused',
    };
  }
  return {
    status: 'fail',
    statusCode: null,
    latencyMs: 0,
    errorType: 'connection_error',
    errorDetail: code ? `Connection failed (${code})` : 'Connection failed',
  };
}

function httpFailure(statusCode: number): Pick<EndpointCheckResult, 'status' | 'errorType' | 'errorDetail'> {
  if (statusCode >= 500) {
    return { status: 'fail', errorType: 'http_5xx', errorDetail: `HTTP ${statusCode}` };
  }
  return { status: 'fail', errorType: 'http_4xx', errorDetail: `HTTP ${statusCode}` };
}

async function runHttpCheck(config: EndpointCheckConfig): Promise<EndpointCheckResult> {
  const timeoutMs = boundedTimeout(config.timeoutMs);
  const controller = new AbortController();
  const startedAt = performance.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(config.target, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'Nightlamp-Monitor/1.0' },
    });
    const responseLatencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const statusCode = response.status;

    if (statusCode >= 400) {
      return { ...httpFailure(statusCode), statusCode, latencyMs: responseLatencyMs };
    }

    if (config.type === 'keyword') {
      const body = await response.text();
      const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
      if (!body.includes(config.keyword || '')) {
        return {
          status: 'fail',
          statusCode,
          latencyMs,
          errorType: 'keyword_not_found',
          errorDetail: 'Expected keyword was not found in the response',
        };
      }
      return { status: 'pass', statusCode, latencyMs, errorType: null, errorDetail: null };
    }

    return { status: 'pass', statusCode, latencyMs: responseLatencyMs, errorType: null, errorDetail: null };
  } catch (error) {
    const classified = classifyNetworkError(error, timeoutMs);
    return {
      ...classified,
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseTcpTarget(target: string): { host: string; port: number } | null {
  if (target.startsWith('tcp://')) {
    try {
      const parsed = new URL(target);
      const port = Number(parsed.port);
      if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
      return { host: parsed.hostname, port };
    } catch {
      return null;
    }
  }

  const ipv6Match = target.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6Match) {
    const port = Number(ipv6Match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: ipv6Match[1], port };
  }

  const separator = target.lastIndexOf(':');
  if (separator <= 0) return null;
  const host = target.slice(0, separator);
  const port = Number(target.slice(separator + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

async function runTcpCheck(config: EndpointCheckConfig): Promise<EndpointCheckResult> {
  const timeoutMs = boundedTimeout(config.timeoutMs);
  const target = parseTcpTarget(config.target);
  const startedAt = performance.now();
  if (!target) {
    return {
      status: 'fail',
      statusCode: null,
      latencyMs: 0,
      errorType: 'connection_error',
      errorDetail: 'TCP target must use host:port format',
    };
  }

  return new Promise<EndpointCheckResult>((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: target.host, port: target.port });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        status: 'fail',
        statusCode: null,
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        errorType: 'timeout',
        errorDetail: `Request timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    const finish = (result: Omit<EndpointCheckResult, 'latencyMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    };

    socket.once('connect', () => {
      socket.end();
      finish({ status: 'pass', statusCode: null, errorType: null, errorDetail: null });
    });
    socket.once('error', (error) => {
      const classified = classifyNetworkError(error, timeoutMs);
      finish({
        status: classified.status,
        statusCode: classified.statusCode,
        errorType: classified.errorType,
        errorDetail: classified.errorDetail,
      });
    });
  });
}

export async function runEndpointCheck(config: EndpointCheckConfig): Promise<EndpointCheckResult> {
  if (config.type === 'tcp') return runTcpCheck(config);
  return runHttpCheck(config);
}
