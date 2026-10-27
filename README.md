# Flock Energy Urja Meter API

A Node.js service and dashboard for exploring meter, transformer, consumption, and network data from the Urja Meter Ops portal. The API handles portal login, normalizes its data, and builds a local meter index.

## Run locally

Requires Node.js 18+ and authorized portal credentials.

```powershell
npm install
Copy-Item .env.example .env
```

Set `PORTAL_EMAIL` and `PORTAL_PASSWORD` in `.env`, then start the server:

```powershell
npm run dev
```

Open `http://localhost:3000`. Use `npm start` without the file watcher, or `npm test` to run tests. `PORTAL_BASE_URL` is also required; `PORT` and `PORTAL_TIMEOUT_MS` are optional.

## Project structure

```text
flock/
├── src/                 API server, portal client, data service, normalizers, cache
├── public/              Dashboard and static assets
├── test/                Automated tests
├── .env.example         Example configuration
├── openapi.json         API specification
├── PROTOCOL.md          Portal behavior notes
└── REFLECTION.md        Project reflection
```

## API

The dashboard is at `/`, interactive API docs at [`/docs`](/docs), and the OpenAPI 3.0 specification at [`openapi.json`](./openapi.json), served at `/openapi.json`.

| Route | Purpose |
| --- | --- |
| `GET /api/v1/meters?q=J100&page=1` | Search meters |
| `GET /api/v1/meters/{meterId}` | Meter details and location |
| `GET /api/v1/meters/{meterId}/consumption` | Consumption readings |
| `GET /api/v1/transformers?page=1` | List transformers |
| `GET /api/v1/hierarchy` | Reconstructed network tree |
| `GET /api/v1/index/meters?make=HPL` | Filter the local index |
| `GET /api/v1/meters/nearby?lat=26.9&lon=75.8` | Find nearby meters |
| `GET /api/v1/dashboard` | Dashboard data and index progress |

Example:

```sh
curl "http://localhost:3000/api/v1/meters?q=J100&page=1"
```

Responses use normalized field names and include pagination where applicable. See `/docs` for parameters and response schemas.

## How it works

The service signs in to the portal with the configured account, retains its session cookie, and reads portal JSON plus server-rendered meter detail pages. It caches responses and builds a local index for filtering, nearby searches, and hierarchy views. [PROTOCOL.md](./PROTOCOL.md) describes the portal routes, authentication, and quirks.

## Reflection

- **Assumption:** I expected the portal data to be clean, I should have allowed more for gaps and inconsistencies.
- **Hardest part:** Keeping the dashboard useful without making it feel overbuilt.
- **With another day:** I’d make the dashboard more practical for the people using it in daily operations.
- **A mistake:** I loaded all the data at once, which made the dashboard take longer to load.
- **Self-review:** I’d remind myself that less can be more and adding more doesn’t always make it better.
