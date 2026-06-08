import { createDatabase } from '../db/schema';
import { detectSpikes, detectNewPatterns } from '../connectors/sentry';
import { detectStatusChanges } from '../connectors/uptimerobot';

import assert from 'assert';

describe('Sentry Connector', () => {
  it('detectSpikes should find issues with count increased 5x', () => {
    const prev = [
      { id: '1', title: 'Error A', level: 'error', count: 2, firstSeen: '', lastSeen: '', permalink: '', culprit: '', isNew: false },
      { id: '2', title: 'Error B', level: 'error', count: 10, firstSeen: '', lastSeen: '', permalink: '', culprit: '', isNew: false },
    ];
    const curr = [
      { id: '1', title: 'Error A', level: 'error', count: 20, firstSeen: '', lastSeen: '', permalink: '', culprit: '', isNew: false },
      { id: '2', title: 'Error B', level: 'error', count: 10, firstSeen: '', lastSeen: '', permalink: '', culprit: '', isNew: false },
    ];
    const spikes = detectSpikes(curr, prev);
    assert.strictEqual(spikes.length, 1);
    assert.strictEqual(spikes[0].id, '1');
  });

  it('detectSpikes should return empty when no spikes', () => {
    const prev = [
      { id: '1', title: 'Error A', level: 'error', count: 5, firstSeen: '', lastSeen: '', permalink: '', culprit: '', isNew: false },
    ];
    const curr = [
      { id: '1', title: 'Error A', level: 'error', count: 6, firstSeen: '', lastSeen: '', permalink: '', culprit: '', isNew: false },
    ];
    assert.strictEqual(detectSpikes(curr, prev).length, 0);
  });

  it('detectNewPatterns should find issues not in previous poll', () => {
    const prev = [
      { id: '1', title: 'Error A', level: 'error', count: 1, firstSeen: '', lastSeen: '', permalink: '', culprit: '', isNew: true },
    ];
    const curr = [
      { id: '1', title: 'Error A', level: 'error', count: 5, firstSeen: '', lastSeen: '', permalink: '', culprit: '', isNew: false },
      { id: '2', title: 'Error B', level: 'error', count: 1, firstSeen: '', lastSeen: '', permalink: '', culprit: '', isNew: true },
    ];
    const newPatterns = detectNewPatterns(curr, prev);
    assert.strictEqual(newPatterns.length, 1);
    assert.strictEqual(newPatterns[0].id, '2');
  });
});

describe('UptimeRobot Connector', () => {
  it('detectStatusChanges should find monitors that changed status', () => {
    const prev = [
      { id: 1, friendlyName: 'Site A', url: 'https://a.com', type: 1, status: 2, interval: 300, createDatetime: 0 },
      { id: 2, friendlyName: 'Site B', url: 'https://b.com', type: 1, status: 9, interval: 300, createDatetime: 0 },
    ];
    const curr = [
      { id: 1, friendlyName: 'Site A', url: 'https://a.com', type: 1, status: 9, interval: 300, createDatetime: 0 },
      { id: 2, friendlyName: 'Site B', url: 'https://b.com', type: 1, status: 2, interval: 300, createDatetime: 0 },
    ];
    const changes = detectStatusChanges(curr, prev);
    assert.strictEqual(changes.length, 2);
    assert.strictEqual(changes[0].status, 'down');
    assert.strictEqual(changes[0].previousStatus, 'up');
  });

  it('detectStatusChanges should return empty when no changes', () => {
    const monitors = [
      { id: 1, friendlyName: 'Site A', url: 'https://a.com', type: 1, status: 2, interval: 300, createDatetime: 0 },
    ];
    assert.strictEqual(detectStatusChanges(monitors, monitors).length, 0);
  });
});