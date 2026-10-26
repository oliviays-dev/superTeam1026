import type {
  ProjectTemplate,
  ProjectTemplateAccessPolicy,
  TemplateRole,
  TemplateRoleCategory,
  TemplateRolePermission,
  WorkflowTemplate,
} from "@pluginmax/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  Check,
  Copy,
  History,
  LoaderCircle,
  Plus,
  Save,
  Search,
  Shield,
  Trash2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  ApiRequestError,
  archiveProjectTemplate,
  copyProjectTemplate,
  createProjectTemplate,
  createTemplateRole,
  deleteTemplateRole,
  listProjectTemplateHistory,
  listProjectTemplates,
  listTemplateRoles,
  listWorkflowTemplates,
  updateProjectTemplate,
  updateTemplateRole,
} from "./api.js";

const categoryLabels: Record<TemplateRoleCategory, string> = {
  management: "管理",
  execution: "执行",
  review: "评审",
  approval: "审批",
  planning: "计划",
  procurement: "采购",
  support: "支持",
};

const permissionLabels: Record<TemplateRolePermission, string> = {
  read: "查看",
  write: "编辑",
  approve: "审批",
  manage_members: "成员管理",
  manage_roles: "角色管理",
};

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "template_revision_conflict") {
      return "模版已被其他管理员更新。当前草稿仍保留，请刷新后重新确认版本。";
    }
    if (error.code === "template_role_in_use") {
      const details = error.details as
        { templateNames?: string[]; projectRoleCount?: number } | undefined;
      const templates = details?.templateNames?.join("、");
      return [
        "角色仍被引用，不能删除。",
        templates === undefined || templates === ""
          ? ""
          : `引用模版：${templates}。`,
        details?.projectRoleCount === undefined ||
        details.projectRoleCount === 0
          ? ""
          : `已物化项目角色：${details.projectRoleCount} 个。`,
      ]
        .filter(Boolean)
        .join(" ");
    }
    if (error.code === "project_template_in_use") {
      return "模版已物化项目，不能归档。已有项目会继续保留自身角色和工作流副本。";
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "操作失败";
}

