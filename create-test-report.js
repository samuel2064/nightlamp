const fs = require('fs');
const report = {
  probes: [{ label: 'test', expected: [200], status: 200, code: null, ok: true }],
  identity: { ownerId: 'user_12345678901234567890', testTeamId: '123e4567-e89b-12d3-a456-426614174000' },
  diagnostics: [],
  valuesIncluded: false,
  bodiesIncluded: false,
  error: null,
  probesPassed: 1,
  probesTotal: 1
};
fs.writeFileSync('/tmp/test-report3.json', JSON.stringify(report), 'utf8');
console.log('File created');