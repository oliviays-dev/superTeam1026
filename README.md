# Pluginmax Platform

Independent engineering platform for human-AI project collaboration.

The initial implementation provides:

- Independent React web application.
- Platform HTTP API with REST and SSE.
- PostgreSQL-backed projects, tasks, runs, events, and jobs.
- A separate agent worker with a deterministic fake runtime.
- A normalized run event model ready for DSH and external runtimes.
- Immutable task ContextPacks with source receipts.
- Project membership, responsibilities, project roles, and owner protection.
- A pinned DeepSeek Harness SDK runtime adapter.
- Task review, durable Markdown artifacts, and downloadable deliverables.
- Project memory published on task approval.
- Structured project memory with topics, claims, cited current-truth versions,
  and manual review controls.
- Project roles resolved to active AI members for task and workflow execution.
- Task prerequisite graphs with cycle validation and dispatch gates.
- Threaded task comments, a durable activity timeline, and task attachments
  with download, archive, and restore.
- Deterministic workflow Markdown validation/import and Agent-step Run dispatch
  behind task-review and durable-artifact gates.
- Graph workflow runtime with conditional branches, approvals, controlled loops,
  subworkflows, timeout recovery, idempotent commands, pause/resume and audit.
- Workbench metrics, workflow definitions/instances, and meeting rooms.

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

Main Web areas:

- Workbench: aggregate metrics and project memory.
- Projects: project, task, review, Run, Context, and artifacts.
- Workflows: definition creation, instance start, and step completion.
- Meetings: meeting rooms, participants, messages, and close state.

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

With the isolated API and Web running:

```sh
pnpm test:smoke:dependencies
pnpm test:smoke:collaboration
pnpm test:smoke:workflow
pnpm test:smoke:workflow-agent
pnpm test:smoke:workflow-runtime
pnpm test:smoke:workflow-governance
pnpm test:smoke:workflow-postgres
pnpm test:smoke:production-postgres
pnpm test:smoke:backup
pnpm test:smoke:backup-restore
pnpm test:e2e:browser
```

With API running:

```sh
pnpm test:membership
```

## Architecture

See [engineering-platform-v1-technical-design.md](./docs/engineering-platform-v1-technical-design.md).
Workflow runtime semantics and migration notes are in
[v1-batch5-workflow-runtime.md](./docs/v1-batch5-workflow-runtime.md).
Recovery, idempotency and approval governance are documented in
[v1-batch6-workflow-governance.md](./docs/v1-batch6-workflow-governance.md).

批次 7 的运行可靠性、审批 SLA、保留策略和运维入口见
[v1-batch7-runtime-reliability.md](./docs/v1-batch7-runtime-reliability.md).

批次 8 的持久化维护调度、Runtime effect 回执、取消交接、指标与告警见
[v1-batch8-maintenance-effect-safety.md](./docs/v1-batch8-maintenance-effect-safety.md).

批次 9 的源码/PostgreSQL 备份恢复、W3C Run 追踪和生产负向验收见
[v1-batch9-production-readiness.md](./docs/v1-batch9-production-readiness.md).
