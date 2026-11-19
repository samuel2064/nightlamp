const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
const clerkUserIdPattern = /user_[a-zA-Z0-9_]{20,}/gi;
const clerkOrgIdPattern = /org_[a-zA-Z0-9_]{20,}/gi;

const reportStr = '{"probes":[{"label":"test","expected":[200],"status":200,"code":null,"ok":true}],"identity":{"ownerId":"user_12345678901234567890","testTeamId":"123e4567-e89b-12d3-a456-426614174000"},"diagnostics":[],"valuesIncluded":false,"bodiesIncluded":false,"error":null,"probesPassed":1,"probesTotal":1}';

const identifierPatterns = [
  { pattern: uuidPattern, type: 'UUID' },
  { pattern: emailPattern, type: 'email' },
  { pattern: clerkUserIdPattern, type: 'Clerk user ID' },
  { pattern: clerkOrgIdPattern, type: 'Clerk org ID' },
];

for (const { pattern, type } of identifierPatterns) {
  const matches = reportStr.match(pattern);
  console.log(`Pattern: ${pattern}, Type: ${type}, Matches: ${matches}`);
}