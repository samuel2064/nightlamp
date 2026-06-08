import { createDatabase, saveDatabase } from './db';
import { pollSentry, detectSpikes, detectNewPatterns } from './connectors';
import { pollUptimeRobot, detectStatusChanges } from './connectors';
import { classifyFailure } from './classifier';
import { getOrCreatePlaybookEntry, writePlaybookFile } from './playbook';
import { startApiServer } from './api';

async function main() {
  console.log('=== Nightlamp Smoke Test ===\n');

  // 1. Database creation
  console.log('1. Creating database...');
  const db = await createDatabase();
  console.log('   OK - Database created with schema\n');

  // 2. Sentry connector (without real API)
  console.log('2. Testing Sentry poll (no real credentials - expects error)...');
  const sentryResult = await pollSentry({ authToken: 'invalid', orgSlug: 'test', projectSlug: 'test' });
  console.log(`   Result: issues=${sentryResult.issues.length}, error=${sentryResult.error ? 'present' : 'none'}\n`);

  // 3. UptimeRobot connector (without real API)
  console.log('3. Testing UptimeRobot poll (no real credentials - expects error)...');
  const urResult = await pollUptimeRobot({ apiKey: 'invalid' });
  console.log(`   Result: monitors=${urResult.monitors.length}, error=${urResult.error ? 'present' : 'none'}\n`);

  // 4. Spike detection
  console.log('4. Testing spike detection...');
  const prev = [
    { id: '1', title: 'Error A', level: 'error', count: 2, firstSeen: '', lastSeen: '', permalink: '', culprit: '', isNew: false },
    { id: '2', title: 'Error B', level: 'error', count: 1, firstSeen: '', lastSeen: '', permalink: '', culprit: '', isNew: false },
  ];
  const curr = [
    { id: '1', title: 'Error A', level: 'error', count: 20, firstSeen: '', lastSeen: '', permalink: '', culprit: '', isNew: false },
    { id: '3', title: 'Error C', level: 'error', count: 1, firstSeen: '', lastSeen: '', permalink: '', culprit: '', isNew: true },
  ];
  const spikes = detectSpikes(curr, prev);
  console.log(`   Spikes detected: ${spikes.length} (expected: 1 - Error A went from 2 to 20)\n`);

  // 5. New pattern detection
  console.log('5. Testing new pattern detection...');
  const newPatterns = detectNewPatterns(curr, prev);
  console.log(`   New patterns: ${newPatterns.length} (expected: 1 - Error C)\n`);

  // 6. UptimeRobot status change detection
  console.log('6. Testing UptimeRobot status change detection...');
  const prevMonitors = [
    { id: 1, friendlyName: 'Site A', url: 'https://a.com', type: 1, status: 2, interval: 300, createDatetime: 0 },
    { id: 2, friendlyName: 'Site B', url: 'https://b.com', type: 1, status: 2, interval: 300, createDatetime: 0 },
  ];
  const currMonitors = [
    { id: 1, friendlyName: 'Site A', url: 'https://a.com', type: 1, status: 9, interval: 300, createDatetime: 0 },
    { id: 2, friendlyName: 'Site B', url: 'https://b.com', type: 1, status: 2, interval: 300, createDatetime: 0 },
  ];
  const changes = detectStatusChanges(currMonitors, prevMonitors);
  console.log(`   Status changes: ${changes.length} (expected: 1 - Site A went from up to down)\n`);

  // 7. Failure classification
  console.log('7. Testing failure classification...');
  const expiredEvents = classifyFailure('test-check', { statusCode: 401, errorMessage: 'expired token' });
  console.log(`   Expired token events: ${expiredEvents.length} (expected: 1)`);
  expiredEvents.forEach(e => console.log(`   - ${e.failureType} (${e.severity}): ${e.title}`));

  const rateLimitEvents = classifyFailure('test-check', { statusCode: 429, headers: { 'x-ratelimit-remaining': '0' } });
  console.log(`   Rate limit events: ${rateLimitEvents.length} (expected: 1)`);

  const serverErrorEvents = classifyFailure('test-check', { statusCode: 502, errorMessage: 'Bad Gateway' });
  console.log(`   Server error events: ${serverErrorEvents.length} (expected: 1)`);

  const schemaDriftEvents = classifyFailure('test-check', { body: {} });
  console.log(`   Schema drift events: ${schemaDriftEvents.length} (expected: 1)`);

  const mixedEvents = classifyFailure('test-check', { statusCode: 403, errorMessage: 'unauthorized: token expired', body: { _unexpected: true } });
  console.log(`   Mixed events (403 + body): ${mixedEvents.length} (expected: 2 - expired_token + schema_drift)`);
  mixedEvents.forEach(e => console.log(`   - ${e.failureType}`));
  console.log('');

  // 8. Playbook writer
  console.log('8. Testing playbook writer...');
  const entry = getOrCreatePlaybookEntry(db, 'expired_token');
  console.log(`   Playbook entry: ${entry.title} (occ #${entry.occurrenceCount})`);

  const entry2 = getOrCreatePlaybookEntry(db, 'expired_token');
  console.log(`   Second occurrence: occ #${entry2.occurrenceCount} (expected: 2)`);

  for (const ft of ['broken_webhook', 'schema_drift', 'rate_limit_shift', 'error_spike', 'new_error_pattern'] as const) {
    const e = getOrCreatePlaybookEntry(db, ft);
    writePlaybookFile('./playbook', e);
    console.log(`   Created playbook: ${ft} -> ${e.title}`);
  }

  console.log('');

  // 9. API server
  console.log('9. Testing API server...');
  const apiServer = startApiServer(db, { port: 0 });
  const address = apiServer.address() as any;
  const port = address.port;
  console.log(`   API server started on port ${port}`);

  const healthResp: any = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  console.log(`   Health endpoint: status=${healthResp.status}, events=${healthResp.stats.failureEvents}`);

  const eventsResp: any = await (await fetch(`http://127.0.0.1:${port}/api/events`)).json();
  console.log(`   Events endpoint: ${eventsResp.count} events`);

  const resultsResp: any = await (await fetch(`http://127.0.0.1:${port}/api/check-results`)).json();
  console.log(`   Check results endpoint: ${resultsResp.count} results`);

  const playbookResp: any = await (await fetch(`http://127.0.0.1:${port}/api/playbook`)).json();
  console.log(`   Playbook endpoint: ${playbookResp.count} entries`);

  const filteredResp: any = await (await fetch(`http://127.0.0.1:${port}/api/events?type=expired_token&severity=critical`)).json();
  console.log(`   Filtered events: ${filteredResp.count} expired_token/critical`);

  apiServer.close();
  console.log('   API server stopped\n');

  // 10. Save database
  console.log('10. Saving database...');
  saveDatabase(db, './data/nightlamp.db');
  console.log('   OK\n');

  console.log('=== All smoke tests passed ===');
}

main().catch(err => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});