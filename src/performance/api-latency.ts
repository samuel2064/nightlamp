/**
 * Lightweight API latency instrumentation and in-memory hot-path cache.
 *
 * - `ApiLatencyTracker` records per-path request timings and exposes p50/p95/p99
 *   per path plus a global summary. Used to satisfy the NOC-164 SLO "API p95
 *   latency < 500ms" and feed the self-monitoring dashboards.
 * - `HotPathCache` is a tiny TTL cache for expensive, frequently-read endpoints
 *   (monitor list, playbook list, health stats). SQLite reads are fast but the
 *   same query returning hundreds of rows repeatedly is the hot path to cache.
 */

export interface TimingStat {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  avg: number;
}

export class ApiLatencyTracker {
  private samples: Map<string, number[]> = new Map();
  private readonly cap: number;

  constructor(cap = 5000) {
    this.cap = cap;
  }

  /** Record a request duration (ms) keyed by path. */
  record(path: string, durationMs: number): void {
    const key = path || '/';
    const list = this.samples.get(key) || [];
    list.push(durationMs);
    // Bound memory: keep the most recent samples only.
    if (list.length > this.cap) list.splice(0, list.length - this.cap);
    this.samples.set(key, list);
  }

  private percentile(sorted: number[], q: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[idx];
  }

  private stat(list: number[]): TimingStat {
    if (list.length === 0) {
      return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, avg: 0 };
    }
    const sorted = [...list].sort((a, b) => a - b);
    const sum = list.reduce((acc, n) => acc + n, 0);
    return {
      count: list.length,
      p50: this.percentile(sorted, 0.5),
      p95: this.percentile(sorted, 0.95),
      p99: this.percentile(sorted, 0.99),
      max: sorted[sorted.length - 1],
      avg: Math.round((sum / list.length) * 100) / 100,
    };
  }

  /** Per-path summary for the given cut (pass path or omit for all). */
  summary(path?: string): { global: TimingStat; perPath: Record<string, TimingStat> } {
    const perPath: Record<string, TimingStat> = {};
    const all: number[] = [];
    for (const [key, list] of this.samples) {
      perPath[key] = this.stat(list);
      all.push(...list);
    }
    return { global: this.stat(all), perPath };
  }

  /** True if the global p95 exceeds the provided SLO threshold. */
  breachP95(thresholdMs: number): boolean {
    return this.summary().global.p95 > thresholdMs;
  }

  reset(): void {
    this.samples.clear();
  }
}

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class ApiCache {
  private readonly store: Map<string, CacheEntry<unknown>> = new Map();

  constructor(private defaultTtlMs = 15_000) {}

  set<T>(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs) });
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Reusable key builder for cache entries so callers never collide on prefixes.
 */
export function cacheKey(prefix: string, ...parts: Array<string | number | undefined>): string {
  return [prefix, ...parts.filter((p) => p !== undefined && p !== null)].join(':');
}