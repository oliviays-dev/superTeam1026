# dsh-collab-meeting

Out-of-tree DSH meeting rooms with durable participants, transcripts, seat synchronization, and bounded continuable meeting Agents.

The plugin owns `collabMeeting` and the `collab_meeting` storage domain. Browser routes activate when identity provides `collabTeam`; role seats and personas are optional soft dependencies.

It provides durable meetings, human participants, seat synchronization, transcripts, delivery records, close summaries, and tombstoned departures. Meeting Agents are created only through the Agent-facing `collab_meeting` tool and call the locked upstream `subagents.startContinuable` API with a `toolFilter` limited to `collab_meeting`.

Browser APIs live under `/api/collab/meetings` and `/api/collab/meeting/*`. They require same-origin requests and a Bearer identity token, then workspace membership or an admin exception.

AI participants and representatives accept `principal:<id>` as well as the
legacy teammate/employee IDs. Principal references are normalized to the bound
AI Companion runtime before joining or assigning a delegate.
Facilitator and AI representative execution prefer Principal Runtime Profiles;
legacy Employee Runtime IDs remain readable for historical meetings.
