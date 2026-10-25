# dsh-collab-identity

R1 identity plugin for DSH Pluginmax. It owns the `collab.team` storage domain and provides `ctx.collabTeam` with password login, bearer sessions, workspace membership, and an append-only audit trail.

The browser surface is limited to same-origin `/api/collab/*` requests carrying the plugin-owned bearer token. The Agent command and tool surfaces expose only sanitized identity status and account data, and safely degrade to anonymous status when no identity is bound.

The plugin also owns the `collab_principal` domain. It maps platform accounts to Human Principals,
links Employee projections and AI companions, and provides the foundation for Principal-based role grants.
`principal:<id>` is the canonical reference; account, Employee, and teammate IDs are migration aliases.
Platform, workspace, and project role writes are mirrored to `role_grants`. Task, workflow, meeting, and
project consumers now write Principal provenance while retaining their legacy ID fields for Phase 4 removal.

The settings HTTP routes keep platform-admin-only member writes. The in-process TeamService exposes an explicit
`allowWorkspaceOwner` option for trusted project-management calls, so workspace owners can manage project
membership without widening the collaboration-identity settings surface.

The legacy `平台设置 -> 协作身份` settings section is offline. The identity plugin now contributes the
`登录账号` tab inside the unified `账号与权限` section; `角色` and `审计` arrive from their owning plugins.
There is no Employee product tab.

Account management loads only the global user directory. It does not fetch employee projections, workspace
members, or audit events. The legacy HTTP routes for member set/remove/leave and audit remain for compatibility,
while project management calls the corresponding TeamService methods in-process. The unused `asAgent` service
method has been removed.
