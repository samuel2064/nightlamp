// STALE FIXTURE: This harness blob (5081563) contains ownership claims that should FAIL the guard.
// The guard must detect: ownerId assigned memberId, ownerId assigned memberEntry.userId, etc.
// This fixture simulates the stale harness that was deployed before the guard was implemented.
// Expected guard result: FAIL (violations detected)

// STALE OWNERSHIP CLAIM VIOLATIONS (these should be detected by guard):
// 1. ownerId assigned memberId
const staleOwnerIdAssignment1 = { ownerId: memberId };

// 2. ownerId assigned memberEntry.userId
const staleOwnerIdAssignment2 = { ownerId: memberEntry.userId };

// 3. ownerId assigned userId (potential member)
const staleOwnerIdAssignment3 = { ownerId: userId };

// 4. ownerId assigned memberToken
const staleOwnerIdAssignment4 = { ownerId: memberToken };

// 5. shorthand ownerId in JSON.stringify request body
const staleRequestBody = JSON.stringify({ ownerId: memberId });

// 6. ownerId with non-owner variable in stringify
const staleRequestBody2 = { body: JSON.stringify({ ownerId: memberEntry.userId }) };

// 7. shorthand ownerId with variable in object literal
const staleObjectLiteral = { ownerId: memberId };

// Minimal valid module exports for syntax validation
module.exports = {
  staleOwnerIdAssignment1,
  staleOwnerIdAssignment2,
  staleOwnerIdAssignment3,
  staleOwnerIdAssignment4,
  staleRequestBody,
  staleRequestBody2,
  staleObjectLiteral
};