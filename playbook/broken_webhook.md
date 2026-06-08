# Broken Webhook Investigation

- **First seen:** 2026-05-21T18:19:04.168Z
- **Last occurrence:** 2026-05-21T18:19:04.168Z
- **Occurrence count:** 1

## Broken Webhook

### Symptoms
- 5xx responses from callback URL
- Missing or delayed webhook deliveries

### Diagnostic Steps
1. Verify webhook endpoint is reachable: `curl -I <callback_url>`
2. Check webhook secret matches integration configuration
3. Review webhook delivery logs in provider dashboard
4. Test with a manual payload using the provider's test tool

### Resolution
- If endpoint is down: restart service and verify health endpoint
- If secret mismatch: rotate webhook secret and update both sides
- If payload format changed: compare with provider's latest API docs

