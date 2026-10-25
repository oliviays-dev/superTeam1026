# dsh-pluginmax

DSH Pluginmax is an out-of-tree collaboration plugin suite for DeepSeek Harness. This repository intentionally contains no fork of DSH and no patches to upstream source files. The compatibility baseline is the `vendor/deepseek-harness` submodule at `d347e703908d0406b7a7ef80e3a0e594d86b2215` (`@deepseek-ai/dsh@0.1.3-alpha.1`).

## Current milestone

The current milestone is Phase 4C: Principal-first runtime migration. It adds:

- `collab_principal_runtime` with Principal-owned Runtime Profiles and Action Tickets
- new AI companions that bind `principalId` and no longer create Employee records
- automatic migration of legacy Employee-backed AI companions to Principal-first runtime
- Principal-first dispatch after migration, even when the legacy `employeeId` alias remains
- Principal Action Ticket issuance in Task and Workflow dispatch
- `principal-runtime` Agent Runs while retaining legacy Employee runs for history
- read-only Employee compatibility APIs, data export, and consistency reporting from Phase 4A

The context platform foundation adds:

- `dsh-collab-memory`: temporal project claims/current truth, project-scoped agent
  episodes, handoffs, review items and idempotent ingestion jobs
- `dsh-collab-context`: isolated scene sessions, chat channels, immutable context
  packs, receipts, adapters and identity snapshots
- meeting-module AI 1:1 conversations as private `chat` scenes with dedicated
  `de-chat-*` sessions instead of meeting tasks or minutes

Phase 3 delivered canonical `principal:<id>` references, with `employee:` / teammate / account aliases during migration, and mirrored all platform, workspace, and project grants to Principal.

Phase X introduced `dsh-collab-agent`, which provides:

- workspace-scoped Agent Profiles and one-shot Task Worker runs
- explicit manual and `auto-on-ready` workflow dispatch
- bounded prompt construction, cancellation, timeout, restart recovery, and run history
- mapping of a worker's final text output into the existing deliverable gate
- human confirmation before an agent-executed node can complete

The Task Worker does not create a sidebar home session, join meetings, inherit full host permissions, or complete workflow nodes by itself.

The employee platform milestone through E7 adds `dsh-collab-employee` and connects it to workflow execution:

- durable `collab_employee` records with `human` and `digital` employee kinds
- automatic compatibility mapping from every Identity login account to a Human Employee
- same-origin Bearer-protected employee, role, runtime, delegation, ticket, report, and audit APIs
- Digital Employee lifecycle records without password-login capability
- explicit workspace role grants, Runtime Profiles, tool allow/deny policies, resource scopes, and budgets
- context-bound Action Tickets with deny-wins authorization and auditable permission provenance
- structured Human Avatar delegations with owner/admin-only ticket control, pause, extend, revoke, expiry, and reports
- meeting avatar dispatch that creates a restricted delegation and generates a per-avatar report without adding the avatar to the employee directory
- `employee:<employeeId>` workflow execution with explicit Runtime Profile mapping, context-bound Action Tickets, auditable runs, and the existing deliverable gate
- an admin governance center for employees, permission provenance, runtime budgets, activity, failures, and avatar reports
- a main-area workstation with employee detail, delegation detail, workflow node, approval, avatar report, and admin permission panels

Role-based workstation panel composition is deliberately reserved for a later iteration. The current workstation exposes the six base panels in a fixed layout and displays the reserved role-profile schema instead of pretending that custom layouts are editable.

Workflow approval references can parse `employee:<employeeId>`, but final approval remains visibly pending until the dedicated Digital Employee runtime decision path is delivered. Browser users cannot approve on behalf of a Digital Employee.

The employee model deliberately keeps Human Avatar / Delegation out of the employee directory and preserves existing `userId` compatibility.

The project management milestone adds `dsh-collab-project`, which provides:

