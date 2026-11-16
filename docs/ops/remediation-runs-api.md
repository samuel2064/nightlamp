# Remediation approval queue

`GET /api/remediation/runs` requires a valid bearer token through the default-deny API authentication gate. The authenticated team determines the scope; callers cannot override it through query parameters. Personal scope sees only legacy rows with a null `team_id`.

## Query parameters

| Parameter | Default | Behavior |
| --- | --- | --- |
| `status` | `pending` | Exact stored run status. Awaiting approval is `pending`, not `pending_approval`. An unknown status returns an empty list. |
| `limit` | `50` | Positive integer, capped at 200. |
| `offset` | `0` | Non-negative integer. |

Invalid pagination returns HTTP 400. Missing or invalid authentication returns HTTP 401. Results are ordered by `created_at` descending, then `id` ascending for stable pagination.

## Response

The top-level object contains exactly `{ runs, count }`. `count` is the total number of tenant-visible runs matching the status before pagination.

Each run contains `id`, `playbook_entry_id`, `action_name`, `status`, `initiated_by`, `approved_by`, `output`, `error`, `created_at`, `started_at`, `completed_at`, `affected_resource`, `failure_type`, and `description`. Nullable stored values remain null.

`affected_resource` is the linked playbook ID, matching the current approval engine's resource reference. The schema has no separate resource column. `failure_type` and `description` come from the linked playbook's `failure_type` and `body`; both are null if no same-scope playbook is available. A cross-tenant playbook link never exposes its contents. Runs are mapped using SQL column names.

Use the returned run `id` with `POST /api/remediation/approve` or `POST /api/remediation/reject` (existing elevated-role and tenant checks apply). `/api/playbook/remediation-logs` is the separate execution-log endpoint and does not supply this approval queue.
