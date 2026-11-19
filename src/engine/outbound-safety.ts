import * as dns from 'dns';
import * as net from 'net';

export type HostResolver = (host: string) => Promise<string[]>;

export class BlockedTargetError extends Error {
  readonly code = 'BLOCKED_TARGET';

  constructor(message: string) {
    super(message);
    this.name = 'BlockedTargetError';
  }
}

export class TargetResolutionError extends Error {
  readonly code = 'DNS_FAILURE';

  constructor(message: string) {
    super(message);
    this.name = 'TargetResolutionError';
  }
}

const BLOCKED_IPV4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'host.docker.internal',
  'host.containers.internal',
]);

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inRange(address: string, base: string, prefix: number): boolean {
  const target = ipv4ToNumber(address);
  const start = ipv4ToNumber(base);
  if (target === null || start === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((target & mask) >>> 0) === ((start & mask) >>> 0);
}

export function isBlockedIpv4(address: string): boolean {
  return BLOCKED_IPV4_RANGES.some(([base, prefix]) => inRange(address, base, prefix));
}

export function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('ff')) return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    return net.isIPv4(mapped) ? isBlockedIpv4(mapped) : true;
  }
  if (normalized.startsWith('64:ff9b::')) return true;
  if (normalized.startsWith('2001:db8')) return true;
  if (normalized.startsWith('100:')) return true;
  return false;
}

export function isBlockedAddress(address: string): boolean {
  const trimmed = address.trim().replace(/^\[|\]$/g, '');
  if (net.isIPv4(trimmed)) return isBlockedIpv4(trimmed);
  if (net.isIPv6(trimmed)) return isBlockedIpv6(trimmed);
  return true;
}

export function isBlockedHostname(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized) return true;
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  if (normalized.endsWith('.localhost')) return true;
  return false;
}

export const defaultHostResolver: HostResolver = async (host: string): Promise<string[]> => {
  const results = await dns.promises.lookup(host, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
};

export interface TargetPolicy {
  isBlockedAddress(address: string): boolean;
  isBlockedHostname(host: string): boolean;
}

export const defaultTargetPolicy: TargetPolicy = {
  isBlockedAddress,
  isBlockedHostname,
};

export interface PublicTarget {
  host: string;
  addresses: string[];
}

export async function resolvePublicTarget(
  host: string,
  resolver: HostResolver = defaultHostResolver,
  policy: TargetPolicy = defaultTargetPolicy,
): Promise<PublicTarget> {
  const normalized = host.trim().replace(/^\[|\]$/g, '');
  if (!normalized) {
    throw new BlockedTargetError('Target host is required');
  }
  if (policy.isBlockedHostname(normalized)) {
    throw new BlockedTargetError(`Target host "${normalized}" is not an allowed public destination`);
  }

  if (net.isIP(normalized)) {
    if (policy.isBlockedAddress(normalized)) {
      throw new BlockedTargetError(`Target address "${normalized}" is not a public destination`);
    }
    return { host: normalized, addresses: [normalized] };
  }

  let addresses: string[];
  try {
    addresses = await resolver(normalized);
  } catch (err: any) {
    throw new TargetResolutionError(
      `DNS lookup failed${err?.code ? ` (${err.code})` : ''}`,
    );
  }

  const usable = addresses.map((address) => address.trim()).filter(Boolean);
  if (usable.length === 0) {
    throw new TargetResolutionError('DNS lookup returned no addresses');
  }

  const blocked = usable.find((address) => policy.isBlockedAddress(address));
  if (blocked) {
    throw new BlockedTargetError(
      `Target host "${normalized}" resolves to a non-public address (${blocked})`,
    );
  }

  return { host: normalized, addresses: usable };
}
