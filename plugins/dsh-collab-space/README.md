# dsh-collab-space

Out-of-tree DSH sharing services for workspace files, advisory locks, and read-only session digests.

The plugin owns `collabSharing`, `collabLock`, and `collabDigest`. It provides `/share`, `collab_share`, `collab_global_read`, and approval-gated `collab_global_write`, plus same-origin Bearer-protected browser routes under `/api/collab/space/*`.

Browser routes are registered through an optional `collabTeam` fiber. The command and tool surface remains available if identity is not installed.

Global files are served through the plugin tool gateway and never added to a sandbox writable root. Workspace writes are guarded by secret scanning, normalized path containment, symlink checks, advisory locks, and claims.
