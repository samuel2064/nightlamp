import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { clerkInstance, hash, normalize, replaceEnvVars } from '../../ops/render-auth-configure';

describe('render-auth-configure', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.RENDER_API = 'https://api.render.com/v1';
    process.env.RENDER_API_KEY = 'test-render-key';
    process.env.TARGET_BACKEND_ID = 'backend-123';
    process.env.TARGET_FRONTEND_ID = 'frontend-456';
    process.env.CLERK_ISSUER = 'https://capable-goldfish-98.clerk.accounts.dev';
    process.env.CLERK_INSTANCE = 'capable-goldfish-98.clerk.accounts.dev';
    process.env.CLERK_JWT_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6+uwb+X/QKQQp/8A0Sy3\nbYmwSAPHnynUH4TEbt3RP3tH8/h4868CiJVDDXeORwwSKz8kcfFfZPt5OtLuzPUn\nyzTeDv0Lud9loahWP+aY/pnRgyGWHuk575jnJA8bRJtg+EIyZakQNNOH0Brs09DQ\nQMHHiH9YTSDkGyT7yZmH32cGFs2qoAAwxyM6nLy7MdQpWcat+RrGwKB1W4wIjLAI\n5EUNqNEuZniGogPlMyV1Bz1oiJWXlYr91hJDDiCPPzHtuow4g4DGybHguGlQUStk\nhESQfyn316/DTggeR4rZfKxNAbwba7/W0JPmqmsfyd2cwQkUUljhv2vjLx96GgHl\n5QIDAQAB\n-----END PUBLIC KEY-----';
    process.env.GITHUB_CLERK_PUBLISHABLE_KEY = 'pk_test_capable-goldfish-98';
    process.env.CLERK_API = 'https://api.clerk.com/v1';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('clerkInstance', () => {
    it('returns empty string for null input', () => {
      expect(clerkInstance(null)).toBe('');
    });

    it('returns empty string for invalid format', () => {
      expect(clerkInstance('invalid')).toBe('');
    });

    it('extracts instance from valid publishable key format', () => {
      // The function expects a key with format like 'pk_test_<instance>_<rest>'
      // where instance is base64url encoded
      const key = 'pk_test_' + Buffer.from('capable-goldfish-98.clerk.accounts.dev').toString('base64url');
      const result = clerkInstance(key);
      expect(result).toBe('capable-goldfish-98.clerk.accounts.dev');
    });
  });

  describe('hash', () => {
    it('produces consistent 16-char hash', () => {
      const h1 = hash('test-value');
      const h2 = hash('test-value');
      expect(h1).toBe(h2);
      expect(h1.length).toBe(16);
    });

    it('produces different hashes for different values', () => {
      expect(hash('value1')).not.toBe(hash('value2'));
    });
  });

  describe('normalize', () => {
    it('extracts envVar from array of objects', () => {
      const input = [{ envVar: { key: 'KEY1', value: 'val1' } }, { envVar: { key: 'KEY2', value: 'val2' } }];
      const result = normalize(input);
      expect(result).toEqual([{ key: 'KEY1', value: 'val1' }, { key: 'KEY2', value: 'val2' }]);
    });

    it('handles plain objects', () => {
      const input = [{ key: 'KEY1', value: 'val1' }];
      const result = normalize(input);
      expect(result).toEqual([{ key: 'KEY1', value: 'val1' }]);
    });

    it('returns empty array for non-array', () => {
      expect(normalize(null)).toEqual([]);
      expect(normalize('string')).toEqual([]);
    });
  });

  describe('replaceEnvVars', () => {
    it('refuses when API does not return values', () => {
      const current = [{ key: 'KEY1', value: null }, { key: 'KEY2', value: 'val2' }];
      const additions = [{ key: 'NEW_KEY', value: 'new-val' }];
      const result = replaceEnvVars('service-1', current, additions);
      expect(result.ok).toBe(false);
      expect(result.refused).toBe(true);
    });
  });

  describe('workflow configuration', () => {
    it('has workflow_dispatch trigger only (no push trigger)', () => {
      const fs = require('fs');
      const workflow = fs.readFileSync('.github/workflows/configure-render-auth.yml', 'utf8');
      expect(workflow).toContain('workflow_dispatch:');
      expect(workflow).not.toContain('push:');
    });
  });
});