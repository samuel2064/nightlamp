# UptimeRobot Monitor Setup for NOC-314

## Required Monitors

### 1. Backend Health Endpoint Monitor
- **URL:** `https://nightlamp-api.onrender.com/api/health`
- **Type:** HTTP(s)
- **Interval:** 5 minutes (or 1 minute if on paid plan)
- **Alert Contacts:** Configure to notify on-call (PagerDuty, Slack, Email)
- **Expected Response:** HTTP 200 with JSON containing `"status":"ok"`
- **Keyword Monitor (optional):** Check for `"status":"ok"` in response body

### 2. Backend Auth Gate Monitor
- **URL:** `https://nightlamp-api.onrender.com/api/events`
- **Type:** HTTP(s)
- **Interval:** 5 minutes
- **Alert Contacts:** Same as above
- **Expected Response:** HTTP 401 (auth gate live)
- **Alert on:** HTTP 200 (gate down), HTTP 503 (config error), timeout

### 3. Frontend Root Monitor
- **URL:** `https://nightlamp-frontend.onrender.com/`
- **Type:** HTTP(s)
- **Interval:** 5 minutes
- **Alert Contacts:** Same as above
- **Expected Response:** HTTP 200

### 4. Frontend Dashboard Monitor
- **URL:** `https://nightlamp-frontend.onrender.com/dashboard`
- **Type:** HTTP(s)
- **Interval:** 5 minutes
- **Alert Contacts:** Same as above
- **Expected Response:** HTTP 307/308 (redirect to sign-in) or 200 (if authenticated)
- **Headers:** `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`

## Setup via UptimeRobot API

```bash
# Create backend health monitor
curl -X POST "https://api.uptimerobot.com/v2/newMonitor" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "api_key=$UPTIMEROBOT_API_KEY&format=json&type=1&url=https://nightlamp-api.onrender.com/api/health&friendly_name=Nightlamp%20Backend%20Health&interval=300&alert_contacts=YOUR_ALERT_CONTACT_IDS"

# Create backend auth gate monitor
curl -X POST "https://api.uptimerobot.com/v2/newMonitor" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "api_key=$UPTIMEROBOT_API_KEY&format=json&type=1&url=https://nightlamp-api.onrender.com/api/events&friendly_name=Nightlamp%20Auth%20Gate&interval=300&alert_contacts=YOUR_ALERT_CONTACT_IDS"

# Create frontend root monitor
curl -X POST "https://api.uptimerobot.com/v2/newMonitor" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "api_key=$UPTIMEROBOT_API_KEY&format=json&type=1&url=https://nightlamp-frontend.onrender.com/&friendly_name=Nightlamp%20Frontend%20Root&interval=300&alert_contacts=YOUR_ALERT_CONTACT_IDS"

# Create frontend dashboard monitor
curl -X POST "https://api.uptimerobot.com/v2/newMonitor" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "api_key=$UPTIMEROBOT_API_KEY&format=json&type=1&url=https://nightlamp-frontend.onrender.com/dashboard&friendly_name=Nightlamp%20Dashboard&interval=300&alert_contacts=YOUR_ALERT_CONTACT_IDS&custom_http_headers=Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
```

## Alert Contact Configuration

1. Go to UptimeRobot Dashboard → My Settings → Alert Contacts
2. Add contacts for:
   - PagerDuty (integration)
   - Slack (webhook)
   - Email (on-call rotation)
3. Note the Alert Contact IDs for the API calls above

## Verification

After creating monitors:
1. Wait for first check to complete
2. Verify all monitors show "Up" status
3. Test alert by temporarily changing monitor URL to a failing endpoint
4. Confirm alert received via configured contacts
5. Restore correct URLs

## Integration with Nightlamp Codebase

The Nightlamp codebase already has UptimeRobot polling in `src/connectors/uptimerobot.ts` and `src/engine/health-check.ts`. To enable:

1. Set `UPTIMEROBOT_API_KEY` in Render environment variables for the backend service
2. The health check engine will automatically poll UptimeRobot every `POLL_INTERVAL_SEC` (default 60s)
3. Status changes are detected and routed through the alerting evaluator to configured channels

## Required Environment Variables

Add to Render backend service environment:
- `UPTIMEROBOT_API_KEY` - Your UptimeRobot API key (from UptimeRobot → My Settings → API Settings)

## Sentry Integration (Optional)

For Sentry error tracking on deployment failures:

1. Create a Sentry project for Nightlamp
2. Set in Render backend environment:
   - `SENTRY_AUTH_TOKEN` - Sentry auth token (User Settings → Auth Tokens)
   - `SENTRY_ORG_SLUG` - Your Sentry organization slug
   - `SENTRY_PROJECT_SLUG` - Your Sentry project slug
3. Set in GitHub Secrets:
   - `SENTRY_DSN` - For release tracking in GitHub Actions

The backend will automatically poll Sentry for new issues and spike detection.