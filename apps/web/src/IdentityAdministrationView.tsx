import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  ScrollText,
  Search,
  ShieldCheck,
  UserCog,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AccountStatus,
  CredentialActivationResult,
  ManagedAccount,
  ManagedAccountDetail,
  PlatformRoleKey,
  RoleGrant,
  WorkspaceDetail,
  WorkspaceRoleKey,
} from "@pluginmax/contracts";
import {
  addWorkspaceMember,
  ApiRequestError,
  createManagedAccount,
  createPlatformGrant,
  createWorkspace,
  createWorkspaceGrant,
  getManagedAccount,
  getWorkspace,
  issueCredentialActivation,
  listIdentityAudit,
  listManagedAccounts,
  listPlatformGrants,
  listPlatformRoles,
  listWorkspaces,
  revokePlatformGrant,
  revokeWorkspaceGrant,
  setManagedAccountStatus,
  updateManagedAccount,
  updatePlatformGrantExpiry,
  updateWorkspace,
  updateWorkspaceGrantExpiry,
  updateWorkspaceMemberStatus,
} from "./api.js";

type IdentityPane = "accounts" | "platform" | "workspaces" | "audit";

interface IdentityAdministrationViewProps {
  readonly platformAdministrator: boolean;
  readonly viewerPrincipalId: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError)
    return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}

