const fs = require('fs');
const path = require('path');

function checkOwnershipClaimsInHarness(harnessPath) {
  const content = fs.readFileSync(harnessPath, 'utf8');
  
  const violations = [];
  
  const suspiciousPatterns = [
    { pattern: /ownerId\s*:\s*memberId\b/gi, desc: 'ownerId assigned memberId' },
    { pattern: /ownerId\s*:\s*memberEntry\.userId\b/gi, desc: 'ownerId assigned memberEntry.userId' },
    { pattern: /ownerId\s*:\s*userId\b/gi, desc: 'ownerId assigned userId (potential member)' },
    { pattern: /ownerId\s*:\s*memberToken\b/gi, desc: 'ownerId assigned memberToken' },
    { pattern: /"ownerId"\s*:\s*memberId\b/gi, desc: 'ownerId assigned memberId (quoted)' },
    { pattern: /'ownerId'\s*:\s*memberId\b/gi, desc: 'ownerId assigned memberId (single quoted)' },
    { pattern: /JSON\.stringify\(\s*\{\s*ownerId\s*:\s*member/gi, desc: 'ownerId with member in stringify' },
    { pattern: /body\s*:\s*JSON\.stringify\(\s*\{\s*ownerId\s*:\s*(?!ownerId|ownerEntry|controlledOwner)/gi, desc: 'ownerId with non-owner variable in stringify' },
    { pattern: /\{\s*ownerId\s*:\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*[,\}]/gi, desc: 'shorthand ownerId with variable in object literal' },
    { pattern: /JSON\.stringify\(\s*\{[^}]*\bownerId\b[^}]*\}/gi, desc: 'shorthand ownerId in JSON.stringify request body' },
  ];
  
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, desc } of suspiciousPatterns) {
      if (pattern.test(line)) {
        violations.push({
          file: harnessPath,
          line: i + 1,
          content: line.trim(),
          description: desc
        });
      }
    }
  }
  
  return violations;
}

function checkReportForIdentifiers(reportPath) {
  if (!fs.existsSync(reportPath)) {
    return [];
  }
  
  const content = fs.readFileSync(reportPath, 'utf8');
  let report;
  try {
    report = JSON.parse(content);
  } catch (error) {
    return [{ file: reportPath, error: 'Invalid JSON' }];
  }
  
  const violations = [];
  const reportStr = JSON.stringify(report);
  
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  const clerkUserIdPattern = /user_[a-zA-Z0-9_]{20,}/gi;
  const clerkOrgIdPattern = /org_[a-zA-Z0-9_]{20,}/gi;
  
  const identifierPatterns = [
    { pattern: uuidPattern, idType: 'UUID' },
    { pattern: emailPattern, idType: 'email' },
    { pattern: clerkUserIdPattern, idType: 'Clerk user ID' },
    { pattern: clerkOrgIdPattern, idType: 'Clerk org ID' },
  ];
  
  for (const { pattern, idType } of identifierPatterns) {
    const matches = reportStr.match(pattern);
    if (matches) {
      for (const match of matches) {
        violations.push({
          file: reportPath,
          type: idType,
          value: match
        });
      }
    }
  }
  
  return violations;
}

async function main() {
  const harnessPath = process.argv[2] || path.join(__dirname, 'verify-controlled-identities.js');
  const reportPath = process.argv[3] || process.env.RESULT_FILE || '/tmp/controlled-identity-result.json';
  const fixturePath = process.env.FIXTURE_FILE || path.join(__dirname, 'fixtures', 'stale-harness.js');
  
  let hasViolations = false;
  
  console.log('=== Checking harness for ownership claims ===');
  const ownershipViolations = checkOwnershipClaimsInHarness(harnessPath);
  if (ownershipViolations.length > 0) {
    console.log('FAIL: Ownership claims found in harness:');
    for (const v of ownershipViolations) {
      console.log(`  ${v.file}:${v.line} - ${v.description}: ${v.content}`);
    }
    hasViolations = true;
  } else {
    console.log('PASS: No ownership claims in harness');
  }
  
  console.log('\n=== Checking report for identifiers ===');
  const reportViolations = checkReportForIdentifiers(reportPath);
  if (reportViolations.length > 0) {
    console.log('FAIL: Identifiers found in report:');
    for (const v of reportViolations) {
      console.log(`  ${v.file} - ${v.type}: ${v.value}`);
    }
    hasViolations = true;
  } else {
    console.log('PASS: No identifiers in report');
  }
  
  console.log('\n=== Checking fixture for ownership claims (stale blob test) ===');
  if (!fs.existsSync(fixturePath)) {
    console.log('FAIL: Stale blob fixture not found at ' + fixturePath);
    hasViolations = true;
  } else {
    const fixtureViolations = checkOwnershipClaimsInHarness(fixturePath);
    if (fixtureViolations.length > 0) {
      console.log('PASS: Stale blob fixture correctly FAILS the guard (violations detected):');
      for (const v of fixtureViolations) {
        console.log(`  ${v.file}:${v.line} - ${v.description}: ${v.content}`);
      }
    } else {
      console.log('FAIL: Stale blob fixture should FAIL the guard but passed');
      hasViolations = true;
    }
  }
  
  if (hasViolations) {
    console.log('\n=== GUARD CHECKS FAILED ===');
    process.exit(1);
  } else {
    console.log('\n=== ALL GUARD CHECKS PASSED ===');
    process.exit(0);
  }
}

main().catch(error => {
  console.error('Guard check failed with error:', error);
  process.exit(1);
});