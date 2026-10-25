# dsh-collab-task

Task and Issue management for DSH Pluginmax. The plugin owns the
`collab_task` storage domain and exposes authenticated workspace-scoped task
routes under `/api/collab/tasks/*`.

It provides task records, assignment to people, digital employees, or role
seats, status transitions, acceptance steps, executor messages, comments,
replies, activity events, and external links to meetings/workflows.

Task receivers accept canonical `principal:<id>` references plus `employee:<id>`
and account/teammate aliases. The compatibility receiver ID remains on the
record, with `receiverPrincipalId` and Principal-aware task events alongside it.
Principal Runtime dispatch issues a context-bound Action Ticket and records the
ticket plus `principalType: principal-runtime` on the Agent Run.

Task messages carry an explicit `deliveryTarget`:

- `receiver`: dispatch or reopen only the task receiver; mentions remain
  recorded but are not executed;
- `collaborators`: dispatch only mentioned collaborators and leave the owner
  lifecycle unchanged;
- `broadcast`: dispatch the receiver and mentioned collaborators.

Older clients that omit the field are resolved with the previous mention-based
fallback. The submit endpoint validates acceptance steps before changing task
state; it never auto-checks the first step on the user's behalf.

Rejecting a task also requires a non-empty rejection note. The note is stored in
task history with `deliveryTarget: receiver`, so the next executor sees the
reason without relying on a separate comment.

Phase-one execution control adds an optional task execution policy:

- allowed runtime pool and required capabilities;
- source/citation policy;
- tool allow/deny/approval categories;
- evidence and human-gate requirements.

The policy may override model and reasoning effort only from the Runtime already
bound in the responsible AI teammate's definition. The task UI never changes the
Runtime itself; humans and built-in teammates do not expose external-model
overrides.

Task creation remains independent of Team/Delivery. The task plugin exposes an
aggregated execution view and Execution Gate decisions, but Agent Plan, Run
Events and Run snapshots remain owned by `dsh-collab-agent`.