function dateTimeValue(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function optionalDate(value: string): string | null {
  return value === "" ? null : new Date(value).toISOString();
}

function statusLabel(status: ManagedAccount["status"]): string {
  return status === "active"
    ? "启用"
    : status === "pending"
      ? "待激活"
      : "停用";
}

function credentialLabel(status: ManagedAccount["credentialStatus"]): string {
  switch (status) {
    case "active":
      return "可用";
    case "pending":
      return "待激活";
    case "disabled":
      return "已停用";
    case "revoked":
      return "已撤销";
    case "missing":
      return "未初始化";
  }
}

function relativeDate(value: string | null): string {
  if (value === null) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function activationNotice(
  activation: CredentialActivationResult | null,
  onDismiss: () => void,
) {
  if (activation === null) return null;
  return (
    <section className="identity-secret-notice" role="status">
      <div>
        <strong>一次性激活凭据</strong>
        <p>
          仅显示一次，到期时间 {relativeDate(activation.expiresAt)}
          。通过安全渠道交付， 平台不保存明文，也不会写入审计。
        </p>
      </div>
      <code>{activation.activationToken}</code>
      <div>
        <button
          className="pm-btn secondary"
          type="button"
          onClick={() =>
            void navigator.clipboard.writeText(activation.activationToken)
          }
        >
          <Copy size={14} />
          复制
        </button>
        <button
          className="pm-icon-button"
          type="button"
          title="关闭"
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
      </div>
    </section>
  );
}

function AccountDirectory(props: { readonly platformAdministrator: boolean }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<AccountStatus | "">("");
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [activation, setActivation] =
    useState<CredentialActivationResult | null>(null);
  const [form, setForm] = useState({
    loginId: "",
    displayName: "",
    mode: "invitation" as "invitation" | "password",
    password: "",
    expiresInSeconds: "604800",
  });

  const accountsQuery = useQuery({
    queryKey: ["identity-admin", "accounts", search, status, cursor],
    queryFn: () =>
      listManagedAccounts({
        ...(search === "" ? {} : { query: search }),
        ...(status === "" ? {} : { status }),
        ...(cursor === undefined ? {} : { cursor }),
        limit: 25,
      }),
    enabled: props.platformAdministrator,
  });
  const effectiveSelectedId =
    selectedId || accountsQuery.data?.items[0]?.id || "";
  const detailQuery = useQuery({
    queryKey: ["identity-admin", "account", effectiveSelectedId],
    queryFn: () => getManagedAccount(effectiveSelectedId),
    enabled: props.platformAdministrator && effectiveSelectedId !== "",
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["identity-admin"] });
  };
  const createMutation = useMutation({
    mutationFn: () =>
      createManagedAccount({
        loginId: form.loginId.trim(),
        displayName: form.displayName.trim(),
        credential:
          form.mode === "invitation"
            ? {
                mode: "invitation",
                expiresInSeconds: Number(form.expiresInSeconds),
              }
            : { mode: "password", password: form.password },
      }),
    onSuccess: (result) => {
      setSelectedId(result.account.id);
      setActivation(result.activation);
      setCreating(false);
      setForm({
        loginId: "",
        displayName: "",
        mode: "invitation",
        password: "",
        expiresInSeconds: "604800",
      });
      refresh();
    },
  });
  const statusMutation = useMutation({
    mutationFn: (input: {
      account: ManagedAccount;
      status: "active" | "disabled";
    }) => setManagedAccountStatus(input.account.id, input.status),
    onSuccess: refresh,
  });
  const resetMutation = useMutation({
    mutationFn: (accountId: string) => issueCredentialActivation(accountId),
    onSuccess: (result) => {
      setActivation(result);
      refresh();
    },
  });
  const profileMutation = useMutation({
    mutationFn: (account: ManagedAccountDetail) =>
      updateManagedAccount(account.id, {
        displayName: account.displayName,
        loginId: account.loginId,
        expectedVersion: account.version,
      }),
    onSuccess: refresh,
  });

  if (!props.platformAdministrator) {
    return <div className="pm-empty">仅平台管理员可访问账号目录。</div>;
  }

  return (
    <div className="identity-pane">
      {activationNotice(activation, () => setActivation(null))}
      <div className="identity-toolbar">
        <label className="pm-search">
          <Search size={14} />
          <input
            value={search}
            placeholder="搜索登录 ID 或显示名"
            onChange={(event) => {
              setSearch(event.target.value);
              setCursor(undefined);
              setCursorStack([]);
            }}
          />
        </label>
        <select
          value={status}
          aria-label="账号状态"
          onChange={(event) => {
            setStatus(event.target.value as AccountStatus | "");
            setCursor(undefined);
            setCursorStack([]);
          }}
        >
          <option value="">全部状态</option>
          <option value="active">启用</option>
          <option value="pending">待激活</option>
          <option value="disabled">停用</option>
        </select>
        <button
          className="pm-btn primary"
          type="button"
          onClick={() => setCreating(true)}
        >
          <UserPlus size={14} />
          创建账号
        </button>
        <button
          className="pm-icon-button"
          type="button"
          title="刷新账号目录"
          onClick={() => void accountsQuery.refetch()}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {creating && (
        <section className="pm-panel identity-create-panel">
          <div className="pm-section-head">
            <div>
              <h2>创建 Human Principal 与登录账号</h2>
              <p>可直接设置初始密码，或签发仅显示一次的一次性激活凭据。</p>
            </div>
            <button
              className="pm-icon-button"
              type="button"
              title="关闭"
              onClick={() => setCreating(false)}
            >
              <X size={14} />
            </button>
          </div>
          <form
            className="identity-form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              createMutation.mutate();
            }}
          >
            <label className="pm-field">
              <span>登录 ID</span>
              <input
                value={form.loginId}
                required
                autoComplete="off"
                onChange={(event) =>
                  setForm({ ...form, loginId: event.target.value })
                }
              />
            </label>
            <label className="pm-field">
              <span>显示名</span>
              <input
                value={form.displayName}
                required
                onChange={(event) =>
                  setForm({ ...form, displayName: event.target.value })
                }
              />
            </label>
            <label className="pm-field">
              <span>凭据初始化</span>
              <select
                value={form.mode}
                onChange={(event) =>
                  setForm({
                    ...form,
                    mode: event.target.value as "invitation" | "password",
                  })
                }
              >
                <option value="invitation">一次性激活凭据</option>
                <option value="password">管理员设置初始密码</option>
              </select>
            </label>
            {form.mode === "invitation" ? (
              <label className="pm-field">
                <span>有效期（秒）</span>
                <input
                  type="number"
                  min={300}
                  max={2_592_000}
                  value={form.expiresInSeconds}
                  onChange={(event) =>
                    setForm({ ...form, expiresInSeconds: event.target.value })
                  }
                />
              </label>
            ) : (
              <label className="pm-field">
                <span>初始密码</span>
                <input
                  type="password"
                  minLength={8}
                  maxLength={256}
                  value={form.password}
                  autoComplete="new-password"
                  onChange={(event) =>
                    setForm({ ...form, password: event.target.value })
                  }
                />
              </label>
            )}
            {createMutation.isError && (
              <p className="form-error">{errorMessage(createMutation.error)}</p>
            )}
            <button
              className="pm-btn primary"
              type="submit"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <UserPlus size={14} />
              )}
              创建账号
            </button>
          </form>
        </section>
      )}

      <div className="identity-two-column">
        <aside className="pm-panel identity-directory">
          <header>
            <div>
              <strong>账号目录</strong>
              <small>{accountsQuery.data?.total ?? 0} 个结果</small>
            </div>
          </header>
          <div className="identity-directory-list">
            {accountsQuery.data?.items.map((account) => (
              <button
                className={effectiveSelectedId === account.id ? "active" : ""}
                type="button"
                key={account.id}
                onClick={() => setSelectedId(account.id)}
              >
                <span className="identity-avatar">
                  {account.displayName.slice(0, 2).toUpperCase()}
                </span>
                <span>
                  <strong>{account.displayName}</strong>
                  <small>{account.loginId}</small>
                </span>
                <span className={`pm-pill ${account.status}`}>
                  {statusLabel(account.status)}
                </span>
              </button>
            ))}
            {accountsQuery.isPending && (
              <div className="pm-empty compact">
                <LoaderCircle className="spin" size={15} />
                正在加载账号…
              </div>
            )}
            {accountsQuery.data?.items.length === 0 && (
              <div className="pm-empty compact">没有匹配的账号。</div>
            )}
          </div>
          <footer className="identity-pagination">
            <button
              className="pm-icon-button"
              type="button"
              disabled={cursorStack.length === 0}
              title="上一页"
              onClick={() => {
                const next = [...cursorStack];
                next.pop();
                setCursorStack(next);
                setCursor(next.at(-1));
              }}
            >
              <ChevronLeft size={14} />
            </button>
            <span>{cursorStack.length + 1}</span>
            <button
              className="pm-icon-button"
              type="button"
              disabled={
                accountsQuery.data?.nextCursor === null ||
                accountsQuery.data?.nextCursor === undefined
              }
              title="下一页"
              onClick={() => {
                const next = accountsQuery.data?.nextCursor;
                if (next === null || next === undefined) return;
                setCursorStack([...cursorStack, cursor ?? ""]);
                setCursor(next);
              }}
            >
              <ChevronRight size={14} />
            </button>
          </footer>
        </aside>

        <section className="pm-panel identity-detail">
          {detailQuery.data === undefined ? (
            <div className="pm-empty">
              {detailQuery.isPending
                ? "正在加载账号详情…"
                : "选择账号查看身份详情。"}
            </div>
          ) : (
            <AccountDetailPanel
              account={detailQuery.data}
              busy={statusMutation.isPending || resetMutation.isPending}
              onStatus={(next) =>
                statusMutation.mutate({
                  account: detailQuery.data,
                  status: next,
                })
              }
              onReset={() => resetMutation.mutate(detailQuery.data.id)}
              onSaveProfile={(account) => profileMutation.mutate(account)}
              profileError={
                profileMutation.isError
                  ? errorMessage(profileMutation.error)
                  : null
              }
              actionError={
                statusMutation.isError
                  ? errorMessage(statusMutation.error)
                  : resetMutation.isError
                    ? errorMessage(resetMutation.error)
                    : null
              }
            />
          )}
        </section>
      </div>
    </div>
  );
}