function newTemplateCode(): string {
  return `TPL-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

function newRoleCode(): string {
  return `ROLE_${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

export function ProjectTemplatesView({
  onBack,
}: {
  readonly onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [pane, setPane] = useState<"templates" | "roles">("templates");
  const [search, setSearch] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [creatingRole, setCreatingRole] = useState(false);
  const templatesQuery = useQuery({
    queryKey: ["project-templates", "admin"],
    queryFn: () => listProjectTemplates(true),
  });
  const rolesQuery = useQuery({
    queryKey: ["template-roles", "all"],
    queryFn: () => listTemplateRoles(true),
  });
  const workflowsQuery = useQuery({
    queryKey: ["workflow-templates", "available"],
    queryFn: listWorkflowTemplates,
  });
  const historyQuery = useQuery({
    queryKey: ["project-template-history", selectedTemplateId],
    queryFn: () => listProjectTemplateHistory(selectedTemplateId),
    enabled:
      !creatingTemplate &&
      selectedTemplateId !== "" &&
      templatesQuery.data !== undefined,
  });
  const templates = templatesQuery.data ?? [];
  const roles = rolesQuery.data ?? [];
  const workflows = workflowsQuery.data ?? [];
  const selectedTemplate = templates.find(
    (template) => template.id === selectedTemplateId,
  );
  const selectedRole = roles.find((role) => role.id === selectedRoleId);
  const filteredTemplates = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query === ""
      ? templates
      : templates.filter(
          (template) =>
            template.name.toLocaleLowerCase().includes(query) ||
            template.code.toLocaleLowerCase().includes(query),
        );
  }, [search, templates]);

  useEffect(() => {
    if (
      !creatingTemplate &&
      selectedTemplateId === "" &&
      templates[0] !== undefined
    ) {
      setSelectedTemplateId(templates[0].id);
    }
  }, [creatingTemplate, selectedTemplateId, templates]);

  useEffect(() => {
    if (!creatingRole && selectedRoleId === "" && roles[0] !== undefined) {
      setSelectedRoleId(roles[0].id);
    }
  }, [creatingRole, roles, selectedRoleId]);

  const refreshTemplates = async (template?: ProjectTemplate) => {
    await queryClient.invalidateQueries({ queryKey: ["project-templates"] });
    if (template !== undefined) setSelectedTemplateId(template.id);
  };

  const loading =
    templatesQuery.isLoading ||
    rolesQuery.isLoading ||
    workflowsQuery.isLoading;
  const error =
    templatesQuery.error ?? rolesQuery.error ?? workflowsQuery.error;

  return (
    <main className="pm-page template-admin-page">
      <header className="pm-page-head template-admin-head">
        <div className="template-title-group">
          <button
            className="pm-icon-btn"
            type="button"
            aria-label="返回项目"
            title="返回项目"
            onClick={onBack}
          >
            <ArrowLeft size={15} />
          </button>
          <div>
            <h1>项目模版维护</h1>
            <p>平台管理员维护可复用项目定义、角色库和工作流引用。</p>
          </div>
        </div>
        <div className="pm-tabs">
          <button
            className={pane === "templates" ? "active" : ""}
            type="button"
            onClick={() => setPane("templates")}
          >
            项目模版
          </button>
          <button
            className={pane === "roles" ? "active" : ""}
            type="button"
            onClick={() => setPane("roles")}
          >
            角色库
          </button>
        </div>
      </header>

      {loading && (
        <div className="template-state">
          <LoaderCircle className="spin" size={18} />
          正在加载模版与角色库…
        </div>
      )}
      {error !== null && (
        <div className="pm-error">
          {errorText(error)}
          <button
            className="pm-btn secondary small"
            type="button"
            onClick={() => {
              void templatesQuery.refetch();
              void rolesQuery.refetch();
              void workflowsQuery.refetch();
            }}
          >
            重试
          </button>
        </div>
      )}

      {!loading && error === null && pane === "templates" && (
        <div className="template-admin-grid">
          <aside className="template-directory pm-panel">
            <div className="template-directory-head">
              <label className="pm-search">
                <Search size={14} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索项目模版"
                />
              </label>
              <button
                className="pm-btn primary small"
                type="button"
                onClick={() => {
                  setCreatingTemplate(true);
                  setSelectedTemplateId("");
                  setSearch("");
                }}
              >
                <Plus size={14} />
                新建模版
              </button>
            </div>
            <div className="template-directory-list">
              {filteredTemplates.map((template) => (
                <button
                  className={`template-directory-row ${
                    template.id === selectedTemplateId ? "active" : ""
                  }`}
                  type="button"
                  key={template.id}
                  onClick={() => {
                    setCreatingTemplate(false);
                    setSelectedTemplateId(template.id);
                  }}
                >
                  <span>
                    <strong>{template.name}</strong>
                    <small>{template.code}</small>
                  </span>
                  <span
                    className={`pm-pill ${
                      template.status === "active" ? "active" : "archived"
                    }`}
                  >
                    {template.status === "active" ? "启用" : "已归档"}
                  </span>
                </button>
              ))}
              {filteredTemplates.length === 0 && (
                <div className="pm-empty compact">
                  {search === ""
                    ? "当前还没有项目模版。点击「新建模版」开始维护。"
                    : "没有匹配的项目模版。"}
                </div>
              )}
            </div>
          </aside>

          <section className="template-detail pm-panel">
            {(creatingTemplate || selectedTemplate !== undefined) && (
              <TemplateEditor
                key={
                  creatingTemplate
                    ? "new-template"
                    : `${selectedTemplate?.id}:${selectedTemplate?.revision}`
                }
                template={creatingTemplate ? undefined : selectedTemplate}
                roles={roles}
                workflows={workflows}
                history={historyQuery.data ?? []}
                historyLoading={historyQuery.isLoading}
                onSaved={(saved) => {
                  setCreatingTemplate(false);
                  void refreshTemplates(saved);
                  void queryClient.invalidateQueries({
                    queryKey: ["project-template-history", saved.id],
                  });
                }}
                onSelectTemplate={(id) => {
                  setCreatingTemplate(false);
                  setSelectedTemplateId(id);
                }}
                onArchive={() => {
                  setCreatingTemplate(false);
                  setSelectedTemplateId("");
                  void refreshTemplates();
                }}
              />
            )}
            {!creatingTemplate && selectedTemplate === undefined && (
              <div className="pm-empty">
                选择左侧模版查看 revision、角色集合和工作流引用。
              </div>
            )}
          </section>
        </div>
      )}

      {!loading && error === null && pane === "roles" && (
        <div className="template-admin-grid">
          <aside className="template-directory pm-panel">
            <div className="template-directory-head">
              <div>
                <strong>角色库</strong>
                <small>模版素材 · {roles.length}</small>
              </div>
              <button
                className="pm-btn primary small"
                type="button"
                onClick={() => {
                  setCreatingRole(true);
                  setSelectedRoleId("");
                }}
              >
                <Plus size={14} />
                新建角色
              </button>
            </div>
            <div className="template-directory-list">
              {roles.map((role) => (
                <button
                  className={`template-directory-row ${
                    role.id === selectedRoleId ? "active" : ""
                  }`}
                  type="button"
                  key={role.id}
                  onClick={() => {
                    setCreatingRole(false);
                    setSelectedRoleId(role.id);
                  }}
                >
                  <span>
                    <strong>{role.name}</strong>
                    <small>
                      {role.code} · {categoryLabels[role.category]}
                    </small>
                  </span>
                  <span className="pm-pill neutral">v{role.revision}</span>
                </button>
              ))}
              {roles.length === 0 && (
                <div className="pm-empty compact">
                  当前角色库为空。先新建角色，再配置项目模版。
                </div>
              )}
            </div>
          </aside>
          <section className="template-detail pm-panel">
            {(creatingRole || selectedRole !== undefined) && (
              <RoleEditor
                key={
                  creatingRole
                    ? "new-role"
                    : `${selectedRole?.id}:${selectedRole?.revision}`
                }
                role={creatingRole ? undefined : selectedRole}
                onSaved={(role) => {
                  setCreatingRole(false);
                  setSelectedRoleId(role.id);
                  void queryClient.invalidateQueries({
                    queryKey: ["template-roles"],
                  });
                  void queryClient.invalidateQueries({
                    queryKey: ["project-templates"],
                  });
                }}
                onDeleted={() => {
                  setCreatingRole(false);
                  setSelectedRoleId("");
                  void queryClient.invalidateQueries({
                    queryKey: ["template-roles"],
                  });
                }}
              />
            )}
            {!creatingRole && selectedRole === undefined && (
              <div className="pm-empty">选择角色查看权限和引用影响。</div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function TemplateEditor({
  template,
  roles,
  workflows,
  history,
  historyLoading,
  onSaved,
  onSelectTemplate,
  onArchive,
}: {
  readonly template?: ProjectTemplate | undefined;
  readonly roles: TemplateRole[];
  readonly workflows: WorkflowTemplate[];
  readonly history: Awaited<ReturnType<typeof listProjectTemplateHistory>>;
  readonly historyLoading: boolean;
  readonly onSaved: (template: ProjectTemplate) => void;
  readonly onSelectTemplate: (id: string) => void;
  readonly onArchive: () => void;
}) {
  const queryClient = useQueryClient();
  const archived = template?.status === "archived";
  const [name, setName] = useState(template?.name ?? "");
  const [code, setCode] = useState(template?.code ?? newTemplateCode());
  const [type, setType] = useState(template?.type ?? "通用类");
  const [description, setDescription] = useState(template?.description ?? "");
  const [roleIds, setRoleIds] = useState<string[]>(
    template?.roles.map((role) => role.id) ?? [],
  );
  const [ownerRoleId, setOwnerRoleId] = useState(template?.ownerRoleId ?? "");
  const [workflowIds, setWorkflowIds] = useState<string[]>(
    template?.workflowTemplates.map((item) => item.workflowTemplateId) ?? [],
  );
  const [accessPolicy, setAccessPolicy] = useState<ProjectTemplateAccessPolicy>(
    template?.accessPolicy ?? "all-members",
  );
  const [allowedActorIds, setAllowedActorIds] = useState(
    template?.allowedActorIds.join(", ") ?? "",
  );
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyName, setCopyName] = useState(
    template === undefined ? "" : `${template.name}（副本）`,
  );
  const [copyCode, setCopyCode] = useState(
    template === undefined ? "" : `${template.code}-COPY`,
  );
  const [message, setMessage] = useState("");
  const saveMutation = useMutation({
    mutationFn: async () => {
      const common = {
        name,
        code,
        type,
        description,
        roleIds,
        ...(ownerRoleId === "" ? { ownerRoleId: null } : { ownerRoleId }),
        workflowTemplates: workflows
          .filter((workflow) => workflowIds.includes(workflow.id))
          .map((workflow) => ({
            workflowTemplateId: workflow.id,
            expectedVersion: workflow.version,
          })),
        accessPolicy,
        allowedActorIds: allowedActorIds
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      };
      if (template === undefined) {
        return createProjectTemplate({
          ...common,
          ownerRoleId: ownerRoleId === "" ? undefined : ownerRoleId,
        });
      }
      return updateProjectTemplate(template.id, {
        ...common,
        expectedRevision: template.revision,
      });
    },
    onSuccess: (saved) => {
      setMessage("模版已保存。");
      onSaved(saved);
    },
  });
  const copyMutation = useMutation({
    mutationFn: () =>
      copyProjectTemplate(template!.id, {
        name: copyName,
        code: copyCode,
      }),
    onSuccess: (saved) => {
      setCopyOpen(false);
      onSaved(saved);
      onSelectTemplate(saved.id);
      void queryClient.invalidateQueries({
        queryKey: ["project-templates"],
      });
    },
  });
  const archiveMutation = useMutation({
    mutationFn: () =>
      archiveProjectTemplate(template!.id, {
        expectedRevision: template!.revision,
        reason: "平台管理员归档",
      }),
    onSuccess: onArchive,
  });
  const activeRoles = roles.filter((role) => role.status === "active");
  const activeWorkflows = workflows.filter(
    (workflow) => workflow.status === "active",
  );
  const readOnly = archived || saveMutation.isPending;

  return (
    <div className="template-editor">
      <header className="template-editor-head">
        <div>
          <h2>{template?.name ?? "新建项目模版"}</h2>
          <div className="template-meta-line">
            {template !== undefined && (
              <>
                <span className={`pm-pill ${archived ? "archived" : "active"}`}>
                  {archived ? "只读 · 已归档" : "启用"}
                </span>
                <span>revision {template.revision}</span>
                <span>{template.materializedProjectCount} 个项目已物化</span>
              </>
            )}
            {template === undefined && <span>新 revision 将从 1 开始</span>}
          </div>
        </div>
        {template !== undefined && !archived && (
          <div className="pm-head-actions">
            <button
              className="pm-btn secondary small"
              type="button"
              onClick={() => setCopyOpen((open) => !open)}
            >
              <Copy size={14} />
              复制
            </button>
            <button
              className="pm-btn danger small"
              type="button"
              disabled={archiveMutation.isPending}
              onClick={() => {
                if (window.confirm(`归档项目模版「${template.name}」？`)) {
                  archiveMutation.mutate();
                }
              }}
            >
              {archiveMutation.isPending ? (
                <LoaderCircle className="spin" size={14} />
              ) : (
                <Archive size={14} />
              )}
              归档
            </button>
          </div>
        )}
      </header>

      {copyOpen && template !== undefined && (
        <div className="template-inline-form">
          <label>
            <span>副本名称</span>
            <input
              value={copyName}
              onChange={(event) => setCopyName(event.target.value)}
            />
          </label>
          <label>
            <span>副本编码</span>
            <input
              value={copyCode}
              onChange={(event) =>
                setCopyCode(
                  event.target.value.toUpperCase().replace(/\s+/g, "-"),
                )
              }
            />
          </label>
          <button
            className="pm-btn primary small"
            type="button"
            disabled={copyMutation.isPending}
            onClick={() => copyMutation.mutate()}
          >
            创建副本
          </button>
        </div>
      )}

      <section className="template-section">
        <div className="template-section-head">
          <h3>基础信息</h3>
          <span>模版 revision {template?.revision ?? "—"}</span>
        </div>
        <div className="pm-form-grid">
          <label className="pm-field">
            <span>模版名称</span>
            <input
              value={name}
              disabled={readOnly}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="pm-field">
            <span>模版编码</span>
            <input
              value={code}
              disabled={readOnly}
              onChange={(event) =>
                setCode(event.target.value.toUpperCase().replace(/\s+/g, "-"))
              }
            />
          </label>
          <label className="pm-field">
            <span>项目类型</span>
            <input
              value={type}
              disabled={readOnly}
              onChange={(event) => setType(event.target.value)}
            />
          </label>
          <label className="pm-field">
            <span>使用范围</span>
            <select
              value={accessPolicy}
              disabled={readOnly}
              onChange={(event) =>
                setAccessPolicy(
                  event.target.value as ProjectTemplateAccessPolicy,
                )
              }
            >
              <option value="all-members">所有成员</option>
              <option value="selected-members">指定成员</option>
            </select>
          </label>
          {accessPolicy === "selected-members" && (
            <label className="pm-field pm-field-wide">
              <span>允许使用的账号 ID（逗号分隔）</span>
              <input
                value={allowedActorIds}
                disabled={readOnly}
                onChange={(event) => setAllowedActorIds(event.target.value)}
                placeholder="olivia, local-admin"
              />
            </label>
          )}
          <label className="pm-field pm-field-wide">
            <span>项目说明</span>
            <textarea
              rows={3}
              value={description}
              disabled={readOnly}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="template-section">
        <div className="template-section-head">
          <h3>预定义项目角色</h3>
          <span>{roleIds.length} 个</span>
        </div>
        <label className="pm-field">
          <span>项目负责人角色</span>
          <select
            value={ownerRoleId}
            disabled={readOnly}
            onChange={(event) => setOwnerRoleId(event.target.value)}
          >
            <option value="">自动选择</option>
            {activeRoles
              .filter((role) => roleIds.includes(role.id))
              .map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name} · {role.code}
                </option>
              ))}
          </select>
        </label>
        <div className="template-check-grid">
          {activeRoles.map((role) => (
            <label className="template-check" key={role.id}>
              <input
                type="checkbox"
                checked={roleIds.includes(role.id)}
                disabled={readOnly}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...roleIds, role.id]
                    : roleIds.filter((id) => id !== role.id);
                  setRoleIds(next);
                  if (ownerRoleId !== "" && !next.includes(ownerRoleId)) {
                    setOwnerRoleId("");
                  }
                }}
              />
              <span>
                <strong>{role.name}</strong>
                <small>{role.code}</small>
              </span>
            </label>
          ))}
          {activeRoles.length === 0 && (
            <div className="pm-empty compact">
              当前角色库为空。先到「角色库」创建角色。
            </div>
          )}
        </div>
      </section>

      <section className="template-section">
        <div className="template-section-head">
          <h3>预定义工作流</h3>
          <span>{workflowIds.length} 个稳定引用</span>
        </div>
        <div className="template-check-grid">
          {activeWorkflows.map((workflow) => (
            <label className="template-check" key={workflow.id}>
              <input
                type="checkbox"
                checked={workflowIds.includes(workflow.id)}
                disabled={readOnly}
                onChange={(event) =>
                  setWorkflowIds((current) =>
                    event.target.checked
                      ? [...new Set([...current, workflow.id])]
                      : current.filter((id) => id !== workflow.id),
                  )
                }
              />
              <span>
                <strong>{workflow.name}</strong>
                <small>
                  {workflow.key} · v{workflow.version}
                </small>
              </span>
            </label>
          ))}
          {activeWorkflows.length === 0 && (
            <div className="pm-empty compact">
              当前没有可引用的工作流模版。工作流本体由 Workflow 域维护。
            </div>
          )}
        </div>
        <div className="template-domain-note">
          <WorkflowIcon size={14} />
          项目模版只保存工作流模版的稳定引用和版本快照。
        </div>
      </section>

      {(saveMutation.error !== null ||
        copyMutation.error !== null ||
        archiveMutation.error !== null) && (
        <div className="pm-error">
          {errorText(
            saveMutation.error ?? copyMutation.error ?? archiveMutation.error,
          )}
          <button
            className="pm-btn secondary small"
            type="button"
            onClick={() => {
              void queryClient.invalidateQueries({
                queryKey: ["project-templates"],
              });
            }}
          >
            刷新最新版本
          </button>
        </div>
      )}
      {message !== "" && <div className="template-success">{message}</div>}
      {!archived && (
        <div className="template-save-bar">
          <span>
            预定义角色 {roleIds.length} · 工作流引用 {workflowIds.length}
          </span>
          <button
            className="pm-btn primary"
            type="button"
            disabled={
              saveMutation.isPending ||
              name.trim() === "" ||
              code.trim() === "" ||
              (accessPolicy === "selected-members" &&
                allowedActorIds.trim() === "")
            }
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? (
              <LoaderCircle className="spin" size={14} />
            ) : template === undefined ? (
              <Plus size={14} />
            ) : (
              <Save size={14} />
            )}
            {template === undefined ? "创建模版" : "保存模版"}
          </button>
        </div>
      )}

      {template !== undefined && (
        <section className="template-section template-history-section">
          <div className="template-section-head">
            <h3>
              <History size={14} />
              历史摘要
            </h3>
            <span>{history.length} 个 revision</span>
          </div>
          {historyLoading && (
            <div className="template-state">正在加载 revision…</div>
          )}
          <div className="template-history-list">
            {history.map((revision) => (
              <div className="template-history-row" key={revision.revision}>
                <b>v{revision.revision}</b>
                <span>
                  <strong>{revision.changeSummary}</strong>
                  <small>
                    {revision.actorId} · {revision.roleCount} 角色 ·{" "}
                    {revision.workflowCount} 工作流
                  </small>
                </span>
                <span
                  className={`pm-pill ${
                    revision.status === "active" ? "active" : "archived"
                  }`}
                >
                  {revision.status === "active" ? "启用" : "归档"}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function RoleEditor({
  role,
  onSaved,
  onDeleted,
}: {
  readonly role?: TemplateRole | undefined;
  readonly onSaved: (role: TemplateRole) => void;
  readonly onDeleted: () => void;
}) {
  const [code, setCode] = useState(role?.code ?? newRoleCode());
  const [name, setName] = useState(role?.name ?? "");
  const [category, setCategory] = useState<TemplateRoleCategory>(
    role?.category ?? "execution",
  );
  const [description, setDescription] = useState(role?.description ?? "");
  const [permissions, setPermissions] = useState<TemplateRolePermission[]>(
    role?.permissions ?? ["read"],
  );
  const saveMutation = useMutation({
    mutationFn: () => {
      const input = {
        code,
        name,
        category,
        description,
        permissions,
      };
      return role === undefined
        ? createTemplateRole(input)
        : updateTemplateRole(role.id, {
            ...input,
            expectedRevision: role.revision,
          });
    },
    onSuccess: onSaved,
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteTemplateRole(role!.id),
    onSuccess: onDeleted,
  });

  return (
    <div className="template-editor">
      <header className="template-editor-head">
        <div>
          <h2>{role?.name ?? "新建角色库角色"}</h2>
          <div className="template-meta-line">
            <span>
              {role === undefined ? "新角色" : `revision ${role.revision}`}
            </span>
            <span>角色库只作为模版素材，不直接授予项目成员。</span>
          </div>
        </div>
        {role !== undefined && (
          <button
            className="pm-btn danger small"
            type="button"
            disabled={deleteMutation.isPending}
            onClick={() => {
              if (window.confirm(`删除角色「${role.name}」？`)) {
                deleteMutation.mutate();
              }
            }}
          >
            {deleteMutation.isPending ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Trash2 size={14} />
            )}
            删除角色
          </button>
        )}
      </header>
      <div className="pm-form-grid">
        <label className="pm-field">
          <span>角色名称</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="pm-field">
          <span>角色标识</span>
          <input
            value={code}
            onChange={(event) =>
              setCode(event.target.value.toUpperCase().replace(/\s+/g, "_"))
            }
          />
        </label>
        <label className="pm-field">
          <span>角色分类</span>
          <select
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as TemplateRoleCategory)
            }
          >
            {(
              Object.entries(categoryLabels) as Array<
                [TemplateRoleCategory, string]
              >
            ).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="pm-field pm-field-wide">
          <span>角色说明</span>
          <textarea
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </div>
      <div className="template-section">
        <div className="template-section-head">
          <h3>
            <Shield size={14} />
            授权范围
          </h3>
          <span>{permissions.length} 项</span>
        </div>
        <div className="template-permission-list">
          {(
            Object.entries(permissionLabels) as Array<
              [TemplateRolePermission, string]
            >
          ).map(([permission, label]) => (
            <label className="template-check" key={permission}>
              <input
                type="checkbox"
                checked={permissions.includes(permission)}
                onChange={(event) =>
                  setPermissions((current) => {
                    if (event.target.checked) {
                      return [...new Set([...current, permission])];
                    }
                    const next = current.filter((item) => item !== permission);
                    return next.length === 0 ? current : next;
                  })
                }
              />
              <span>
                <strong>{label}</strong>
                <small>{permission}</small>
              </span>
            </label>
          ))}
        </div>
      </div>
      {(saveMutation.error !== null || deleteMutation.error !== null) && (
        <div className="pm-error">
          {errorText(saveMutation.error ?? deleteMutation.error)}
        </div>
      )}
      <div className="template-save-bar">
        <span>权限决定成员授权范围的只读汇总。</span>
        <button
          className="pm-btn primary"
          type="button"
          disabled={
            saveMutation.isPending ||
            name.trim() === "" ||
            code.trim() === "" ||
            permissions.length === 0
          }
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? (
            <LoaderCircle className="spin" size={14} />
          ) : role === undefined ? (
            <Plus size={14} />
          ) : (
            <Check size={14} />
          )}
          {role === undefined ? "创建角色" : "保存角色"}
        </button>
      </div>
    </div>
  );
}
