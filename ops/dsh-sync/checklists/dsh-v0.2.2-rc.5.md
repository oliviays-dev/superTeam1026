# 迁移 Checklist：dsh-v0.2.2-rc.5

> 基线：CLI 0.1.3-alpha.1（快照）+ SDK 0.2.1-rc.3（npm）→ 目标：两者同为 0.2.2-rc.5
>
> 使用方式：Phase 1 执行时逐项勾选；全部完成后 release gate G1–G7 必须全绿。

## L1 — npm SDK API 层（`packages/agent-runtime`）

- [x] 锁定 `@deepseek-ai/dsh-sdk-client@0.2.2-rc.5`（package.json + pnpm-lock.yaml）
      （2026-11-22 经 `scripts/upgrade-upstream.sh` 完成，agent-runtime tsdown+dts 构建通过）
- [x] 核对 `DeepSeekHarness` 构造参数仍被接受：
      `dshBin / profile / dshHome / cwd / provider / model / maxTokens / requestTimeoutMs`
      （`packages/agent-runtime/src/dsh-sdk.ts`）
- [x] 核对 `run(instruction, { sessionId, onNotification })` 签名与
      `RunResult.finalResponse` 仍存在
- [x] 核对通知事件枚举未改名：
      `session.status / subagent.started / subagent.finished / session.event`
- [x] 核对 `session.event.type` 枚举未改名：
      `turn/start, turn/end, tool/call, tool/result`
- [x] `mapDshNotification` 改造为白名单 + 未知事件告警
      （未知 method 产出 progress 类 warning 事件，不再静默丢弃）
- [x] 核对 `harness.close()` 幂等语义

  （2026-11-23 C1–C6 由 `dsh-contract.test.ts` 验证；C7 保留给带 `DSH_BIN`
  的 smoke 阶段。`mapDshNotification` 另有 `dsh-sdk.test.ts` 覆盖。）

## L2 — CLI 子进程协议层（`DSH_BIN`）

- [ ] vendor 构建产物存在：`vendor/deepseek-harness/apps/cli/lib/bin.js`
- [ ] `DSH_BIN --version` 输出与 manifest.tag 一致（0.2.2-rc.5）
- [ ] `scripts/smoke.sh`、`scripts/install-profile.sh` 中的 DSH_BIN 路径仍有效
- [ ] 用 0.2.2-rc.5 CLI 完成一次 profile 初始化，确认 connection row 配置
      不受 0.2.1-rc.2 类静默破坏影响

## L3 — cordis 宿主服务层（`plugins/dsh-collab-*`）

- [ ] `dsh-collab-agent`：`ctx.get("subagents")` 适配 0.2.2 具名子代理 API
      （0.2.1 已删除 service 级 `start(provider, request)`，确认现用签名）
- [ ] `dsh-collab-agent`：AgentTeam 统一具名子代理迁移
- [ ] 检查各插件引用的技能名称与路径（0.2.2-rc.2 Creator 指引迁移项）
- [ ] 检查插件是否有自定义 Session 事件追加包装（0.2.2-rc.2 批量接口适配项）
- [ ] 检查账号通知相关插件逻辑（0.2.2-rc.2 通知调整迁移项）
- [ ] `ctx.on("agent/assistant-stream")` / `ctx.emit("agent-run-settled")`
      事件名在 0.2.2 宿主中仍有效

## L4 — 构建与依赖层

- [ ] vendor `pnpm install --frozen-lockfile` + `build` 通过
- [ ] Zod 4.6.6（宿主版本）与 workspace `zod: ^4` 回归：
      `packages/contracts` schema 测试全绿
- [ ] Office 原生工具变更不影响 `dsh-collab-*` 引用的工具面

## 验证（release gate）

- [x] G1 manifest 一致性四条规则全过
- [x] G2 gitlink = cliRef，lockfile 中 sdk-client = 0.2.2-rc.5
- [ ] G3 `./scripts/bootstrap.sh` 通过
- [x] G4/G5 契约测试落地并通过（可与本 checklist 并行开发）
      （2026-11-23 C1–C6/C4 白名单与三个插件 H1–H6 全绿；C7 待 smoke）
- [ ] G6 `pnpm check` 全绿
- [ ] G7 `./scripts/smoke.sh` 全绿
