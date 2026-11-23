import { describe, expect, expectTypeOf, it } from "vitest";
import {
  meetingDomainSpec,
  MeetingService,
  type MeetingContext,
  type MeetingDomainLike,
  type PersonaServiceLike,
  type SubagentRunLike,
  type SubagentsRuntimeLike,
} from "./index.js";
import { MeetingDelegateService } from "./delegates.js";
import { MeetingFileService } from "./files.js";
import { MeetingReadService } from "./inbox.js";
import { MeetingMinutesService } from "./minutes.js";
import { MeetingMinutesRuntime } from "./minutes-runtime.js";
import { MeetingTaskService } from "./tasks.js";

interface TeamServiceLike {
  resolveToken(token: string): { userId: string; role: string } | undefined;
  members(workspaceId: string): readonly {
    userId: string;
    memberRole: string;
  }[];
}

interface WorkspaceRegistryLike {
  get(workspaceId: string): { readonly path: string } | undefined;
}

const team: TeamServiceLike = {
  resolveToken: (token) =>
    token === "contract-token" ? { userId: "user", role: "owner" } : undefined,
  members: () => [{ userId: "user", memberRole: "owner" }],
};

const workspaces: WorkspaceRegistryLike = {
  get: (workspaceId) =>
    workspaceId === "workspace"
      ? { path: "/tmp/workspace" }
      : undefined,
};

const personas: PersonaServiceLike = {
  get: async (id) => ({
    id,
    name: "Contract Persona",
    description: "contract persona",
  }),
  preset: async () => "contract persona preset",
};

const subagents = {
  async startActivation(spec: {
    readonly provider: string;
    readonly label: string;
    readonly prompt: ReadonlyArray<{ type: "text"; text: string }>;
    readonly parent: { readonly id: string; readonly session?: { readonly id?: string } };
    readonly signal: AbortSignal;
    readonly delivery: "caller";
  }): Promise<SubagentRunLike> {
    expect(spec.provider).toBe("spawn");
    expect(spec.label).toBe("meeting-worker:Contract Worker");
    expect(spec.prompt).toEqual([{ type: "text", text: "contract" }]);
    expect(spec.parent.id).toBe("meeting-agent");
    expect(spec.signal).toBeInstanceOf(AbortSignal);
    expect(spec.delivery).toBe("caller");
    return {
      id: "meeting-worker-run",
      result: Promise.resolve({
        output: [{ type: "text", text: "meeting reply" }],
        stopReason: "completed",
      }),
      dispose: async () => undefined,
    };
  },
} satisfies SubagentsRuntimeLike;

const meetingDomain = {
  table(name: string) {
    return {
      get: () => undefined,
      entries: function* () {}(),
      keys: function* () {}(),
      get size() {
        return 0;
      },
      put: async () => undefined,
      delete: async () => false,
    };
  },
  close: async () => undefined,
} as unknown as MeetingDomainLike;

const provided: string[] = [];
const effects: Array<() => void> = [];
const events: Array<{ event: string; payload?: unknown }> = [];

const context = {
  effect(operation: () => () => void): void {
    const dispose = operation();
    expect(dispose).toBeTypeOf("function");
    effects.push(dispose);
  },
  on(event: string, handler: (payload: unknown) => void): unknown {
    events.push({ event });
    handler({ meetingId: "meeting" });
    return () => undefined;
  },
  provide(key: string, value: unknown): unknown {
    expect(key.startsWith("collabMeeting")).toBe(true);
    expect(value).toBeDefined();
    provided.push(key);
    return undefined;
  },
  commands: {
    register(definition: { name: string }): unknown {
      expect(definition.name).toBe("meeting");
      return undefined;
    },
  },
  tools: {
    register(definition: { name: string }): unknown {
      expect(definition.name).toBe("meeting");
      return undefined;
    },
  },
  webServer: { register: () => undefined },
  storageDomain: { open: async () => meetingDomain },
  collabTeam: team,
  collabPersonas: personas,
  subagents,
  get(key: string): unknown {
    const services: Record<string, unknown> = {
      collabPersonas: personas,
      subagents,
      workspaceRegistry: workspaces,
      collabTeam: team,
    };
    return services[key];
  },
  inject(
    keys: readonly string[],
    callback: (child: unknown) => void,
  ): { dispose(): void } {
    expect(keys.length).toBeGreaterThan(0);
    const child = {
      collabEmployee: undefined,
      collabTeam: team,
    };
    callback(child);
    return { dispose: () => undefined };
  },
} as unknown as MeetingContext;

