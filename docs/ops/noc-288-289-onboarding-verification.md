# NOC-288 & NOC-289: Onboarding Path Integration & Verification Runbook

**Owner:** Platform Engineer  
**Status:** Draft  
**Related:** [Deployment & Rollback](./deployment-and-rollback.md), [NOC-284 Verification](./noc-284-verification.md)

---

## Overview

This runbook describes how to verify the complete onboarding path is integrated, deployed, and functional in production. Covers both NOC-288 (integration/deployment) and NOC-289 (fresh-customer acceptance journey).

## Prerequisites

### Required GitHub Secrets
| Secret | Purpose |
|--------|---------|
| `RENDER_API_KEY` | Render API token |
| `RENDER_BACKEND_SERVICE_ID` | Backend service ID (e.g., `srv-xxx`) |
| `RENDER_FRONTEND_SERVICE_ID` | Frontend service ID |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key for frontend |
| `CLERK_SECRET_KEY` | Clerk secret key for frontend |
| `CLERK_API` | Clerk API base URL (default: `https://api.clerk.com/v1`) |
| `CLERK_INSTANCE` | Clerk instance identifier |
| `CLERK_ISSUER` | Clerk JWT issuer URL |
| `NIGHTLAMP_API` | Production API URL (default: `https://nightlamp-api.onrender.com`) |
| `NIGHTLAMP_FRONTEND` | Production frontend URL (default: `https://nightlamp-frontend.onrender.com`) |

### Required Production Environment Variables (Render Dashboard)
**Backend Service:**
- `CLERK_SECRET_KEY` - For Clerk webhook verification
- `CLERK_JWT_ISSUER` - Clerk JWT issuer
- `CLERK_JWT_PUBLIC_KEY` - Clerk public key (optional, JWKS preferred)
- `STRIPE_SECRET_KEY` - For billing
- `STRIPE_WEBHOOK_SECRET` - For Stripe webhooks
- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG_SLUG`, `SENTRY_PROJECT_SLUG` - For Sentry integration
- `UPTIMEROBOT_API_KEY` - For UptimeRobot integration
- `BASE_URL` - Production backend URL

**Frontend Service:**
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` - Clerk publishable key
- `CLERK_SECRET_KEY` - Clerk secret key
- `NEXT_PUBLIC_BACKEND_URL` - Production backend URL
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`
- `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL`

---

## Current Implementation Status

### ✅ Backend (Complete)
- **File**: `src/teams/onboarding-api.ts`
- **Endpoints**:
  - `POST /api/onboarding/start` - Create/resume session
  - `GET /api/onboarding/:id/status` - Get session status
  - `POST /api/onboarding/:id/step` - Advance step
  - `POST /api/onboarding/:id/complete` - Complete & create team
- **Steps**: `app-detection` → `monitor-selection` → `alert-config` → `team-invite`
- **Database**: `onboarding_sessions` table with tenant isolation (`team_id` column)
- **Tests**: `src/test/onboarding.test.ts` (16 tests passing)

### ✅ Frontend (Complete)
- **File**: `frontend/src/app/onboarding/page.tsx`
- **Components**: Step-by-step wizard with 4 steps
- **tRPC Integration**: `frontend/src/server/routers/onboarding.ts`
- **Auth**: Uses Clerk `useUser()` hook, redirects to sign-in if unauthenticated
- **State Management**: React state + tRPC mutations/queries

### ✅ tRPC Router (Complete)
- **File**: `frontend/src/server/index.ts` - includes `onboardingRouter`
- **Procedures**: `start`, `status`, `step`, `complete` (all protected)

### ✅ Database Schema (Complete)
- **Migration**: `008-tenant-isolation.ts` adds `team_id` to `onboarding_sessions`
- **Index**: `idx_onboarding_sessions_team` created

---

## Verification Plan

### Phase 1: Pre-deployment Checks (Local/CI)

#### 1.1 Run Full Test Suite
```bash
npm test
npx tsc --noEmit
cd frontend && npm run lint && npm run build
```

#### 1.2 Contract Test (Frontend ↔ Backend)
```bash
# Verify frontend calls match backend endpoints
npx mocha --require ts-node/register "src/test/frontend-contract.test.ts"
```

#### 1.3 Onboarding Unit Tests
```bash
npx mocha --require ts-node/register "src/test/onboarding.test.ts"
```

### Phase 2: Staging Deployment Verification

#### 2.1 Deploy to Staging
```bash
# Trigger staging deploy via GitHub Actions or manual
gh workflow run deploy.yml -f branch=staging
# OR
gh workflow run deploy.yml -f environment=staging
```

#### 2.2 Staging Smoke Tests
```bash
# Backend health
curl -s https://nightlamp-api-staging.onrender.com/api/health | jq '.status'

