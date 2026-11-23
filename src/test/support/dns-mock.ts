import { HostResolver } from '../../engine/outbound-safety';

export function createMockHostResolver(): HostResolver {
  return async (host: string): Promise<string[]> => {
    const normalized = host.toLowerCase().trim();

    if (normalized === 'localhost' ||
        normalized === '127.0.0.1' ||
        normalized === '::1' ||
        normalized === 'metadata' ||
        normalized === 'metadata.google.internal' ||
        normalized === 'host.docker.internal' ||
        normalized.endsWith('.localhost')) {
      throw new Error('BLOCKED_HOSTNAME');
    }

    if (normalized.startsWith('10.') ||
        normalized.startsWith('192.168.') ||
        normalized.startsWith('172.16.') ||
        normalized.startsWith('169.254.') ||
        normalized.startsWith('100.64.')) {
      throw new Error('BLOCKED_ADDRESS');
    }

    return ['93.184.216.34'];
  };
}

export const mockHostResolver = createMockHostResolver();