describe("dsh-collab-meeting host contract", () => {
  it("H1 locks the 0.2.2 activation signature", async () => {
    expectTypeOf<MeetingContext["subagents"]>().toEqualTypeOf<
      SubagentsRuntimeLike | undefined
    >();
    const resolved = context.get("subagents");
    expect(resolved).toBe(subagents);

    const run = await resolved.startActivation({
      provider: "spawn",
      label: "meeting-worker:Contract Worker",
      prompt: [{ type: "text", text: "contract" }],
      parent: { id: "meeting-agent" },
      signal: new AbortController().signal,
      delivery: "caller",
    });
    expect(run.id).toBe("meeting-worker-run");
    await expect(run.result).resolves.toMatchObject({
      stopReason: "completed",
    });
  });

  it("H2 exposes persona and optional collaboration integrations", async () => {
    expect(context.get("collabPersonas")).toBe(personas);
    expect(context.get("collabTasks")).toBeUndefined();
    expect(context.get("collabTaskDispatch")).toBeUndefined();
    expect(context.get("collabPrincipal")).toBeUndefined();
    expect(await personas.get("persona")).toMatchObject({
      name: "Contract Persona",
    });
  });

  it("H3 exposes the workspace registry", () => {
    expect(context.get("workspaceRegistry")).toBe(workspaces);
    expect(workspaces.get("workspace")?.path).toBe("/tmp/workspace");
  });

  it("H4 opens the meeting storage domain", async () => {
    const domain = await context.storageDomain.open(meetingDomainSpec);
    expect(domain.table("meetings").get("missing")).toBeUndefined();
    expect(domain.table("participants").get("missing")).toBeUndefined();
    await domain.close();
  });

  it("H5 accepts consumed cross-plugin event names", () => {
    const dispose = context.on("collab/task-changed", () => undefined);
    expect(typeof dispose).toBe("function");
    context.on("collab/agent-run-settled", () => undefined);
    expect(events.map((event) => event.event)).toEqual([
      "collab/task-changed",
      "collab/agent-run-settled",
    ]);
  });

  it("H6 invokes provide, inject, and effect lifecycle hooks", () => {
    const services = [
      new MeetingService(
        meetingDomain.table("meetings"),
        meetingDomain.table("participants"),
        meetingDomain.table("messages"),
      ) as unknown,
      {} as unknown,
      {} as unknown,
      {} as unknown,
      {} as unknown,
      {} as unknown,
      {} as unknown,
    ];
    const keys = [
      "collabMeeting",
      "collabMeetingMinutes",
      "collabMeetingMinutesRuntime",
      "collabMeetingDelegates",
      "collabMeetingReads",
      "collabMeetingFiles",
      "collabMeetingTasks",
    ] as const;
    keys.forEach((key, index) => {
      context.provide(key, services[index]);
    });
    expect(provided).toEqual([...keys]);

    expect(() =>
      context.inject(["collabTeam"], (child) => {
        expect(
          child.collabTeam.resolveToken("contract-token")?.userId,
        ).toBe("user");
      }),
    ).not.toThrow();
    expect(() =>
      context.inject(["collabEmployee"], () => undefined),
    ).not.toThrow();
    expect(() =>
      context.effect(() => () => {
        effects.push(() => undefined);
      }),
    ).not.toThrow();
    effects.pop()?.();
  });
});
