# Urja portal notes

These notes summarize the portal behavior used by this API. Its internal routes may change.

## Login and access

The portal requires an account. The API submits the login form to `POST /login` with the account email and password, plus same-origin headers. The portal returns a session cookie, which the API keeps and uses for later requests. If the session expires, the API signs in again and retries once.

## Data used

| Portal route | Data |
| --- | --- |
| `GET /portal/meters/search?q={query}&page={page}` | Meter list and pagination |
| `GET /meters/{meterId}` | Meter nameplate and network breadcrumb (HTML) |
| `GET /portal/meters/{meterId}/geo` | Coordinates |
| `GET /portal/meters/{meterId}/energy` | Consumption readings |
| `GET /portal/dts?page={page}` | Distribution transformers |

Meter details are served from `/meters/{meterId}`—not `/portal/meters/{meterId}`. The API uses the regular paginated meter list and individual details to build its local index; it does not use bulk exports.

## Quirks

- The portal's meter list returned 20 records per page during inspection.
- Coordinates and readings may be strings. Invalid or missing coordinates become `null`; `(0, 0)` is treated as unknown.
- Consumption timestamps stay in the portal's `DD/MM/YYYY HH:mm` format because their timezone is unknown.
- The hierarchy is inferred from codes in meter breadcrumbs. Missing or unfamiliar codes mean the resulting tree may be incomplete.
- A `404` from the geo route means no location is available. Other upstream errors are reported without exposing portal details.
- The API caches results and saves the last successful index to `.cache/meter-index.json` by default. It can serve that older index if a refresh fails.
- `/health` checks that the API is running, not that the portal is reachable.