function AccountDetailPanel(props: {
  readonly account: ManagedAccountDetail;
  readonly busy: boolean;
  readonly onStatus: (status: "active" | "disabled") => void;
  readonly onReset: () => void;
  readonly onSaveProfile: (account: ManagedAccountDetail) => void;
  readonly profileError: string | null;
  readonly actionError: string | null;
}) {
  const [displayName, setDisplayName] = useState(props.account.displayName);
  const [loginId, setLoginId] = useState(props.account.loginId);
  useEffect(() => {
    setDisplayName(props.account.displayName);
    setLoginId(props.account.loginId);
  }, [props.account]);
  return (
    <div className="identity-detail-body">
      <header className="identity-detail-head">
        <div>
          <span className="identity-avatar large">
            {props.account.displayName.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <h2>{props.account.displayName}</h2>
            <p>
              {props.account.loginId} · {props.account.principalId}
            </p>
          </div>
        </div>
        <div className="identity-status-stack">
          <span className={`pm-pill ${props.account.status}`}>
            账号 {statusLabel(props.account.status)}
          </span>
          <span className={`pm-pill ${props.account.credentialStatus}`}>
            凭据 {credentialLabel(props.account.credentialStatus)}
          </span>
          <span className={`pm-pill ${props.account.principalStatus}`}>
            Principal {props.account.principalStatus}
          </span>
        </div>
      </header>
      <div className="identity-metrics">
        <div>
          <span>活跃会话</span>
          <strong>{props.account.activeSessionCount}</strong>
        </div>
        <div>
          <span>最近认证</span>
          <strong>{relativeDate(props.account.lastAuthenticatedAt)}</strong>
        </div>
        <div>
          <span>凭据到期</span>
          <strong>{relativeDate(props.account.credentialExpiresAt)}</strong>
        </div>
        <div>
          <span>账号版本</span>
          <strong>v{props.account.version}</strong>
        </div>
      </div>
      <form
        className="identity-form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSaveProfile({
            ...props.account,
            displayName: displayName.trim(),
            loginId: loginId.trim(),
          });
        }}
      >
        <label className="pm-field">
          <span>显示名</span>
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <label className="pm-field">
          <span>登录 ID</span>
          <input
            value={loginId}
            onChange={(event) => setLoginId(event.target.value)}
          />
        </label>
        <button className="pm-btn secondary" type="submit">
          <Save size={14} />
          保存资料
        </button>
      </form>
      {props.profileError !== null && (
        <p className="form-error">{props.profileError}</p>
      )}
      <div className="identity-action-row">
        {props.account.status === "disabled" ? (
          <button
            className="pm-btn secondary"
            type="button"
            disabled={props.busy}
            onClick={() => props.onStatus("active")}
          >
            <Check size={14} />
            启用账号
          </button>
        ) : (
          <button
            className="pm-btn secondary"
            type="button"
            disabled={props.busy}
            onClick={() => props.onStatus("disabled")}
          >
            <Archive size={14} />
            停用账号
          </button>
        )}
        <button
          className="pm-btn secondary"
          type="button"
          disabled={props.busy || props.account.status === "disabled"}
          onClick={props.onReset}
        >
          <KeyRound size={14} />
          签发重置凭据
        </button>
      </div>
      {props.actionError !== null && (
        <p className="form-error">{props.actionError}</p>
      )}
      <section className="identity-subsection">
        <header>
          <ShieldCheck size={14} />
          <strong>平台 Grant</strong>
          <b>{props.account.platformGrants.length}</b>
        </header>
        {props.account.platformGrants.map((grant) => (
          <div className="identity-grant-row" key={grant.id}>
            <span>{grant.roleKey}</span>
            <small>{grant.status}</small>
            <small>{relativeDate(grant.expiresAt)}</small>
          </div>
        ))}
      </section>
      <section className="identity-subsection">
        <header>
          <ScrollText size={14} />
          <strong>最近身份审计</strong>
          <b>{props.account.recentAudit.length}</b>
        </header>
        {props.account.recentAudit.slice(0, 8).map((event) => (
          <div className="identity-audit-row compact" key={event.id}>
            <span className={`pm-pill ${event.decision}`}>
              {event.decision}
            </span>
            <strong>{event.action}</strong>
            <small>{relativeDate(event.createdAt)}</small>
          </div>
        ))}
      </section>
    </div>
  );
}

