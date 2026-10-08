# limbo

**English** · [Русский](README.ru.md)

A whiteboard where you draw an architecture and immediately run it under load: draw.io that can do the math.

![News feed under 7.7k rps: three nodes are over capacity, the queue builds a backlog](docs/screenshots/board-closeup-dark.png)

Build a diagram from clients, load balancers, services, caches, databases and queues, turn up the traffic and see what breaks first, what p95 and p99 latencies your requests get and how much it all costs per month. It's made for practicing system design interviews, but works for any back-of-the-envelope capacity check.

Stack: Angular 22 on the client, .NET 10 on the server. The simulation engine runs in the browser; the server stores diagrams and hands out short links. See `docs/` for details.

## Features

- **Editor.** A palette of 13 components (drag onto the board or click), a board on Foblex Flow (ADR 0003), port-to-port edges with reconnection, undo and redo, Delete removes the selection.
- **Simulation.** Everything is recalculated live: Run/Pause with a simulation clock, logarithmic traffic slider, Spike ×4 for 8 seconds, queue backlog.
- **Metrics and inspectors.** System metrics in the header. Node, edge and system inspectors, and every node explains how its numbers were calculated. An event log. Running dots and flow labels on edges. Dark and light themes.
- **Scenarios:** web app, URL shortener, chat, telemetry, news feed, empty board. Reads and writes can go over separate edges: in the news feed, reads go through the feed cache and publishing goes through a queue.
- **Saving.** The diagram autosaves in the browser. Open and File import and export `.loadline.json`, or just drop a file onto the board. Share makes a short link via the server, or without a server a link with the compressed diagram inside (ADR 0004).
- **Import from configs.** Paste or drop a `docker-compose.yml` (plus a Caddyfile or nginx.conf if you have one) and get a diagram you can load right away: component types are guessed from images and names, edges from `depends_on`, hostnames in environment variables and proxy upstreams. Every guess is shown before opening; the rules are in `docs/import.md`.
- **Tests:** engine (golden scenarios and model properties), diagram edits and formatting in the app, server Core tests.

The UI is in Russian for now; translations are welcome.

## Screenshots

The news feed under load: the bottleneck, errors, p99 and cost in the header, nodes sorted by load on the right, overloads in the event log.

![The board in dark theme with an overloaded news feed](docs/screenshots/board-overload-dark.png)

Light theme, a worker selected: replicas, capacity and latency are editable, and "How it's calculated" shows the formulas with the actual numbers.

![The board in light theme with the node inspector open](docs/screenshots/board-inspector-light.png)

## Repository layout

```
limbo/
├─ spec/                     single source of truth: JSON Schema, presets, golden scenarios
├─ web/                      pnpm workspace
│  ├─ packages/engine/       simulation engine, plain TS
│  ├─ packages/model/        types generated from the JSON Schema
│  ├─ packages/api-client/   API client
│  ├─ packages/import/       diagram from docker-compose, Caddyfile, nginx.conf
│  ├─ landing/               landing page: static at /, live demo on the engine
│  ├─ scripts/               site assembly: landing at /, board at /app/
│  └─ app/                   Angular 22
├─ server/                   .NET 10 solution (Loadline.slnx)
│  ├─ src/Loadline.Api/      Minimal API
│  ├─ src/Loadline.Core/     diagram validation, slugs, tokens
│  ├─ src/Loadline.Data/     EF Core 10 + PostgreSQL
│  ├─ src/Loadline.AppHost/  Aspire: Postgres + API in one command
│  └─ tests/                 xUnit v3, Testcontainers
├─ docs/                     how the model works, ADRs
├─ deploy/                   Dockerfile, compose, Caddy, backups
└─ .github/workflows/        CI
```

## Requirements

- Node.js 24.15+ and pnpm 10 (`corepack enable`)
- .NET SDK 10
- Docker (for Postgres via Aspire and for integration tests)

## Getting started

```bash
# 1. Frontend and engine
cd web
pnpm install
pnpm build          # model → engine → api-client → app
pnpm test           # engine tests (golden + properties) and app tests
pnpm start          # board: http://localhost:4200
pnpm start:landing  # landing: http://localhost:4300
pnpm build:site     # the site as hosted, in web/dist/site: landing at /, board at /app/

# 2. Server (in another terminal)
cd server
dotnet run --project src/Loadline.AppHost   # Postgres in Docker + API on :5080
```

