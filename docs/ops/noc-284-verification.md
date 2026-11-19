# NOC-284: NOC-280/NOC-274 Production Verification Runbook

## Overview

This runbook describes how to verify the NOC-280 (member privilege escalation prevention) and NOC-274 (remediation approval truthfulness) fixes against the production deployment.

## Prerequisites

### Required GitHub Secrets
| Secret | Purpose |
|--------|---------|
| `RENDER_API_KEY` | Render API token for service management |
| `RENDER_FRONTEND_SERVICE_ID` | Frontend service ID (e.g., `srv-xxx`) |
| `CLERK_API` | Clerk API base URL (default: `https://api.clerk.com/v1`) |
| `CLERK_INSTANCE` | Clerk instance identifier (e.g., `capable-goldfish-98.clerk.accounts.dev`) |
| `CLERK_ISSUER` | Clerk JWT issuer URL (e.g., `https://capable-goldfish-98.clerk.accounts.dev`) |
| `NIGHTLAMP_API` | Production API URL (default: `https://nightlamp-api.onrender.com`) |
| `VERIFICATION_EMAIL_DOMAIN` | Email domain for controlled test users (default: `example.com`) |
| `NO_TEAM_EXPECTED_STATUS` | Expected status for teamless users (default: `403`) |

### Required Production Environment Variables (Render Dashboard)
- `CLERK_SECRET_KEY` - Must be set on frontend service
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` - Must be set on frontend service

## Running the Verification

### Option 1: GitHub Actions (Recommended)

1. Navigate to **Actions** → **Verify controlled identities**
2. Click **Run workflow**
3. Select `main` branch
4. Click **Run workflow**

The workflow will:
1. Run guard checks (ownership claims and identifier redaction)
2. Execute the controlled identity verification against production
3. Run the NOC-280/NOC-274 privilege matrix
4. Publish a status-only report to the `ops/render-auth-report` branch

### Option 2: Local Execution (Requires Secrets)

```bash
export RENDER_API_KEY="your-render-api-key"
export RENDER_FRONTEND_SERVICE_ID="srv-xxx"
export CLERK_API="https://api.clerk.com/v1"
export CLERK_INSTANCE="your-instance.clerk.accounts.dev"
export CLERK_ISSUER="https://your-instance.clerk.accounts.dev"
export NIGHTLAMP_API="https://nightlamp-api.onrender.com"
export VERIFICATION_EMAIL_DOMAIN="example.com"
export NO_TEAM_EXPECTED_STATUS="403"
export RESULT_FILE="/tmp/controlled-identity-result.json"

cd ops
node verify-controlled-identities.js
```

## Verification Matrix

### NOC-280: Member Privilege Escalation Prevention

The following scenarios MUST return 403 for a member (non-admin/owner):

| Test | Endpoint | Expected |
|------|----------|----------|
| Self-promotion to owner | `PATCH /api/teams/:id/members/:memberId` | 403 |
| Self-promotion to admin | `PATCH /api/teams/:id/members/:memberId` | 403 |
| Member adds member | `POST /api/teams/:id/members` | 403 |
| Member removes self | `DELETE /api/teams/:id/members/:memberId` | 403 |
| Member rewrites team | `PATCH /api/teams/:id` | 403 |
| Member deletes team | `DELETE /api/teams/:id` | 403 |
| Member creates admin invitation | `POST /api/teams/:id/invitations` | 403 |
| Member accesses admin endpoint | `POST /api/remediation/approve` | 403 |
| Unknown team | `PATCH /api/teams/unknown/members/:id` | 404 |
| Non-member target | `PATCH /api/teams/:id/members/non-existent` | 404 |

### NOC-274: Remediation Approval Truthfulness

The following scenarios MUST return 404 for unknown runs:

| Test | Endpoint | Expected |
|------|----------|----------|
| Approve unknown run | `POST /api/remediation/approve` | 404 |
| Reject unknown run | `POST /api/remediation/reject` | 404 |
| Retry unknown run | `POST /api/remediation/retry` | 404 |
| Unknown action | `POST /api/remediation/approve` | 404 |

## Expected Results

### Success Criteria
- All NOC-280 tests return 403 (member blocked)
- All NOC-274 tests return 404 (unknown run rejected)
- Member role persists as `member` after test matrix
- No foreign rows exposed to any identity
- Contract mismatches = 0 (no 200 responses when 403 expected per NOC-294)

### Report Output

The verification produces a JSON report at `reports/controlled-identity-verification.json` with:

```json
{
  "probes": [...],
  "identity": {
    "frontendHasClerkSecret": true,
    "frontendHasPublishableKey": true,
    "existingUserCount": 5,
    "ownerIdentified": true,
    "memberIdentified": true,
    "testTeamCreated": true,
    "testTeamRemoved": true,
    "fullMatrixRun": true,
    "privilegeProbesRun": 20,
    "privilegeProbesPassed": 20,
    "noTeamExpectedStatus": 403,
    "contractMismatches": 0
  },
  "valuesIncluded": false,
  "bodiesIncluded": false
}
```

## Troubleshooting

### Matrix Blocked by NOC-294
If `matrixBlockedBy: "NOC-294: membership binding required for team creation"` appears:
- Team creation returned 403 for the controlled owner
- This is expected per NOC-294 decision (fail closed for users with no membership)
- Full privilege matrix cannot run until membership binding is fixed

### Contract Mismatches > 0
If `contractMismatches > 0`:
- Some probes returned 200 when NOC-294 decided contract requires 403
- This indicates the deployed build doesn't match the decided contract
- Fix forward and redeploy, do not roll back

### Frontend Clerk Variables Missing
If `CLERK_SECRET_KEY is not set on the frontend service`:
- Set the secret in Render dashboard → nightlamp-frontend → Environment
- Redeploy frontend

## Related Documentation

- [Controlled Identity Verification Workflow](../.github/workflows/verify-controlled-identities.yml)
- [Verification Script](../ops/verify-controlled-identities.js)
- [Guard Harness](../ops/guard-harness.js)
- [Deployment & Rollback](./deployment-and-rollback.md)