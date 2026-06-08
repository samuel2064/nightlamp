# Expired Token Investigation

- **First seen:** 2026-05-18T21:19:33.922Z
- **Last occurrence:** 2026-05-18T21:19:33.922Z
- **Occurrence count:** 1

## Expired Token

### Symptoms
- 401/403 responses from API calls
- Error messages mentioning "expired", "invalid token", or "unauthorized"

### Diagnostic Steps
1. Check token expiry date in provider dashboard
2. Verify token is correctly set in environment variables
3. Test token manually: `curl -H "Authorization: Bearer <token>" <api_endpoint>`
4. Check if token was revoked or rotated

### Resolution
- Generate new token from provider dashboard
- Update environment variable and restart service
- If using short-lived tokens, implement token refresh logic