The frontend works without the server: the simulation runs in the browser. The Angular dev server proxies `/api` to `localhost:5080`.

Without Aspire, run Postgres yourself (`loadline/loadline`, database `loadline`) and start `dotnet run --project src/Loadline.Api`.

`http://localhost:4200/?fps` adds an FPS counter and a 200-node scenario: the board smoothness benchmark from ADR 0003.

## Database migrations

EF Core migrations live in `server/src/Loadline.Data/Migrations`. In Development the API applies them on startup. `dotnet-ef` is pinned in `server/dotnet-tools.json` and matches the EF Core version.

```bash
cd server
dotnet tool restore
dotnet tool run dotnet-ef migrations add <Name> -p src/Loadline.Data -s src/Loadline.Data -o Migrations
```

CI checks that migrations cover the model (`has-pending-model-changes`).

## Deployment

The frontend is static on Cloudflare Pages; the API and Postgres run on a single VPS behind Caddy, on separate domains.

**API.** `deploy/compose.yaml` starts Postgres, then a one-off `migrate` service (an EF bundle from the API image), and only then the API and Caddy with TLS.

```bash
cp deploy/.env.example deploy/.env   # Postgres password, API domain, frontend domain
docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
```

`WEB_ORIGIN` goes into the API's `Cors:Origins`: requests are accepted only from the frontend domain.

**Frontend.** The site has two parts: the landing page at `/` and the board at `/app/` (the production build uses `baseHref /app/`). The landing page forwards old `/#s=…` links to `/app/`. A practice scenario opens with `/app/#scenario=news-feed` (a file name from `spec/scenarios` without `.loadline.json`): the scenario opens over your own diagram, and Ctrl+Z brings it back.

`.github/workflows/deploy-web.yml` builds the site and deploys it to Pages on every push to `main`. It does nothing until the repository has the `CF_PAGES_PROJECT` and `LOADLINE_API_URL` variables and the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. The API URL is baked in at build time:

```bash
pnpm --filter @loadline/app build --define "LOADLINE_API_URL=\"'https://api.example.com'\""
```

Without it the client calls the same origin (`/api`). If the API is unavailable, Share makes a link with the diagram inside (ADR 0004).
- **Import from configs.** Paste or drop a `docker-compose.yml` (plus a Caddyfile or nginx.conf if you have one) and get a diagram you can load right away: component types are guessed from images and names, edges from `depends_on`, hostnames in environment variables and proxy upstreams. Every guess is shown before opening; the rules are in `docs/import.md`.

**Behind an existing reverse proxy.** If the machine already runs Caddy, nginx or Traefik on 80/443, use `deploy/compose.behind-proxy.yaml`: no ports and no Caddy of its own, and the frontend is a container too. `limbo-web` and `limbo-api` join the proxy's external network (`PROXY_NETWORK`, `edge` by default), and the proxy sends one domain to them: `/api/*` to `limbo-api:8080`, everything else to `limbo-web:8080`. The frontend and the API share a domain, so no API URL is baked in.

```bash
docker network create edge
cp deploy/.env.example deploy/.env   # Postgres password, WEB_ORIGIN=https://<your domain>
docker compose -f deploy/compose.behind-proxy.yaml --env-file deploy/.env up -d --build
```

For Caddy:

```caddyfile
limbo.example.com {
	handle /api/* {
		reverse_proxy limbo-api:8080
	}
	handle {
		reverse_proxy limbo-web:8080
	}
}
```

## Code generation

| Command | What it does |
| --- | --- |
| `pnpm gen:model` | TS types from `spec/loadline.schema.json` |
| `dotnet build` in `server/` | OpenAPI 3.1 in `server/src/Loadline.Api/openapi/` |
| `pnpm gen:api` | Client types from OpenAPI (after the first server build) |

Generated code is never edited by hand; CI checks it against its sources.

NuGet versions in `server/Directory.Packages.props` are exact, npm versions are locked in `web/pnpm-lock.yaml`.

## License

MIT, see [LICENSE](LICENSE).
