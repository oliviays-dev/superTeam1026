# dsh-collab-workflow

Workspace-scoped workflow definitions and instances for DSH Pluginmax. The
plugin provides Markdown import, deterministic validation, approvals, decision
routing, controlled loops, sub-workflows, a native conversation tab, and a
settings management surface.

Executors and approvers accept `principal:<id>` references. They are resolved
to the existing user/employee actor model during parsing, while runs and
workflow events record the canonical `principalId` for new execution.
Teammate executors with a Principal Runtime Profile are dispatched as
`principal-runtime` runs with a context-bound Action Ticket.
