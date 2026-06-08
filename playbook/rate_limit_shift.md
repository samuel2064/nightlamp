# Rate Limit Shift Investigation

- **First seen:** 2026-05-21T18:19:04.169Z
- **Last occurrence:** 2026-05-21T18:19:04.169Z
- **Occurrence count:** 1

## Rate Limit Shift

### Symptoms
- HTTP 429 responses from API
- Headers indicating rate limit exceeded

### Diagnostic Steps
1. Check rate limit headers: `X-RateLimit-Remaining`, `X-RateLimit-Reset`
2. Review recent API call volume vs. documented limits
3. Check if other services using same API key

### Resolution
- Reduce poll frequency or batch requests
- Implement exponential backoff with jitter
- Upgrade API plan if hitting hard limits
- Distribute load across multiple API keys if supported

