# Schema Drift Investigation

- **First seen:** 2026-05-21T18:19:04.169Z
- **Last occurrence:** 2026-05-21T18:19:04.169Z
- **Occurrence count:** 1

## Schema Drift

### Symptoms
- Unexpected fields or missing fields in API responses
- Parsing errors when processing integration data

### Diagnostic Steps
1. Compare current response structure against expected schema
2. Check provider changelog for API version updates
3. Verify API version parameter in request
4. Log raw response for inspection

### Resolution
- Update data models to match new schema
- Pin API version if provider supports versioning
- Add defensive parsing with fallbacks for optional fields

