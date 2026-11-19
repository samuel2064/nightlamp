const fs = require('fs');
const path = require('path');

function checkOwnershipClaimsInHarness() {
  const harnessPath = path.join(__dirname, 'verify-controlled-identities.js');
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
  ];
  
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, desc } of suspiciousPatterns) {
      if (pattern.test(line)) {
        violations.push({
          file: 'ops/verify-controlled-identities.js',
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
    { pattern: uuidPattern, type: 'UUID' },
    { pattern: emailPattern, type: 'email' },
    { pattern: clerkUserIdPattern, type: 'Clerk user ID' },
    { pattern: clerkOrgIdPattern, type: 'Clerk org ID' },
  ];
  
  for (const { pattern, type } of identifierPatterns) {
    const matches = reportStr.match(pattern);
    if (matches) {
      for (const match of matches) {
        violations.push({
          file: reportPath,
          type: type,
          value: match
        });
      }
    }
  }
  
  return violations;
}

async function main() {
  let hasViolations = false;
  
  console.log('=== Checking harness for ownership claims ===');
  const ownershipViolations = checkOwnershipClaimsInHarness();
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
  const reportPath = process.env.RESULT_FILE || '/tmp/controlled-identity-result.json';
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