# dsh-collab-context

The platform context assembly center.

- Registers scene adapters for tasks, meetings, workflow nodes and chat.
- Creates one isolated session per scene object and AI companion.
- Produces immutable `ContextPack` snapshots and `ContextReceipt` records.
- Delivers versioned scene contributions incrementally across reruns.
- Enforces workspace/project boundaries and deterministic prompt rendering.
- Renders execution/source policies as dedicated system sections, so an
  authorized research task can use public web tools without relabeling fresh
  sources as unauthorized ContextPack reads.
- Supports native chat sessions and meeting-module AI conversations.

The plugin owns the `collab_context` storage domain and exposes
`ctx.collabContext`.
