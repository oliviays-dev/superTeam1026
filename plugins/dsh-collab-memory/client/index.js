window.__ModuleLoader__.load({
  id: "dsh-collab-memory",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const h = react.createElement;

    const TOKEN_KEY = "pluginmax.collab.token";

    const request = async (path, init) => {
      const token = window.localStorage.getItem(TOKEN_KEY) ?? "";
      const response = await fetch(path, {
        ...init,
        headers: {
          ...(init?.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
          ...init?.headers,
        },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        throw new Error(body.error?.message ?? `请求失败 (${response.status})`);
      }
      return body;
    };

    const style = {
      section: { display: "grid", gap: 12, maxWidth: 1180 },
      toolbar: {
        alignItems: "center",
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
      },
      select: {
        background: "var(--dsw-alias-bg-layer-1)",
        border:
          "1px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2))",
        borderRadius: 6,
        color: "inherit",
        minHeight: 32,
        padding: "0 9px",
      },
      button: {
        background: "var(--dsw-alias-bg-layer-1)",
        border:
          "1px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2))",
        borderRadius: 6,
        color: "inherit",
        cursor: "pointer",
        minHeight: 30,
        padding: "0 10px",
      },
      buttonActive: {
        background: "var(--dsw-alias-brand-primary)",
        borderColor: "var(--dsw-alias-brand-primary)",
        color: "var(--dsw-alias-label-on-primary, #fff)",
      },
      grid: {
        display: "grid",
        gap: 12,
        gridTemplateColumns: "minmax(250px, 320px) minmax(0, 1fr)",
      },
      list: {
        alignContent: "start",
        background: "var(--dsw-alias-bg-layer-1)",
        border:
          "1px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2))",
        borderRadius: 7,
        display: "grid",
        gap: 5,
        maxHeight: 620,
        overflow: "auto",
        padding: 7,
      },
      row: {
        background: "transparent",
        border: "1px solid transparent",
        borderRadius: 6,
        color: "inherit",
        cursor: "pointer",
        display: "grid",
        gap: 5,
        padding: "9px 10px",
        textAlign: "left",
        width: "100%",
      },
      rowActive: {
        background: "var(--dsw-alias-bg-layer-2)",
        borderColor: "var(--dsw-alias-brand-primary)",
      },
      panel: {
        background: "var(--dsw-alias-bg-layer-1)",
        border:
          "1px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2))",
        borderRadius: 7,
        display: "grid",
        gap: 12,
        minHeight: 300,
        padding: 14,
      },
      meta: {
        color: "var(--dsw-alias-label-secondary)",
        fontSize: 12,
      },
      chip: {
        border:
          "1px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2))",
        borderRadius: 999,
        display: "inline-flex",
        fontSize: 11,
        lineHeight: "20px",
        padding: "0 8px",
      },
      textarea: {
        background: "var(--dsw-alias-bg-layer-2)",
        border:
          "1px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2))",
        borderRadius: 6,
        color: "inherit",
        minHeight: 72,
        padding: 8,
        resize: "vertical",
      },
      actions: { display: "flex", flexWrap: "wrap", gap: 8 },
      code: {
        background: "var(--dsw-alias-bg-layer-2)",
        borderRadius: 5,
        fontSize: 11,
        maxHeight: 180,
        overflow: "auto",
        padding: 8,
        whiteSpace: "pre-wrap",
      },
    };

    const statusColor = (status) =>
      status === "pending" || status === "failed" || status === "processing"
        ? "var(--dsw-alias-label-warning)"
        : status === "unrecoverable"
          ? "var(--dsw-alias-label-error)"
        : status === "approved" || status === "completed"
          ? "var(--dsw-alias-label-success)"
          : "var(--dsw-alias-label-secondary)";
    const jobStatusLabel = (status) =>
      status === "unrecoverable" ? "不可重放" : status;

    function MemoryReviewSection() {
      const [workspaces, setWorkspaces] = react.useState([]);
      const [workspaceId, setWorkspaceId] = react.useState("");
      const [view, setView] = react.useState("review");
      const [reviews, setReviews] = react.useState([]);
      const [jobs, setJobs] = react.useState([]);
      const [selectedId, setSelectedId] = react.useState("");
      const [note, setNote] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState("");
      const selected =
        reviews.find((item) => item.review.id === selectedId) ?? reviews[0];

      const load = react.useCallback(async () => {
        if (workspaceId === "") return;
        setError("");
        const query = new URLSearchParams({ workspaceId });
        const [reviewResult, ingestResult] = await Promise.all([
          request(`/api/collab/memory/review?${query}`),
          request(`/api/collab/memory/ingest?${query}`),
        ]);
        const nextReviews = reviewResult.reviews ?? [];
        setReviews(nextReviews);
        setJobs(ingestResult.jobs ?? []);
        setSelectedId((current) =>
          nextReviews.some((item) => item.review.id === current)
            ? current
            : (nextReviews[0]?.review.id ?? ""),
        );
      }, [workspaceId]);

      react.useEffect(() => {
        let disposed = false;
        void request("/api/collab/team/workspaces")
          .then((result) => {
            if (disposed) return;
            const list = result.workspaces ?? [];
            setWorkspaces(list);
            setWorkspaceId((current) => current || list[0]?.id || "");
          })
          .catch((cause) => {
            if (!disposed) setError(cause.message);
          });
        return () => {
          disposed = true;
        };
      }, []);

      react.useEffect(() => {
        let disposed = false;
        void load().catch((cause) => {
          if (!disposed) setError(cause.message);
        });
        return () => {
          disposed = true;
        };
      }, [load]);

      const decide = async (decision) => {
        if (selected === undefined) return;
        setBusy(true);
        setError("");
        try {
          await request("/api/collab/memory/review/decide", {
            method: "POST",
            body: JSON.stringify({
              workspaceId,
              reviewId: selected.review.id,
              decision,
              ...(note.trim() === "" ? {} : { note: note.trim() }),
            }),
          });
          setNote("");
          await load();
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy(false);
        }
      };

      const retryIngest = async () => {
        setBusy(true);
        setError("");
        try {
          await request("/api/collab/memory/ingest/retry", {
            method: "POST",
            body: JSON.stringify({ workspaceId }),
          });
          await load();
        } catch (cause) {
          setError(cause.message);
        } finally {
          setBusy(false);
        }
      };
      const retryableJobs = jobs.filter(
        (job) => job.status === "failed" && job.payload !== undefined,
      );

      return h("section", { style: style.section }, [
        h("div", { key: "head", style: { display: "grid", gap: 3 } }, [
          h("h2", { key: "title", style: { margin: 0 }, children: "上下文记忆" }),
          h("div", {
            key: "desc",
            style: style.meta,
            children:
              "审核自动抽取的候选记忆，并检查语义抽取任务的执行状态。",
          }),
        ]),
        h("div", { key: "toolbar", style: style.toolbar }, [
          h(
            "select",
            {
              key: "workspace",
              style: style.select,
              value: workspaceId,
              "aria-label": "记忆管理项目",
              onChange: (event) => setWorkspaceId(event.target.value),
            },
            ...workspaces.map((workspace) =>
              h("option", {
                key: workspace.id,
                value: workspace.id,
                children: workspace.title ?? workspace.id,
              }),
            ),
          ),
          h(
            "button",
            {
              key: "review",
              type: "button",
              style: Object.assign(
                {},
                style.button,
                view === "review" ? style.buttonActive : {},
              ),
              onClick: () => setView("review"),
            },
            `待审核 ${reviews.filter((item) => item.review.status === "pending").length}`,
          ),
          h(
            "button",
            {
              key: "ingest",
              type: "button",
              style: Object.assign(
                {},
                style.button,
                view === "ingest" ? style.buttonActive : {},
              ),
              onClick: () => setView("ingest"),
            },
            `抽取任务 ${jobs.length}`,
          ),
          h("button", {
            key: "refresh",
            type: "button",
            style: style.button,
            disabled: busy,
            onClick: () => void load(),
            children: "刷新",
          }),
        ]),
        error === ""
          ? null
          : h("div", {
              role: "alert",
              style: { color: "var(--dsw-alias-label-error)", fontSize: 12 },
              children: error,
            }),
        view === "review"
          ? h("div", { style: style.grid }, [
              h(
                "div",
                { key: "list", style: style.list },
                reviews.length === 0
                  ? h("div", {
                      style: Object.assign({}, style.meta, { padding: 12 }),
                      children: "当前没有记忆审核项。",
                    })
                  : null,
                ...reviews.map((item) =>
                  h(
                    "button",
                    {
                      key: item.review.id,
                      type: "button",
                      style: Object.assign(
                        {},
                        style.row,
                        item.review.id === (selected?.review.id ?? selectedId)
                          ? style.rowActive
                          : {},
                      ),
                      onClick: () => setSelectedId(item.review.id),
                    },
                    h("strong", {
                      children: item.topic?.title ?? item.review.reason,
                    }),
                    h("span", {
                      style: style.meta,
                      children: item.claim?.statement ?? item.review.reason,
                    }),
                    h("span", {
                      style: Object.assign({}, style.chip, {
                        color: statusColor(item.review.status),
                        justifySelf: "start",
                      }),
                      children: item.review.status,
                    }),
                  ),
                ),
              ),
              h(
                "div",
                { key: "detail", style: style.panel },
                selected === undefined
                  ? h("div", {
                      style: style.meta,
                      children: "选择审核项查看 Claim 与来源。",
                    })
                  : h("div", { style: { display: "grid", gap: 12 } }, [
                      h("div", { key: "head", style: { display: "grid", gap: 4 } }, [
                        h("strong", {
                          children:
                            selected.topic?.title ?? selected.review.reason,
                        }),
                        h("span", {
                          style: style.meta,
                          children: `${selected.review.reason} · ${new Date(selected.review.createdAt).toLocaleString()}`,
                        }),
                      ]),
                      selected.claim === undefined
                        ? null
                        : h("div", { key: "claim", style: { display: "grid", gap: 7 } }, [
                            h("div", { style: style.meta, children: "候选 Claim" }),
                            h("div", {
                              style: { lineHeight: 1.65 },
                              children: selected.claim.statement,
                            }),
                            h("div", {
                              style: style.meta,
                              children: `${selected.claim.kind} · confidence ${selected.claim.confidence.toFixed(2)} · ${selected.claim.publication}`,
                            }),
                            h("div", {
                              style: style.code,
                              children: selected.claim.sourceRefs
                                .map(
                                  (ref) =>
                                    `${ref.type}:${ref.id}${ref.version ? `@${ref.version}` : ""}${ref.quote ? `\n${ref.quote}` : ""}`,
                                )
                                .join("\n"),
                            }),
                          ]),
                      selected.truth === undefined
                        ? null
                        : h("div", {
                            key: "truth",
                            style: {
                              borderTop:
                                "1px solid var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2))",
                              display: "grid",
                              gap: 5,
                              paddingTop: 10,
                            },
                          }, [
                            h("div", {
                              style: style.meta,
                              children: `当前真相 · ${selected.truth.status}`,
                            }),
                            h("div", {
                              children:
                                selected.truth.statement ??
                                (selected.truth.claims.length === 0
                                  ? "该主题当前没有可执行结论。"
                                  : selected.truth.claims
                                      .map(
                                        (claim) =>
                                          `[${claim.kind}] ${claim.statement}`,
                                      )
                                      .join("\n")),
                            }),
                          ]),
                      h("textarea", {
                        key: "note",
                        style: style.textarea,
                        value: note,
                        placeholder: "审核备注（可选）",
                        "aria-label": "记忆审核备注",
                        onChange: (event) => setNote(event.target.value),
                      }),
                      h("div", { key: "actions", style: style.actions }, [
                        h("button", {
                          type: "button",
                          style: style.button,
                          disabled:
                            busy ||
                            selected.review.status !== "pending" ||
                            !selected.canDecide,
                          onClick: () => void decide("approved"),
                          children: "通过",
                        }),
                        h("button", {
                          type: "button",
                          style: style.button,
                          disabled:
                            busy ||
                            selected.review.status !== "pending" ||
                            !selected.canDecide,
                          onClick: () => void decide("rejected"),
                          children: "驳回",
                        }),
                        h("button", {
                          type: "button",
                          style: style.button,
                          disabled:
                            busy ||
                            selected.review.status !== "pending" ||
                            !selected.canDecide,
                          onClick: () => void decide("superseded"),
                          children: "标记已被替代",
                        }),
                      ]),
                      selected.review.status !== "pending"
                        ? h("div", {
                            key: "decided",
                            style: style.meta,
                            children:
                              "该审核项已处理；如需调整结论，请发起新的人工修正。",
                          })
                        : !selected.canDecide
                        ? h("div", {
                            key: "readonly",
                            style: style.meta,
                            children:
                              "当前账号只能查看该项目审核项，不能作出决定。",
                          })
                        : null,
                    ]),
              ),
            ])
          : h("div", { style: { display: "grid", gap: 10 } }, [
              h("div", { key: "toolbar", style: style.toolbar }, [
                h("span", {
                  style: style.meta,
                  children: `可重试 ${retryableJobs.length} · 不可重放 ${jobs.filter((job) => job.status === "unrecoverable").length} · 排队 ${jobs.filter((job) => job.status === "queued").length}`,
                }),
                h("button", {
                  type: "button",
                  style: style.button,
                  disabled: busy || retryableJobs.length === 0,
                  onClick: () => void retryIngest(),
                  children: `重试失败任务 ${retryableJobs.length}`,
                }),
              ]),
              ...jobs.map((job) =>
                h("div", {
                  key: job.id,
                  style: style.panel,
                }, [
                  h("div", { key: "head", style: style.toolbar }, [
                    h("strong", {
                      children: `${job.sourceType}:${job.sourceId}`,
                    }),
                    h("span", {
                      style: Object.assign({}, style.chip, {
                        color: statusColor(job.status),
                      }),
                      children: jobStatusLabel(job.status),
                    }),
                    h("span", {
                      style: style.meta,
                      children: `attempts ${job.attempts}`,
                    }),
                  ]),
                  h("div", {
                    key: "meta",
                    style: style.meta,
                    children: `${job.version} · ${new Date(job.updatedAt).toLocaleString()}`,
                  }),
                  job.error
                    ? h("div", {
                        key: "error",
                        style: style.code,
                        children: job.error,
                      })
                    : null,
                ]),
              ),
              jobs.length === 0
                ? h("div", {
                    style: style.meta,
                    children: "当前项目没有语义抽取任务。",
                  })
                : null,
            ]),
      ]);
    }

    exports.inject = ["slots"];
    exports.apply = (ctx) =>
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "pluginmax-context-memory",
            order: 78,
            label: () => "上下文记忆",
            inject: () => ({}),
          },
          () => h(MemoryReviewSection),
        ),
      );

    return module.exports;
  },
});
