# Pluginmax Platform

Independent engineering platform for human-AI project collaboration.

The initial implementation provides:

- Independent React web application.
- Platform HTTP API with REST and SSE.
- PostgreSQL-backed projects, tasks, runs, events, and jobs.
- A separate agent worker with a deterministic fake runtime.
- A normalized run event model ready for DSH and external runtimes.
- Immutable task ContextPacks with source receipts.
- A pinned DeepSeek Harness SDK runtime adapter.

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

The `DSH SDK Agent` is available through `@deepseek-ai/dsh@0.2.1-rc.3`.
Set `DEEPSEEK_API_KEY` in the root `.env` before dispatching a task to that
agent. `DSH_HOME` remains isolated under the new project's `.tmp` directory.

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