# Onboarding endpoints accessible (should return 401 without auth)
curl -s -o /dev/null -w "%{http_code}" https://nightlamp-api-staging.onrender.com/api/onboarding/start
# Expected: 401

# Frontend onboarding page loads
curl -s -o /dev/null -w "%{http_code}" https://nightlamp-frontend-staging.onrender.com/onboarding
# Expected: 200 (redirects to sign-in) or 307/308
```

#### 2.3 Staging Integration Test (Controlled User)
Create a test user in Clerk staging instance, sign in, and walk through the full onboarding flow.

### Phase 3: Production Deployment

#### 3.1 Deploy to Production
```bash
# Merge to main triggers auto-deploy
git checkout main
git pull origin main
# ... ensure all tests pass ...
git push origin main
```

#### 3.2 Production Smoke Tests (Automated in deploy.yml)
The `deploy.yml` workflow already runs:
- Backend `/api/health` → 200
- Backend `/api/events` → 401 (auth gate)
- Frontend `/` → 200
- Frontend `/dashboard` → 307/308/200
- Frontend `/dashboard/playbooks` → 307/308/200
- Frontend `/api/trpc/health.status` → 200/401
- Frontend `/api/health` → 200

**Add to smoke tests:**
```bash
# Onboarding page accessible
curl -s -o /dev/null -w "%{http_code}" \
  -H "Accept: text/html" \
  "https://nightlamp-frontend.onrender.com/onboarding"
# Expected: 200 (page loads, Clerk handles auth redirect) or 307/308

# Onboarding API requires auth
curl -s -o /dev/null -w "%{http_code}" \
  "https://nightlamp-api.onrender.com/api/onboarding/start"
# Expected: 401
```

### Phase 4: Production Verification (NOC-289)

#### 4.1 Fresh Customer Journey Test

**Scenario**: New user signs up, completes onboarding, reaches dashboard.

**Steps:**
1. **Sign Up**: Visit `https://nightlamp-frontend.onrender.com/sign-up`
   - Create account with fresh email
   - Verify email via Clerk
   
2. **Sign In**: Visit `https://nightlamp-frontend.onrender.com/sign-in`
   - Sign in with new account
   - Should redirect to `/onboarding` (not `/dashboard`)

3. **Onboarding - Step 1: App Detection**
   - Page loads at `/onboarding`
   - Enter app name (required) and URL (optional)
   - Click "Continue"
   - Verify API call: `POST /api/onboarding/start` → 200, then `POST /api/onboarding/:id/step` with `step: "monitor-selection"`

4. **Onboarding - Step 2: Monitor Selection**
   - Select at least one monitor (Sentry and/or UptimeRobot)
   - Click "Continue"
   - Verify API call: `POST /api/onboarding/:id/step` with `step: "alert-config"`

5. **Onboarding - Step 3: Alert Configuration**
   - Enter email for alerts (required)
   - Optional: Slack webhook URL
   - Click "Continue"
   - Verify API call: `POST /api/onboarding/:id/step` with `step: "team-invite"`

6. **Onboarding - Step 4: Team Invites**
   - Optional: Enter comma-separated emails
   - Click "Complete Setup"
   - Verify API call: `POST /api/onboarding/:id/complete` → 200 with `teamId` and `workspaceId`

7. **Post-Onboarding**
   - Redirect to `/dashboard?teamId=<new-team-id>`
   - Dashboard loads with new team context
   - Verify team exists via `GET /api/teams/:id` → 200

#### 4.2 Automated Verification Script

Create a Playwright/Puppeteer script to automate the above journey:

