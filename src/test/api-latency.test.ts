import assert from 'assert';
import { ApiLatencyTracker, ApiCache, cacheKey } from '../performance/api-latency';

describe('API Latency Tracker', function () {
  let tracker: ApiLatencyTracker;
  beforeEach(function () {
    tracker = new ApiLatencyTracker();
  });

  it('records a request and reports p50/p95/p99', function () {
    tracker.record('/api/monitors', 100);
    tracker.record('/api/monitors', 200);
    tracker.record('/api/monitors', 500);
    tracker.record('/api/monitors', 1000);
    const stat = tracker.summary('/api/monitors').global;
    assert.strictEqual(stat.count, 4);
    assert.ok(stat.p50 > 0);
    assert.ok(stat.p95 >= stat.p50);
    assert.ok(stat.p99 >= stat.p95);
    assert.strictEqual(stat.max, 1000);
  });

  it('aggregates per-path and global', function () {
    tracker.record('/api/a', 10);
    tracker.record('/api/b', 90);
    const s = tracker.summary();
    assert.strictEqual(s.global.count, 2);
    assert.ok(s.perPath['/api/a']);
    assert.ok(s.perPath['/api/b']);
  });

  it('detects p95 breach above threshold', function () {
    for (let i = 0; i < 100; i++) tracker.record('/api/x', 600);
    assert.strictEqual(tracker.breachP95(500), true);
  });

  it('does not breach when under threshold', function () {
    for (let i = 0; i < 100; i++) tracker.record('/api/x', 50);
    assert.strictEqual(tracker.breachP95(500), false);
  });

  it('caps memory by keeping only the most recent samples', function () {
    const small = new ApiLatencyTracker(10);
    for (let i = 0; i < 100; i++) small.record('/api', i);
    const stat = small.summary();
    assert.ok(stat.global.count <= 10);
  });

  it('reset clears all samples', function () {
    tracker.record('/api', 1);
    tracker.reset();
    assert.strictEqual(tracker.summary().global.count, 0);
  });
});

describe('Hot-path Cache', function () {
  let cache: ApiCache;
  beforeEach(function () {
    cache = new ApiCache(50);
  });

  it('stores and retrieves a value', function () {
    cache.set('monitors', { list: [1, 2, 3] });
    assert.deepStrictEqual(cache.get('monitors'), { list: [1, 2, 3] });
  });

  it('returns null for a missing key', function () {
    assert.strictEqual(cache.get('missing'), null);
  });

  it('expires entries after TTL', function (done) {
    cache.set('k', 'v', 20);
    setTimeout(function () {
      assert.strictEqual(cache.get('k'), null);
      done();
    }, 60);
  });

  it('supports delete, has, clear, size', function () {
    cache.set('a', 1);
    cache.set('b', 2);
    assert.strictEqual(cache.size, 2);
    assert.strictEqual(cache.has('a'), true);
    cache.delete('a');
    assert.strictEqual(cache.has('a'), false);
    cache.clear();
    assert.strictEqual(cache.size, 0);
  });

  it('extracts an existing live entry before expiry', function () {
    cache.set('hot', 'value', 30);
    assert.strictEqual(cache.get('hot'), 'value');
  });
});

describe('cacheKey', function () {
  it('builds deterministic keys and omits undefined parts', function () {
    assert.strictEqual(cacheKey('m', 'a', 1), 'm:a:1');
    assert.strictEqual(cacheKey('m', 'a', undefined), 'm:a');
  });
});