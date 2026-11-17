import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { URL } from 'url';
import {
  BlockedTargetError,
  HostResolver,
  TargetPolicy,
  TargetResolutionError,
  defaultHostResolver,
  defaultTargetPolicy,
  resolvePublicTarget,
} from './outbound-safety';

export type EndpointCheckType = 'http' | 'tcp' | 'keyword';

export type EndpointCheckFailureType =
  | 'timeout'
  | 'dns_failure'
  | 'connection_refused'
  | 'http_4xx'
  | 'http_5xx'
  | 'keyword_not_found'
  | 'connection_error'
  | 'blocked_target'
  | 'response_too_large';

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

export interface HttpTransportRequest {
  url: string;
  addresses: string[];
  timeoutMs: number;
  maxBodyBytes: number;
  readBody: boolean;
}

export interface HttpTransportResponse {
  statusCode: number;
  body: Buffer | null;
  bodyTruncated: boolean;
}

export type HttpTransport = (request: HttpTransportRequest) => Promise<HttpTransportResponse>;

export interface TcpTransportRequest {
  host: string;
  addresses: string[];
  port: number;
  timeoutMs: number;
}

export type TcpTransport = (request: TcpTransportRequest) => Promise<void>;

export interface EndpointCheckDeps {
  resolver?: HostResolver;
  policy?: TargetPolicy;
  httpTransport?: HttpTransport;
  tcpTransport?: TcpTransport;
}

export const MAX_KEYWORD_BODY_BYTES = 64 * 1024;

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
  if (
    name === 'AbortError' ||
    code === 'ABORT_ERR' ||
    code === 'UND_ERR_ABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return {
      status: 'fail',
      statusCode: null,
      latencyMs: 0,
      errorType: 'timeout',
      errorDetail: `Request timed out after ${timeoutMs}ms`,
    };
  }
  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EAI_FAIL' ||
    code === 'EAI_NODATA' ||
    code === 'ENODATA' ||
    code === 'EAI_NONAME'
  ) {
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

function pinnedLookup(addresses: string[]): net.LookupFunction {
  return ((hostname: string, options: any, callback: any) => {
    const entries = addresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
    if (options && options.all) {
      callback(null, entries);
      return;
    }
    callback(null, entries[0].address, entries[0].family);
  }) as net.LookupFunction;
}

function defaultHttpTransport(request: HttpTransportRequest): Promise<HttpTransportResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      reject(Object.assign(new Error('Invalid target URL'), { code: 'ERR_INVALID_URL' }));
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };

    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          'User-Agent': 'Nightlamp-Monitor/1.0',
          Accept: '*/*',
          Connection: 'close',
        },
        lookup: pinnedLookup(request.addresses),
      },
      (res) => {
        const statusCode = res.statusCode || 0;

        if (!request.readBody) {
          res.destroy();
          finish(() => resolve({ statusCode, body: null, bodyTruncated: false }));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;

        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > request.maxBodyBytes) {
            res.destroy();
            req.destroy();
            finish(() => resolve({ statusCode, body: Buffer.concat(chunks), bodyTruncated: true }));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          finish(() => resolve({ statusCode, body: Buffer.concat(chunks), bodyTruncated: false }));
        });

        res.on('aborted', () => {
          finish(() => reject(Object.assign(new Error('Response aborted'), { code: 'ECONNRESET' })));
        });

        res.on('error', (err: any) => {
          finish(() => reject(err));
        });
      },
    );

    const deadline = setTimeout(() => {
      req.destroy(Object.assign(new Error('Request deadline exceeded'), { code: 'ETIMEDOUT' }));
      finish(() => reject(Object.assign(new Error('Request deadline exceeded'), { code: 'ETIMEDOUT' })));
    }, request.timeoutMs);

    req.on('error', (err: any) => {
      finish(() => reject(err));
    });

    req.end();
  });
}

