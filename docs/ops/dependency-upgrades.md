# Dependency & Upgrade Runbook

Owner: Backend Engineer
Related: [Incident Response](incident-response.md), [SLO](../slo/README.md)

## Monitoring

- `GET /api/dependencies` — current tracked deps.
- `GET /api/dependencies/updates` — detected version updates.
- `GET /api/dependency-health` — health per dependency (used by CI gate).

Nightlamp parses upstream changelogs/registries to flag breaking changes before
they ship live; Dependency Change Detection is [NOC-5](/NOC/issues/NOC-5).

## Standard Upgrade Procedure

1. Review pending updates (`/api/dependencies/updates`); identify breaking changes.
2. Create a branch, bump the pinned version, run the full suite + build locally.
3. Open a PR (CI runs typecheck + 400+ tests + frontend build automatically).
4. On green, merge to `main` → automated CD deploys to Render + smoke test.
5. Verify `/api/health` and `/api/performance/latency` post-deploy within 24h.

## Emergency Dependency Fix

1. If an upstream change breaks production (e.g. rate-limit shift, schema drift):
   - Apply the remediation in the auto-generated playbook for the failure type,
     or pin the last-good version.
2. Ship via emergency deploy (see [Deployment & Rollback](deployment-and-rollback.md)).

## Rollback Dependency

1. Revert the version bump to the prior known-good commit.
2. Merge → CD deploys → smoke verifies.
3. Record the failure pattern so the playbook captures it for next time.