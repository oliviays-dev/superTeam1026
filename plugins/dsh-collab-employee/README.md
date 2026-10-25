# dsh-collab-employee

Legacy Employee runtime adapter retained for task, workflow, meeting, runtime-profile,
Action Ticket, and audit compatibility.

Employee is no longer a target product domain and has no settings navigation entry.
Its browser API is now read-only by default: product create/update/status/role/runtime/ticket
and delegation mutation routes return `410 gone`.
Human Employees reuse the mapped auth account; Digital Employees are hidden runtime
identities for AI companions. Employee writes project into `collab_principal` through
the `collabPrincipal` service:

- Human Employee reuses the `auth-user` Principal mapping.
- Digital Employee maps to an AI Principal.
- AI companion binding adds a `teammate` link to the same AI Principal.
- Compatibility DTOs expose `principalId` without changing stored Employee records.
- Workspace role assignments, Runtime Profiles, Action Tickets, delegations, and audit
  events carry Principal IDs while preserving their Employee compatibility fields.
- A disabled login or non-active Employee projects to a suspended Principal; an archived
  Principal cannot be revived by a later credential sync.
- When legacy data contains multiple Human Employees for one account, only the current
  effective record is projected to the shared Principal.

The plugin must not create login accounts for Digital Employees and must not expose
Human Avatar records as employees. Phase 3 keeps Employee IDs as migration aliases;
remaining consumers can move to Principal-first reads before the Phase 4 removal.

Phase 4A adds two admin-only compatibility endpoints:

- `GET /api/collab/employee/export` exports all compatibility tables.
- `GET /api/collab/employee/compatibility` reports Employee/Principal mapping,
  status, Grant, Runtime Profile, Action Ticket, and Delegation migration gaps.

Internal AI runtime writes remain available until the Principal Runtime migration
replaces the hidden Employee storage.