- a `collab_project` storage domain that keeps project metadata (code, owner, status, health, progress, dates, description) keyed by DSH workspace id
- a project role library and project templates that predefine project roles and reference workflow templates owned by `dsh-collab-workflow`
- member project roles written through `dsh-collab-roles` assignments, so task dispatch and workflow `role:` executors share one source of truth
- deterministic project daily reports with per-day snapshots
- same-origin Bearer-protected `/api/collab/projects/*` routes and a Chinese 项目管理 global page

Platform accounts and platform role permission stay read-only inside the module: member changes only touch project (workspace) membership and project role seats.

Phase X builds on R4. `dsh-collab-meeting` provides:

- `ctx.collabMeeting`: durable meeting rooms, human participants, seat participants, transcripts, delivery records, and close summaries
- pending-seat persona fallback with `/assignment claim <workspace> <seat>` guidance
- first-active-participant leader marking and tombstoned departures that retain participant names
- `/meeting` and `collab_meeting`, including bounded Agent spawn through the upstream `subagents.startContinuable` API
- same-origin Bearer-protected `/api/collab/meetings` and `/api/collab/meeting/*` routes
- a Chinese Settings section for meeting creation, joining, seat synchronization, transcript, leave, and close workflows

R3 adds `dsh-collab-roles`, which provides personas, SOUL presets, workspace types, materialized seats, claims, assignments, and leader election.

R2 adds `dsh-collab-space`, which provides:

- `ctx.collabSharing`: policy-gated workspace/session sharing, global approval requests, path-safe atomic writes, and secret scanning
- `ctx.collabLock` and `ctx.collabDigest`: advisory locks and redacted session summaries
- same-origin Bearer-protected `/api/collab/space/*` routes
- `/share`, `collab_share`, `collab_global_read`, and approval-gated `collab_global_write`
- a Chinese Settings section for uploads, policies, locks, global approvals, digests, and audit records

Global shares stay outside sandbox writable roots. Agents access them only through the plugin tool gateway, and agent global writes require an approval decision.

R1 adds `dsh-collab-identity`, which provides:

- `ctx.collabTeam`: users, scrypt passwords, bearer sessions, workspace members, and audit records
- same-origin `/api/collab/auth/*` and `/api/collab/team/*` routes
- an anonymous-safe `/identity` command and `collab_identity` tool
- a Chinese Settings section for bootstrap/login, password changes, member management, and the audit timeline

The durable domains use snake-case names (`collab_team`, `collab_sharing`, `collab_config`, and `collab_locks`) because the locked DSH storage API only accepts snake-case unit names; they own the product domains otherwise described as `collab.team`, `collab.sharing`, `collab.config`, and `collab.locks`.

R0 provides the repository foundation and `dsh-pluginmax-canary`, which validates:

- local `link:` bundle installation
- `ctx.storageDomain`
- `ctx.commands`
- `ctx.tools`
- `ctx.webServer`
- `settings.section` through `dsh.client`
- clean submodule ownership and disposable `DSH_HOME`

Product plugins are added milestone by milestone under `plugins/`.

## Setup

```sh
./scripts/bootstrap.sh
./scripts/install-profile.sh
./scripts/smoke.sh
```

Bootstrap builds both this workspace and the locked upstream DSH checkout. Installation and smoke testing always use `.tmp/dsh-home`; they do not touch `~/.dsh`.

## Development

```sh
pnpm check
```

This runs typecheck, lint, unit tests, package builds, bundle contracts, and dry-run pack validation.

Run only the web smoke server:

```sh
PLUGINMAX_SMOKE_PORT=33117 ./scripts/smoke.sh
```

## Upstream policy

The upstream submodule is read-only. To evaluate a new master ref, create a branch and run:

```sh
./scripts/upgrade-upstream.sh <commit>
./scripts/bootstrap.sh
pnpm check
```

Do not edit files under `vendor/deepseek-harness`. A CI check fails if the submodule is dirty or its checked-out commit drifts from the reviewed gitlink.
