import { NpmPackageInfo } from '../../connectors/npm-registry';

export interface MockNpmRegistry {
  packages: Map<string, NpmPackageInfo>;
  get(packageName: string): NpmPackageInfo | null;
  set(packageName: string, info: NpmPackageInfo): void;
}

export function createMockNpmRegistry(): MockNpmRegistry {
  const packages = new Map<string, NpmPackageInfo>();

  const defaultPackages: [string, NpmPackageInfo][] = [
    ['express', {
      name: 'express',
      latestVersion: '4.18.2',
      versions: ['4.17.0', '4.17.1', '4.18.0', '4.18.1', '4.18.2'],
      description: 'Fast, unopinionated, minimalist web framework',
      repository: 'https://github.com/expressjs/express',
      homepage: 'http://expressjs.com/',
    }],
    ['axios', {
      name: 'axios',
      latestVersion: '1.6.2',
      versions: ['1.5.0', '1.5.1', '1.6.0', '1.6.1', '1.6.2'],
      description: 'Promise based HTTP client for the browser and node.js',
      repository: 'https://github.com/axios/axios',
      homepage: 'https://axios-http.com/',
    }],
    ['lodash', {
      name: 'lodash',
      latestVersion: '4.17.21',
      versions: ['4.17.20', '4.17.21'],
      description: 'Lodash modular utilities.',
      repository: 'https://github.com/lodash/lodash',
      homepage: 'https://lodash.com/',
    }],
    ['mocha', {
      name: 'mocha',
      latestVersion: '10.2.0',
      versions: ['10.0.0', '10.1.0', '10.2.0'],
      description: 'Simple, flexible, fun test framework',
      repository: 'https://github.com/mochajs/mocha',
      homepage: 'https://mochajs.org/',
    }],
    ['typescript', {
      name: 'typescript',
      latestVersion: '5.3.2',
      versions: ['5.0.0', '5.1.0', '5.2.0', '5.3.0', '5.3.1', '5.3.2'],
      description: 'TypeScript is a language for application scale JavaScript development',
      repository: 'https://github.com/microsoft/TypeScript',
      homepage: 'https://www.typescriptlang.org/',
    }],
  ];

  for (const [name, info] of defaultPackages) {
    packages.set(name, info);
  }

  return {
    packages,
    get(packageName: string) {
      return packages.get(packageName.toLowerCase()) ?? null;
    },
    set(packageName: string, info: NpmPackageInfo) {
      packages.set(packageName.toLowerCase(), info);
    },
  };
}

export const mockNpmRegistry = createMockNpmRegistry();

export async function mockPollNpmRegistry(packageName: string): Promise<import('../../connectors/npm-registry').NpmPackageInfo | null> {
  return mockNpmRegistry.get(packageName);
}

export function resetMockNpmRegistry(): void {
  const fresh = createMockNpmRegistry();
  mockNpmRegistry.packages.clear();
  for (const [key, value] of fresh.packages) {
    mockNpmRegistry.packages.set(key, value);
  }
}