function PlatformGrants(props: { readonly platformAdministrator: boolean }) {
  const queryClient = useQueryClient();
  const [principalId, setPrincipalId] = useState("");
  const [roleKey, setRoleKey] = useState<PlatformRoleKey>("MEMBER");
  const [expiresAt, setExpiresAt] = useState("");
  const [selectedGrant, setSelectedGrant] = useState<RoleGrant | null>(null);
  const rolesQuery = useQuery({
    queryKey: ["identity-admin", "platform-roles"],
    queryFn: listPlatformRoles,
    enabled: props.platformAdministrator,
  });
  const grantsQuery = useQuery({
    queryKey: ["identity-admin", "platform-grants"],
    queryFn: () => listPlatformGrants({ limit: 100 }),
    enabled: props.platformAdministrator,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["identity-admin"] });
  };
  const createMutation = useMutation({
    mutationFn: () =>
      createPlatformGrant({
        principalId: principalId.trim(),
        roleKey,
        expiresAt: optionalDate(expiresAt),
      }),
    onSuccess: () => {
      setPrincipalId("");
      setExpiresAt("");
      refresh();
    },
  });
  const expiryMutation = useMutation({
    mutationFn: (input: { grant: RoleGrant; expiresAt: string | null }) =>
      updatePlatformGrantExpiry(input.grant.id, {
        expiresAt: input.expiresAt,
        expectedVersion: input.grant.version,
      }),
    onSuccess: (updated) => {
      setSelectedGrant(updated);
      refresh();
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (grant: RoleGrant) =>
      revokePlatformGrant(grant.id, grant.version),
    onSuccess: (updated) => {
      setSelectedGrant(updated);
      refresh();
    },
  });
  if (!props.platformAdministrator) {
    return <div className="pm-empty">仅平台管理员可管理平台 Grant。</div>;
  }
  return (
    <div className="identity-two-column platform-grant-layout">
      <section className="pm-panel">
        <div className="pm-section-head">
          <div>
            <h2>平台角色</h2>
            <p>
              角色只产生平台权限，不会绕过 Project membership 和 Project Grant。
            </p>
          </div>
        </div>
        <div className="identity-role-list">
          {rolesQuery.data?.map((role) => (
            <article key={role.key}>
              <header>
                <strong>{role.displayName}</strong>
                <span>{role.activeGrantCount} active</span>
              </header>
              <p>{role.description}</p>
              <small>{role.permissions.join(" · ")}</small>
            </article>
          ))}
        </div>
        <form
          className="identity-form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            createMutation.mutate();
          }}
        >
          <label className="pm-field">
            <span>Principal ID</span>
            <input
              value={principalId}
              required
              onChange={(event) => setPrincipalId(event.target.value)}
            />
          </label>
          <label className="pm-field">
            <span>角色</span>
            <select
              value={roleKey}
              onChange={(event) =>
                setRoleKey(event.target.value as PlatformRoleKey)
              }
            >
              <option value="MEMBER">平台成员</option>
              <option value="ADMIN">平台管理员</option>
            </select>
          </label>
          <label className="pm-field">
            <span>到期时间（可选）</span>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </label>
          <button
            className="pm-btn primary"
            type="submit"
            disabled={createMutation.isPending}
          >
            <Plus size={14} />
            授予 Grant
          </button>
        </form>
        {createMutation.isError && (
          <p className="form-error">{errorMessage(createMutation.error)}</p>
        )}
      </section>
      <section className="pm-panel">
        <div className="pm-section-head">
          <div>
            <h2>平台 Grant</h2>
            <p>撤销与到期立即影响后续认证授权；历史记录只追加。</p>
          </div>
          <button
            className="pm-icon-button"
            type="button"
            title="刷新"
            onClick={() => void grantsQuery.refetch()}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="identity-grant-list">
          {grantsQuery.data?.items.map((grant) => (
            <button
              className={selectedGrant?.id === grant.id ? "active" : ""}
              type="button"
              key={grant.id}
              onClick={() => setSelectedGrant(grant)}
            >
              <span>
                <strong>{grant.principalId}</strong>
                <small>
                  {grant.roleKey} · 到期 {relativeDate(grant.expiresAt)}
                </small>
              </span>
              <span className={`pm-pill ${grant.status}`}>{grant.status}</span>
            </button>
          ))}
        </div>
        {selectedGrant !== null && selectedGrant.status === "active" && (
          <GrantEditor
            grant={selectedGrant}
            busy={expiryMutation.isPending || revokeMutation.isPending}
            error={
              expiryMutation.isError
                ? errorMessage(expiryMutation.error)
                : revokeMutation.isError
                  ? errorMessage(revokeMutation.error)
                  : null
            }
            onSave={(value) =>
              expiryMutation.mutate({ grant: selectedGrant, expiresAt: value })
            }
            onRevoke={() => revokeMutation.mutate(selectedGrant)}
          />
        )}
      </section>
    </div>
  );
}

