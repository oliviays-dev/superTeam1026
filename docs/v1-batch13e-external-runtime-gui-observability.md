# V1 Batch 13E: External Runtime GUI & Run Observability

> 状态：已实现
>
> 分支：`feat/v1-batch13-external-agent-runtime`
>
> 基线：`1be50b71abebbbffde785b6dd0628e5e44391aa2`

## 交付范围

- Runtime 管理页展示当前状态、Runtime revision、Probe revision、active/total
  Binding 数量和治理事件。
- Runtime 可用性明确区分 archived、disabled、Probe pending、Probe failed 和
  Capability 快照未就绪；停用与归档保留影响确认。
- Runtime 列表/详情增加只读 `bindingCount` 与 `activeBindingCount` 投影，不改变
  Binding 数据模型、唯一约束或状态机。
- AI 伙伴页使用现有 Binding/Preflight API 提供独立的外部 Runtime 配置区。
  `Agent.runtime_kind` 只作为定义字段展示，不再暗示已绑定。
- Binding 区展示 active/disabled、Binding revision、Runtime revision、模型、
  sandbox、network、Runtime 状态和不可用原因。
- Preflight 支持 Workspace 标识、模型和 Capability 要求；成功展示 revision 与
  Envelope 摘要，失败展示稳定错误码和 remediation。
- Run 详情展示外部 Runtime 名称、Provider、观测 Provider、Protocol、Runtime /
  Binding revision、模型、Sandbox、Network、Capability、Session、Runtime version、
  spawn 状态与受限诊断。
- `codex-jsonl` 展示归一化 progress/tool 事件；`plain-text` 明确标记 final-only，
  不生成 plan/tool/step 投影。
- GUI 不读取 reasoning 正文、环境变量、完整 stdout/stderr 或非归一化敏感日志。

## 边界

- 所有写操作仍由 13A/13C API 执行 revision、权限和幂等校验。
- Preflight 仍由 13C 服务做状态、Probe、Capability、sandbox、network 和 workspace
  校验；GUI 只调用 API。
- Run 详情只读取 13D 已持久化的 Execution Snapshot 和归一化 RunEvent。
- 不实现 Provider Session resume。
- 不开放危险 sandbox、任意 shell 或浏览器侧进程启动。
- `x-pluginmax-actor` 仍是 V1 开发身份边界，不等价于正式认证。

## 测试

- GUI component tests：Binding/不可用原因、Preflight remediation、Runtime
  Capability revision、plain-text final-only 与 reasoning 不渲染。
- Playwright 使用 `packages/agent-runtime/test-fixtures/external-cli.mjs`，覆盖：
  - 未绑定、绑定成功、Preflight 失败和成功。
  - Runtime disabled、archived、Probe failed 的明确原因。
  - `plain-text` final-only Run。
  - `codex-jsonl` structured progress/tool、Session 与 Runtime version。
  - 桌面、900px、390px 无横向溢出。
- 13A-D 独立 PostgreSQL Vitest：9 个测试文件、49 个测试。
- PostgreSQL migration/audit smoke 与 API/Worker/Web 假 CLI smoke。

## 已知限制

- 第一版不自动恢复已启动的外部 Provider Session。
- `plain-text` 不提供结构化计划或工具事件，UI 只显示 final-only 声明和生命周期。
- Provider JSONL 字段变化仍需继续补充协议夹具与归一化映射。
- 绑定计数是管理读投影；不改变 Runtime revision，也不进入执行快照。
