# Pluginmax Platform

Independent engineering platform for human-AI project collaboration.

The initial implementation provides:

- Independent React web application.
- Platform HTTP API with REST and SSE.
- PostgreSQL-backed projects, tasks, runs, events, and jobs.
- A separate agent worker with a deterministic fake runtime.
- A normalized run event model ready for DSH and external runtimes.

## Requirements

- Node.js 24+
- pnpm 11+
- Docker with a running daemon

## Development

```sh
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
pnpm dev
```

Open:

- Web: http://127.0.0.1:4311
- API health: http://127.0.0.1:4310/api/v1/health

## Checks

```sh
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

With API and Worker running:

```sh
pnpm test:e2e
```

## Architecture

See [engineering-platform-v1-technical-design.md](./docs/engineering-platform-v1-technical-design.md).
