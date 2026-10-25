# dsh-collab-memory

Platform project memory and AI companion private memory.

- Project topics, append-only claims and derived current truth.
- Temporal decisions with HOLD, withdrawal, reopen, expiry and conflict states.
- Project-scoped agent episodes and explicit handoff cards.
- Review items for low-confidence candidates.
- Durable, idempotent source ingestion jobs.

The plugin owns the `collab_memory` storage domain and exposes
`ctx.collabMemory`.