```javascript
// ops/verify-onboarding-journey.js
const { chromium } = require('playwright');

async function verifyOnboardingJourney() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const FRONTEND_URL = process.env.NIGHTLAMP_FRONTEND || 'https://nightlamp-frontend.onrender.com';
  const TEST_EMAIL = `onboarding-test-${Date.now()}@example.com`;
  const TEST_PASSWORD = 'TestPass123!';
  
  try {
    // 1. Sign up
    await page.goto(`${FRONTEND_URL}/sign-up`);
    await page.fill('input[name="email"]', TEST_EMAIL);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/sign-in**');
    
    // 2. Sign in
    await page.fill('input[name="email"]', TEST_EMAIL);
    await page.fill('input[name="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/onboarding**');
    
    // 3. Step 1: App Detection
    await page.fill('input[id="app-name"]', 'Test App');
    await page.fill('input[id="app-url"]', 'https://testapp.com');
    await page.click('button:has-text("Continue")');
    await page.waitForSelector('text="Monitor Selection"');
    
    // 4. Step 2: Monitor Selection
    await page.check('input[value="sentry"]');
    await page.click('button:has-text("Continue")');
    await page.waitForSelector('text="Alert Configuration"');
    
    // 5. Step 3: Alert Config
    await page.fill('input[id="alert-email"]', 'alerts@testapp.com');
    await page.click('button:has-text("Continue")');
    await page.waitForSelector('text="Team Invites"');
    
    // 6. Step 4: Team Invites (skip)
    await page.click('button:has-text("Complete Setup")');
    await page.waitForURL('**/dashboard**');
    
    // 7. Verify dashboard loads
    await page.waitForSelector('text="Dashboard"');
    
    console.log('✅ Onboarding journey verified successfully');
    return { success: true };
  } catch (error) {
    console.error('❌ Onboarding journey failed:', error.message);
    return { success: false, error: error.message };
  } finally {
    await browser.close();
  }
}

verifyOnboardingJourney().then(result => {
  process.exit(result.success ? 0 : 1);
});
```

#### 4.3 Verification Checklist

| Check | Expected | Actual |
|-------|----------|--------|
| Sign up page loads | 200 | |
| Sign in redirects to /onboarding | 307/308 | |
| Onboarding page loads | 200 | |
| Step 1: App Detection - submit | 200 (session created) | |
| Step 2: Monitor Selection - submit | 200 (step advanced) | |
| Step 3: Alert Config - submit | 200 (step advanced) | |
| Step 4: Team Invites - complete | 200 (team created) | |
| Redirect to dashboard | 307/308 | |
| Dashboard loads with team context | 200 | |
| Team created in backend | `GET /api/teams/:id` → 200 | |
| Membership created for owner | `GET /api/teams/:id/members` includes owner | |

---

## Troubleshooting

### Onboarding Page Not Loading
- **Check**: Frontend build includes `/onboarding` route
- **Verify**: `frontend/src/app/onboarding/page.tsx` exists and builds
- **Check**: Middleware doesn't block `/onboarding` (currently only protects `/dashboard`)

### Onboarding API Returns 401/403
- **Check**: Clerk JWT configuration on backend (`CLERK_JWT_ISSUER`, `CLERK_JWT_PUBLIC_KEY` or JWKS)
- **Verify**: Frontend sends `Authorization: Bearer <token>` header
- **Test**: `curl -H "Authorization: Bearer <token>" https://nightlamp-api.onrender.com/api/onboarding/start`

### Team Not Created After Completion
- **Check**: Backend logs for `onboardingApi.handleComplete` errors
- **Verify**: Database has `onboarding_sessions` and `teams` tables
- **Check**: Migration `008-tenant-isolation.ts` ran (team_id column exists)

### Redirect to Dashboard Fails
- **Check**: Frontend `router.push(\`/dashboard?teamId=\${result.teamId}\`)`
- **Verify**: Dashboard page handles `teamId` query param
- **Check**: Clerk `afterSignInUrl` set to `/dashboard`

---

## Acceptance Criteria

### NOC-288: Integration & Deployment
- [ ] Backend onboarding endpoints deployed and responding
- [ ] Frontend onboarding page accessible at `/onboarding`
- [ ] tRPC onboarding router included in appRouter
- [ ] Database migration for `onboarding_sessions.team_id` applied
- [ ] All CI tests pass (typecheck, lint, unit tests, build)

### NOC-289: Fresh Customer Journey
- [ ] New user can sign up → sign in → land on `/onboarding`
- [ ] All 4 onboarding steps complete successfully
- [ ] Team created in backend with correct owner membership
- [ ] User redirected to `/dashboard` with team context
- [ ] Dashboard loads and shows team-scoped data
- [ ] No console errors during journey
- [ ] Journey completes in < 5 minutes

---

## Related Documentation
- [Deployment & Rollback](./deployment-and-rollback.md)
- [NOC-284 Verification](./noc-284-verification.md)
- [Onboarding API Tests](../src/test/onboarding.test.ts)
- [Frontend Onboarding Page](../frontend/src/app/onboarding/page.tsx)