function GrantEditor(props: {
  readonly grant: RoleGrant;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSave: (expiresAt: string | null) => void;
  readonly onRevoke: () => void;
}) {
  const [value, setValue] = useState(dateTimeValue(props.grant.expiresAt));
  useEffect(() => {
    setValue(dateTimeValue(props.grant.expiresAt));
  }, [props.grant]);
  return (
    <section className="identity-subsection">
      <header>
        <ShieldCheck size={14} />
        <strong>到期管理</strong>
        <small>v{props.grant.version}</small>
      </header>
      <div className="identity-action-row">
        <input
          type="datetime-local"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          className="pm-btn secondary"
          type="button"
          disabled={props.busy}
          onClick={() => props.onSave(optionalDate(value))}
        >
          <Save size={14} />
          更新到期
        </button>
        <button
          className="pm-btn secondary"
          type="button"
          disabled={props.busy}
          onClick={() => props.onSave(null)}
        >
          设为永久
        </button>
        <button
          className="pm-btn secondary danger"
          type="button"
          disabled={props.busy}
          onClick={props.onRevoke}
        >
          <X size={14} />
          撤销 Grant
        </button>
      </div>
      {props.error !== null && <p className="form-error">{props.error}</p>}
    </section>
  );
}

function WorkspaceAdministration(props: {
  readonly platformAdministrator: boolean;
  readonly viewerPrincipalId: string;
}) {
  const queryClient = useQueryClient();
  const [workspaceId, setWorkspaceId] = useState("");
  const [name, setName] = useState("");
  const [memberPrincipalId, setMemberPrincipalId] = useState("");
  const [grantPrincipalId, setGrantPrincipalId] = useState("");
  const [roleKey, setRoleKey] = useState<WorkspaceRoleKey>("MEMBER");
  const [expiresAt, setExpiresAt] = useState("");
  const [selectedGrantId, setSelectedGrantId] = useState("");
  const workspacesQuery = useQuery({
    queryKey: ["identity-admin", "workspaces"],
    queryFn: listWorkspaces,
  });
  const effectiveId = workspaceId || workspacesQuery.data?.[0]?.id || "";
  const detailQuery = useQuery({
    queryKey: ["identity-admin", "workspace", effectiveId],
    queryFn: () => getWorkspace(effectiveId),
    enabled: effectiveId !== "",
  });
  const currentMember = detailQuery.data?.members.find(
    (member) => member.principalId === props.viewerPrincipalId,
  );
  const canManage =
    props.platformAdministrator ||
    (currentMember?.status === "active" &&
      currentMember.grants.some(
        (grant) => grant.roleKey === "ADMIN" && grant.status === "active",
      ));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["identity-admin"] });
  };
  const createMutation = useMutation({
    mutationFn: () => createWorkspace({ displayName: name.trim() }),
    onSuccess: (detail) => {
      setWorkspaceId(detail.workspace.id);
      setName("");
      refresh();
    },
  });
  const memberMutation = useMutation({
    mutationFn: () => {
      if (detailQuery.data === undefined) throw new Error("Workspace missing");
      return addWorkspaceMember(detailQuery.data.workspace.id, {
        principalId: memberPrincipalId.trim(),
      });
    },
    onSuccess: () => {
      setMemberPrincipalId("");
      refresh();
    },
  });
  const grantMutation = useMutation({
    mutationFn: () => {
      if (detailQuery.data === undefined) throw new Error("Workspace missing");
      return createWorkspaceGrant(detailQuery.data.workspace.id, {
        principalId: grantPrincipalId.trim(),
        roleKey,
        expiresAt: optionalDate(expiresAt),
      });
    },
    onSuccess: () => {
      setGrantPrincipalId("");
      setExpiresAt("");
      refresh();
    },
  });
  const selectedWorkspaceGrant =
    detailQuery.data?.grants.find((grant) => grant.id === selectedGrantId) ??
    null;
  const grantExpiryMutation = useMutation({
    mutationFn: (input: { grant: RoleGrant; expiresAt: string | null }) => {
      if (detailQuery.data === undefined) throw new Error("Workspace missing");
      return updateWorkspaceGrantExpiry(
        detailQuery.data.workspace.id,
        input.grant.id,
        {
          expiresAt: input.expiresAt,
          expectedVersion: input.grant.version,
        },
      );
    },
    onSuccess: refresh,
  });
  const memberStatusMutation = useMutation({
    mutationFn: (input: {
      detail: WorkspaceDetail;
      memberId: string;
      status: "active" | "inactive";
      expectedVersion: number;
    }) =>
      updateWorkspaceMemberStatus(input.detail.workspace.id, input.memberId, {
        status: input.status,
        expectedVersion: input.expectedVersion,
      }),
    onSuccess: refresh,
  });
  const revokeMutation = useMutation({
    mutationFn: (input: { detail: WorkspaceDetail; grant: RoleGrant }) =>
      revokeWorkspaceGrant(
        input.detail.workspace.id,
        input.grant.id,
        input.grant.version,
      ),
    onSuccess: refresh,
  });
  const workspaceMutation = useMutation({
    mutationFn: (detail: WorkspaceDetail) =>
      updateWorkspace(detail.workspace.id, {
        status: detail.workspace.status === "active" ? "archived" : "active",
        expectedVersion: detail.workspace.version,
      }),
    onSuccess: refresh,
  });

  return (
    <div className="identity-two-column workspace-admin-layout">
      <aside className="pm-panel identity-directory">
        <header>
          <div>
            <strong>Workspace</strong>
            <small>{workspacesQuery.data?.length ?? 0} 个可见工作区</small>
          </div>
          <button
            className="pm-icon-button"
            type="button"
            title="刷新"
            onClick={() => void workspacesQuery.refetch()}
          >
            <RefreshCw size={14} />
          </button>
        </header>
        <div className="identity-directory-list">
          {workspacesQuery.data?.map((workspace) => (
            <button
              className={effectiveId === workspace.id ? "active" : ""}
              type="button"
              key={workspace.id}
              onClick={() => setWorkspaceId(workspace.id)}
            >
              <span className="identity-avatar">
                {workspace.displayName.slice(0, 2).toUpperCase()}
              </span>
              <span>
                <strong>{workspace.displayName}</strong>
                <small>
                  {workspace.memberCount} 成员 · {workspace.activeGrantCount}{" "}
                  Grant
                </small>
              </span>
              <span className={`pm-pill ${workspace.status}`}>
                {workspace.status}
              </span>
            </button>
          ))}
        </div>
        {props.platformAdministrator && (
          <form
            className="identity-compact-form"
            onSubmit={(event) => {
              event.preventDefault();
              createMutation.mutate();
            }}
          >
            <input
              value={name}
              placeholder="新 Workspace 名称"
              onChange={(event) => setName(event.target.value)}
            />
            <button
              className="pm-btn primary"
              type="submit"
              disabled={name.trim() === "" || createMutation.isPending}
            >
              <Plus size={14} />
              新建
            </button>
          </form>
        )}
        {createMutation.isError && (
          <p className="form-error">{errorMessage(createMutation.error)}</p>
        )}
      </aside>

      <section className="pm-panel identity-detail">
        {detailQuery.data === undefined ? (
          <div className="pm-empty">选择 Workspace 查看成员和 Grant。</div>
        ) : (
          <div className="identity-detail-body">
            <header className="identity-detail-head">
              <div>
                <span className="identity-avatar large">
                  {detailQuery.data.workspace.displayName
                    .slice(0, 2)
                    .toUpperCase()}
                </span>
                <div>
                  <h2>{detailQuery.data.workspace.displayName}</h2>
                  <p>{detailQuery.data.workspace.id}</p>
                </div>
              </div>
              <div className="identity-status-stack">
                <span
                  className={`pm-pill ${detailQuery.data.workspace.status}`}
                >
                  {detailQuery.data.workspace.status}
                </span>
                <span className="pm-pill neutral">
                  v{detailQuery.data.workspace.version}
                </span>
              </div>
            </header>
            {canManage && (
              <div className="identity-action-row">
                {detailQuery.data.workspace.status === "active" && (
                  <button
                    className="pm-btn secondary"
                    type="button"
                    disabled={workspaceMutation.isPending}
                    onClick={() => workspaceMutation.mutate(detailQuery.data)}
                  >
                    <Archive size={14} />
                    归档 Workspace
                  </button>
                )}
              </div>
            )}
            {workspaceMutation.isError && (
              <p className="form-error">
                {errorMessage(workspaceMutation.error)}
              </p>
            )}
            <div className="identity-workspace-forms">
              {canManage && (
                <form
                  className="identity-compact-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    memberMutation.mutate();
                  }}
                >
                  <label>
                    <span>添加成员</span>
                    <input
                      value={memberPrincipalId}
                      placeholder="Principal ID"
                      onChange={(event) =>
                        setMemberPrincipalId(event.target.value)
                      }
                    />
                  </label>
                  <button
                    className="pm-btn secondary"
                    type="submit"
                    disabled={
                      memberPrincipalId.trim() === "" ||
                      memberMutation.isPending
                    }
                  >
                    <UserPlus size={14} />
                    加入
                  </button>
                </form>
              )}
              {canManage && (
                <form
                  className="identity-compact-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    grantMutation.mutate();
                  }}
                >
                  <label>
                    <span>授予 Workspace Grant</span>
                    <input
                      value={grantPrincipalId}
                      placeholder="Principal ID"
                      onChange={(event) =>
                        setGrantPrincipalId(event.target.value)
                      }
                    />
                  </label>
                  <select
                    value={roleKey}
                    aria-label="Workspace 角色"
                    onChange={(event) =>
                      setRoleKey(event.target.value as WorkspaceRoleKey)
                    }
                  >
                    <option value="MEMBER">成员</option>
                    <option value="ADMIN">管理员</option>
                  </select>
                  <input
                    type="datetime-local"
                    value={expiresAt}
                    aria-label="Grant 到期时间"
                    onChange={(event) => setExpiresAt(event.target.value)}
                  />
                  <button
                    className="pm-btn primary"
                    type="submit"
                    disabled={
                      grantPrincipalId.trim() === "" || grantMutation.isPending
                    }
                  >
                    <ShieldCheck size={14} />
                    授予
                  </button>
                </form>
              )}
              {memberMutation.isError && (
                <p className="form-error">
                  {errorMessage(memberMutation.error)}
                </p>
              )}
              {grantMutation.isError && (
                <p className="form-error">
                  {errorMessage(grantMutation.error)}
                </p>
              )}
            </div>
            <section className="identity-subsection">
              <header>
                <Users size={14} />
                <strong>成员</strong>
                <b>{detailQuery.data.members.length}</b>
              </header>
              <div className="identity-member-list">
                {detailQuery.data.members.map((member) => (
                  <article key={member.id}>
                    <span className="identity-avatar">
                      {member.displayName.slice(0, 2).toUpperCase()}
                    </span>
                    <div>
                      <strong>{member.displayName}</strong>
                      <small>
                        {member.principalId} · {member.principalKind}
                      </small>
                      <div className="identity-grant-chips">
                        {member.grants.map((grant) => (
                          <span
                            className={`pm-pill ${grant.status}`}
                            key={grant.id}
                          >
                            {grant.roleKey}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="identity-member-actions">
                      <span className={`pm-pill ${member.status}`}>
                        {member.status}
                      </span>
                      {canManage && (
                        <button
                          className="pm-btn secondary small"
                          type="button"
                          disabled={memberStatusMutation.isPending}
                          onClick={() =>
                            memberStatusMutation.mutate({
                              detail: detailQuery.data,
                              memberId: member.id,
                              status:
                                member.status === "active"
                                  ? "inactive"
                                  : "active",
                              expectedVersion: member.version,
                            })
                          }
                        >
                          {member.status === "active" ? "停用成员" : "恢复成员"}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
            <section className="identity-subsection">
              <header>
                <ShieldCheck size={14} />
                <strong>Workspace Grant</strong>
                <b>{detailQuery.data.grants.length}</b>
              </header>
              <div className="identity-grant-list">
                {detailQuery.data.grants.map((grant) => (
                  <article key={grant.id}>
                    <span>
                      <strong>{grant.principalId}</strong>
                      <small>
                        {grant.roleKey} · 到期 {relativeDate(grant.expiresAt)}
                      </small>
                    </span>
                    <span className={`pm-pill ${grant.status}`}>
                      {grant.status}
                    </span>
                    {canManage && grant.status === "active" && (
                      <button
                        className="pm-btn secondary small"
                        type="button"
                        onClick={() => setSelectedGrantId(grant.id)}
                      >
                        到期管理
                      </button>
                    )}
                  </article>
                ))}
              </div>
              {canManage &&
                selectedWorkspaceGrant !== null &&
                selectedWorkspaceGrant.status === "active" && (
                  <GrantEditor
                    grant={selectedWorkspaceGrant}
                    busy={
                      grantExpiryMutation.isPending || revokeMutation.isPending
                    }
                    error={
                      grantExpiryMutation.isError
                        ? errorMessage(grantExpiryMutation.error)
                        : revokeMutation.isError
                          ? errorMessage(revokeMutation.error)
                          : null
                    }
                    onSave={(value) =>
                      grantExpiryMutation.mutate({
                        grant: selectedWorkspaceGrant,
                        expiresAt: value,
                      })
                    }
                    onRevoke={() =>
                      revokeMutation.mutate({
                        detail: detailQuery.data,
                        grant: selectedWorkspaceGrant,
                      })
                    }
                  />
                )}
              {memberStatusMutation.isError && (
                <p className="form-error">
                  {errorMessage(memberStatusMutation.error)}
                </p>
              )}
              {revokeMutation.isError && (
                <p className="form-error">
                  {errorMessage(revokeMutation.error)}
                </p>
              )}
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

function AuditDirectory() {
  const [action, setAction] = useState("");
  const [decision, setDecision] = useState<"" | "allowed" | "denied">("");
  const auditQuery = useQuery({
    queryKey: ["identity-admin", "audit", action, decision],
    queryFn: () =>
      listIdentityAudit({
        ...(action === "" ? {} : { action }),
        ...(decision === "" ? {} : { decision }),
        limit: 100,
      }),
  });
  return (
    <section className="pm-panel identity-audit-panel">
      <div className="identity-toolbar">
        <label className="pm-search">
          <Search size={14} />
          <input
            value={action}
            placeholder="过滤 action，例如 identity.account.created"
            onChange={(event) => setAction(event.target.value)}
          />
        </label>
        <select
          value={decision}
          aria-label="审计决策"
          onChange={(event) =>
            setDecision(event.target.value as "" | "allowed" | "denied")
          }
        >
          <option value="">全部结果</option>
          <option value="allowed">allowed</option>
          <option value="denied">denied</option>
        </select>
        <button
          className="pm-icon-button"
          type="button"
          title="刷新审计"
          onClick={() => void auditQuery.refetch()}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="identity-audit-table">
        <header>
          <span>时间</span>
          <span>结果</span>
          <span>Action</span>
          <span>Subject</span>
          <span>Actor</span>
          <span>原因</span>
        </header>
        {auditQuery.data?.items.map((event) => (
          <article key={event.id}>
            <span>{relativeDate(event.createdAt)}</span>
            <span className={`pm-pill ${event.decision}`}>
              {event.decision}
            </span>
            <strong>{event.action}</strong>
            <code>{event.subjectPrincipalId ?? event.accountId ?? "-"}</code>
            <code>{event.actorPrincipalId ?? "system"}</code>
            <small>{event.reason || "-"}</small>
          </article>
        ))}
      </div>
      {auditQuery.isPending && (
        <div className="pm-empty compact">正在加载身份审计…</div>
      )}
      {auditQuery.data?.items.length === 0 && (
        <div className="pm-empty compact">没有匹配的身份审计事件。</div>
      )}
      {auditQuery.isError && (
        <p className="form-error">{errorMessage(auditQuery.error)}</p>
      )}
    </section>
  );
}

export function IdentityAdministrationView(
  props: IdentityAdministrationViewProps,
) {
  const panes: ReadonlyArray<{
    key: IdentityPane;
    label: string;
    icon: typeof ShieldCheck;
    administratorOnly?: boolean;
  }> = [
    {
      key: "accounts",
      label: "账号目录",
      icon: UserCog,
      administratorOnly: true,
    },
    {
      key: "platform",
      label: "平台 Grant",
      icon: ShieldCheck,
      administratorOnly: true,
    },
    { key: "workspaces", label: "Workspace", icon: Users },
    {
      key: "audit",
      label: "身份审计",
      icon: ScrollText,
      administratorOnly: true,
    },
  ];
  const visiblePanes = panes.filter(
    (pane) => !pane.administratorOnly || props.platformAdministrator,
  );
  const [pane, setPane] = useState<IdentityPane>(
    visiblePanes[0]?.key ?? "workspaces",
  );
  return (
    <main className="pm-page identity-admin-page">
      <header className="pm-page-head identity-admin-head">
        <div>
          <h1>账号与权限</h1>
          <p>
            管理 Human Principal、Credential、平台 Grant、Workspace 和身份审计。
          </p>
        </div>
        <nav className="pm-tabs" aria-label="身份管理">
          {visiblePanes.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={pane === item.key ? "active" : ""}
                type="button"
                key={item.key}
                onClick={() => setPane(item.key)}
              >
                <Icon size={14} />
                {item.label}
              </button>
            );
          })}
        </nav>
      </header>
      {pane === "accounts" && (
        <AccountDirectory platformAdministrator={props.platformAdministrator} />
      )}
      {pane === "platform" && (
        <PlatformGrants platformAdministrator={props.platformAdministrator} />
      )}
      {pane === "workspaces" && (
        <WorkspaceAdministration
          platformAdministrator={props.platformAdministrator}
          viewerPrincipalId={props.viewerPrincipalId}
        />
      )}
      {pane === "audit" && <AuditDirectory />}
    </main>
  );
}