function defaultTcpTransport(request: TcpTransportRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection({
      host: request.addresses[0],
      port: request.port,
      lookup: pinnedLookup(request.addresses),
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      socket.destroy();
      finish(() => reject(Object.assign(new Error('Request deadline exceeded'), { code: 'ETIMEDOUT' })));
    }, request.timeoutMs);

    socket.once('connect', () => {
      socket.end();
      finish(() => resolve());
    });

    socket.once('error', (err: any) => {
      finish(() => reject(err));
    });
  });
}

function parseHttpTarget(target: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw Object.assign(new Error('Target must be a valid URL'), { code: 'ERR_INVALID_URL' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error('Target must use http or https'), { code: 'ERR_INVALID_URL' });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error('Target must not contain embedded credentials'), { code: 'ERR_INVALID_URL' });
  }
  return parsed;
}

export function parseTcpTarget(target: string): { host: string; port: number } | null {
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

export async function runEndpointCheck(
  config: EndpointCheckConfig,
  deps: EndpointCheckDeps = {},
): Promise<EndpointCheckResult> {
  const timeoutMs = boundedTimeout(config.timeoutMs);
  const startedAt = performance.now();
  const resolver = deps.resolver || defaultHostResolver;
  const policy = deps.policy || defaultTargetPolicy;

  try {
    if (config.type === 'tcp') {
      const target = parseTcpTarget(config.target);
      if (!target) {
        return {
          status: 'fail',
          statusCode: null,
          latencyMs: 0,
          errorType: 'connection_error',
          errorDetail: 'TCP target must use host:port format',
        };
      }

      const resolved = await resolvePublicTarget(target.host, resolver, policy);
      const transport = deps.tcpTransport || defaultTcpTransport;
      await transport({
        host: resolved.host,
        addresses: resolved.addresses,
        port: target.port,
        timeoutMs,
      });

      return {
        status: 'pass',
        statusCode: null,
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        errorType: null,
        errorDetail: null,
      };
    }

    const parsed = parseHttpTarget(config.target);
    const resolved = await resolvePublicTarget(parsed.hostname, resolver, policy);
    const transport = deps.httpTransport || defaultHttpTransport;
    const response = await transport({
      url: config.target,
      addresses: resolved.addresses,
      timeoutMs,
      maxBodyBytes: MAX_KEYWORD_BODY_BYTES,
      readBody: config.type === 'keyword',
    });

    const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const statusCode = response.statusCode;

    if (statusCode >= 400) {
      return { ...httpFailure(statusCode), statusCode, latencyMs };
    }

    if (config.type === 'keyword') {
      if (response.bodyTruncated) {
        return {
          status: 'fail',
          statusCode,
          latencyMs,
          errorType: 'response_too_large',
          errorDetail: `Response body exceeded the ${MAX_KEYWORD_BODY_BYTES} byte limit`,
        };
      }
      const body = response.body ? response.body.toString('utf8') : '';
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

    return { status: 'pass', statusCode, latencyMs, errorType: null, errorDetail: null };
  } catch (error) {
    if (error instanceof BlockedTargetError) {
      return {
        status: 'fail',
        statusCode: null,
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        errorType: 'blocked_target',
        errorDetail: error.message,
      };
    }
    if (error instanceof TargetResolutionError) {
      return {
        status: 'fail',
        statusCode: null,
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
        errorType: 'dns_failure',
        errorDetail: error.message,
      };
    }
    const classified = classifyNetworkError(error, timeoutMs);
    return {
      ...classified,
      latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  }
}

export async function assertTargetAllowed(
  target: string,
  checkType: EndpointCheckType,
  deps: EndpointCheckDeps = {},
): Promise<void> {
  const resolver = deps.resolver || defaultHostResolver;
  const policy = deps.policy || defaultTargetPolicy;

  if (checkType === 'tcp') {
    const parsed = parseTcpTarget(target);
    if (!parsed) {
      throw new BlockedTargetError('TCP target must use host:port format');
    }
    await resolvePublicTarget(parsed.host, resolver, policy);
    return;
  }

  const parsed = parseHttpTarget(target);
  await resolvePublicTarget(parsed.hostname, resolver, policy);
}
