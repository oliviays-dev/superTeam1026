import type {
  Agent,
  CreateProjectMemberInput,
  ProjectCapabilityFlags,
  ProjectMember,
  ProjectRole,
} from "@pluginmax/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Check,
  Edit3,
  LoaderCircle,
  Plus,
  Shield,
  ShieldCheck,
  Trash2,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  createProjectMember,
  createProjectRole,
  deleteProjectMember,
  deleteProjectRole,
  listProjectMembers,
  listProjectRoles,
  updateProjectMember,
  updateProjectRole,
} from "./api.js";

interface ProjectMembershipPanelProps {
  readonly projectId: string;
  readonly agents: Agent[];
  readonly capabilities?: ProjectCapabilityFlags | undefined;
}

type MemberEditor = "new" | string | null;
type RoleEditor = "new" | string | null;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function ProjectMembershipPanel({
  projectId,
  agents,
  capabilities,
}: ProjectMembershipPanelProps) {
  const queryClient = useQueryClient();
  const [memberEditor, setMemberEditor] = useState<MemberEditor>(null);
  const [roleEditor, setRoleEditor] = useState<RoleEditor>(null);
  const membersQuery = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => listProjectMembers(projectId),
  });
  const rolesQuery = useQuery({
    queryKey: ["project-roles", projectId],
    queryFn: () => listProjectRoles(projectId),
  });
  const members = membersQuery.data ?? [];
  const roles = rolesQuery.data ?? [];
  const availableAgents = useMemo(() => {
    const memberAgentIds = new Set(
      members
        .filter((member) => member.kind === "agent")
        .map((member) => member.actorId),
    );
    return agents.filter(
      (agent) => agent.status === "active" && !memberAgentIds.has(agent.id),
    );
  }, [agents, members]);
  const editingMember =
    memberEditor === null || memberEditor === "new"
      ? undefined
      : members.find((member) => member.id === memberEditor);
  const editingRole =
    roleEditor === null || roleEditor === "new"
      ? undefined
      : roles.find((role) => role.id === roleEditor);

  const refreshMembers = () => {
    void queryClient.invalidateQueries({
      queryKey: ["project-members", projectId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["project-roles", projectId],
    });
  };
  const memberDelete = useMutation({
    mutationFn: (memberId: string) => deleteProjectMember(projectId, memberId),
    onSuccess: refreshMembers,
  });
  const roleDelete = useMutation({
    mutationFn: (roleId: string) => deleteProjectRole(projectId, roleId),
    onSuccess: refreshMembers,
  });
  const activeMemberCount = members.filter(
    (member) => member.status === "active",
  ).length;
  const canManageMembers = capabilities?.manage_members ?? false;
  const canManageRoles = capabilities?.manage_roles ?? false;

  return (
    <section className="project-membership">
      <header className="membership-toolbar">
        <div>
          <strong>项目成员</strong>
          <span>
            {activeMemberCount} 位活跃成员 · {roles.length} 个项目角色
          </span>
        </div>
        <div className="membership-toolbar-actions">
          <button
            className="pm-btn secondary"
            type="button"
            disabled={!canManageRoles}
            onClick={() => setRoleEditor("new")}
          >
            <Shield size={14} />
            新建角色
          </button>
          <button
            className="pm-btn primary"
            type="button"
            title="添加项目成员"
            disabled={!canManageMembers}
            onClick={() => setMemberEditor("new")}
          >
            <Plus size={14} />
            添加成员
          </button>
        </div>
      </header>

      {(membersQuery.error !== null || rolesQuery.error !== null) && (
        <div className="pm-error">
          {errorMessage(
            membersQuery.error ?? rolesQuery.error,
            "读取项目成员失败",
          )}
        </div>
      )}
      {(memberDelete.error !== null || roleDelete.error !== null) && (
        <div className="pm-error">
          {errorMessage(
            memberDelete.error ?? roleDelete.error,
            "成员或角色操作失败",
          )}
        </div>
      )}

      <div className="membership-grid">
        <div className="membership-member-list">
          {members.map((member) => (
            <article
              className={`membership-member-row status-${member.status}`}
              key={member.id}
            >
              <span
                className={`membership-avatar ${member.kind}`}
                aria-hidden="true"
              >
                {member.owner ? (
                  <ShieldCheck size={16} />
                ) : member.kind === "agent" ? (
                  <Bot size={16} />
                ) : (
                  <UserRound size={16} />
                )}
              </span>
              <div className="membership-member-copy">
                <div>
                  <strong>{member.name}</strong>
                  {member.owner && <i className="pm-pill progress">Owner</i>}
                  {member.status === "inactive" && (
                    <i className="pm-pill cancelled">已停用</i>
                  )}
                </div>
                <p>{member.responsibility || "尚未填写职责说明"}</p>
                <div className="membership-role-chips">
                  {member.roles.map((role) => (
                    <span className="role-chip" key={role.id}>
                      {role.name}
                    </span>
                  ))}
                  {member.roles.length === 0 && <em>未分配角色</em>}
                </div>
              </div>
              <div className="membership-row-actions">
                <button
                  className="pm-icon-btn"
                  type="button"
                  title="编辑成员"
                  disabled={!canManageMembers}
                  onClick={() => setMemberEditor(member.id)}
                >
                  <Edit3 size={14} />
                </button>
                <button
                  className="pm-icon-btn"
                  type="button"
                  title={member.owner ? "Owner 不可移除" : "移除成员"}
                  disabled={
                    !canManageMembers || member.owner || memberDelete.isPending
                  }
                  onClick={() => {
                    if (
                      window.confirm(`确认将 ${member.name} 从项目中移除？`)
                    ) {
                      memberDelete.mutate(member.id);
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          ))}
          {!membersQuery.isLoading && members.length === 0 && (
            <div className="pm-empty compact">
              <UsersRound size={18} />
              当前项目还没有成员
            </div>
          )}
        </div>

        <aside className="membership-role-panel">
          <div className="membership-role-head">
            <div>
              <strong>角色库</strong>
              <span>供成员分配，后续可复用于任务与工作流派发</span>
            </div>
            <Shield size={15} />
          </div>
          <div className="membership-role-list">
            {roles.map((role) => {
              const assignedCount = members.filter((member) =>
                member.roles.some((item) => item.id === role.id),
              ).length;
              return (
                <div className="membership-role-row" key={role.id}>
                  <span>
                    <strong>{role.name}</strong>
                    <small>{assignedCount} 位成员</small>
                  </span>
                  <div>
                    <button
                      className="pm-icon-btn"
                      type="button"
                      title="编辑角色"
                      disabled={!canManageRoles}
                      onClick={() => setRoleEditor(role.id)}
                    >
                      <Edit3 size={13} />
                    </button>
                    <button
                      className="pm-icon-btn"
                      type="button"
                      title={
                        assignedCount === 0 ? "删除角色" : "角色仍被成员使用"
                      }
                      disabled={
                        !canManageRoles ||
                        assignedCount > 0 ||
                        roleDelete.isPending
                      }
                      onClick={() => {
                        if (window.confirm(`确认删除角色「${role.name}」？`)) {
                          roleDelete.mutate(role.id);
                        }
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
            {!rolesQuery.isLoading && roles.length === 0 && (
              <div className="pm-empty compact">尚未创建项目角色</div>
            )}
          </div>
        </aside>
      </div>

      {memberEditor !== null && (
        <MemberDialog
          projectId={projectId}
          roles={roles}
          agents={availableAgents}
          member={editingMember}
          onClose={() => setMemberEditor(null)}
          onSaved={() => {
            refreshMembers();
            setMemberEditor(null);
          }}
        />
      )}
      {roleEditor !== null && (
        <RoleDialog
          projectId={projectId}
          role={editingRole}
          onClose={() => setRoleEditor(null)}
          onSaved={() => {
            refreshMembers();
            setRoleEditor(null);
          }}
        />
      )}
    </section>
  );
}

function MemberDialog({
  projectId,
  roles,
  agents,
  member,
  onClose,
  onSaved,
}: {
  projectId: string;
  roles: ProjectRole[];
  agents: Agent[];
  member?: ProjectMember | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<"human" | "agent">(member?.kind ?? "agent");
  const [name, setName] = useState(member?.name ?? "");
  const [actorId, setActorId] = useState(
    member?.kind === "human" ? member.actorId : "",
  );
  const [agentId, setAgentId] = useState(
    member?.kind === "agent" ? member.actorId : (agents[0]?.id ?? ""),
  );
  const [responsibility, setResponsibility] = useState(
    member?.responsibility ?? "",
  );
  const [status, setStatus] = useState<ProjectMember["status"]>(
    member?.status ?? "active",
  );
  const [roleIds, setRoleIds] = useState<string[]>(
    member?.roles.map((role) => role.id) ?? [],
  );
  const mutation = useMutation({
    mutationFn: async () => {
      if (member === undefined) {
        const input: CreateProjectMemberInput =
          kind === "agent"
            ? {
                kind: "agent",
                agentId,
                responsibility,
                roleIds,
              }
            : {
                kind: "human",
                actorId,
                name,
                responsibility,
                roleIds,
              };
        if (kind === "agent" && agentId === "") {
          throw new Error("请选择 AI 成员");
        }
        if (kind === "human" && (name.trim() === "" || actorId.trim() === "")) {
          throw new Error("请填写成员名称和 Actor ID");
        }
        return createProjectMember(projectId, input);
      }
      return updateProjectMember(projectId, member.id, {
        responsibility,
        roleIds,
        ...(member.owner ? {} : { status }),
      });
    },
    onSuccess: onSaved,
  });
  const toggleRole = (roleId: string) => {
    setRoleIds((current) =>
      current.includes(roleId)
        ? current.filter((id) => id !== roleId)
        : [...current, roleId],
    );
  };

  return (
    <div className="pm-modal-layer" role="presentation">
      <form
        className="pm-modal membership-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <div className="pm-modal-head">
          <div>
            <h2>{member === undefined ? "添加项目成员" : "编辑项目成员"}</h2>
            <p>设置成员职责、项目角色和在项目中的状态。</p>
          </div>
          <button
            className="pm-icon-btn"
            type="button"
            title="关闭"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        <div className="pm-form-grid">
          {member !== undefined && member.kind === "agent" ? (
            <label className="pm-field pm-field-wide">
              <span>AI 伙伴</span>
              <input value={member.name} disabled />
            </label>
          ) : member !== undefined && member.kind === "human" ? (
            <label className="pm-field pm-field-wide">
              <span>成员</span>
              <input value={member.name} disabled />
            </label>
          ) : (
            <>
              <label className="pm-field">
                <span>成员类型</span>
                <select
                  value={kind}
                  onChange={(event) => {
                    const next = event.target.value as "human" | "agent";
                    setKind(next);
                  }}
                >
                  <option value="agent">AI 伙伴</option>
                  <option value="human">人类成员</option>
                </select>
              </label>
              {kind === "agent" ? (
                <label className="pm-field">
                  <span>AI 伙伴</span>
                  <select
                    autoFocus
                    value={agentId}
                    onChange={(event) => setAgentId(event.target.value)}
                  >
                    {agents.map((agent) => (
                      <option value={agent.id} key={agent.id}>
                        {agent.name} · {agent.runtimeKind}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <label className="pm-field">
                    <span>成员名称</span>
                    <input
                      autoFocus
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Reviewer"
                    />
                  </label>
                  <label className="pm-field pm-field-wide">
                    <span>Actor ID</span>
                    <input
                      value={actorId}
                      onChange={(event) => setActorId(event.target.value)}
                      placeholder="reviewer-1"
                    />
                  </label>
                </>
              )}
            </>
          )}
          <label className="pm-field pm-field-wide">
            <span>项目职责</span>
            <textarea
              rows={3}
              value={responsibility}
              onChange={(event) => setResponsibility(event.target.value)}
              placeholder="说明该成员在项目中的职责和边界"
            />
          </label>
          {member !== undefined && member.owner !== true && (
            <label className="pm-field">
              <span>成员状态</span>
              <select
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as ProjectMember["status"])
                }
              >
                <option value="active">活跃</option>
                <option value="inactive">停用</option>
              </select>
            </label>
          )}
        </div>
        <fieldset className="role-checkboxes">
          <legend>项目角色</legend>
          {roles.map((role) => (
            <label className="role-checkbox" key={role.id}>
              <input
                type="checkbox"
                checked={roleIds.includes(role.id)}
                onChange={() => toggleRole(role.id)}
              />
              <span>
                <strong>{role.name}</strong>
                {role.description && <small>{role.description}</small>}
              </span>
            </label>
          ))}
          {roles.length === 0 && <p>先在角色库中创建角色。</p>}
        </fieldset>
        {mutation.error !== null && (
          <div className="pm-error">
            {errorMessage(mutation.error, "保存项目成员失败")}
          </div>
        )}
        <div className="pm-modal-actions">
          <button className="pm-btn secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="pm-btn primary"
            type="submit"
            disabled={
              mutation.isPending ||
              (member === undefined &&
                ((kind === "agent" && agentId === "") ||
                  (kind === "human" &&
                    (name.trim() === "" || actorId.trim() === ""))))
            }
          >
            {mutation.isPending ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Check size={14} />
            )}
            保存成员
          </button>
        </div>
      </form>
    </div>
  );
}

function RoleDialog({
  projectId,
  role,
  onClose,
  onSaved,
}: {
  projectId: string;
  role?: ProjectRole | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const mutation = useMutation({
    mutationFn: () =>
      role === undefined
        ? createProjectRole(projectId, { name, description })
        : updateProjectRole(projectId, role.id, { name, description }),
    onSuccess: onSaved,
  });

  return (
    <div className="pm-modal-layer" role="presentation">
      <form
        className="pm-modal role-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== "") mutation.mutate();
        }}
      >
        <div className="pm-modal-head">
          <div>
            <h2>{role === undefined ? "新建项目角色" : "编辑项目角色"}</h2>
            <p>角色属于当前项目，可在成员、任务和工作流派发中复用。</p>
          </div>
          <button
            className="pm-icon-btn"
            type="button"
            title="关闭"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        <div className="pm-form-grid">
          <label className="pm-field pm-field-wide">
            <span>角色名称</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：供应链分析师"
            />
          </label>
          <label className="pm-field pm-field-wide">
            <span>角色说明</span>
            <textarea
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="说明该角色的职责和交付边界"
            />
          </label>
        </div>
        {mutation.error !== null && (
          <div className="pm-error">
            {errorMessage(mutation.error, "保存项目角色失败")}
          </div>
        )}
        <div className="pm-modal-actions">
          <button className="pm-btn secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="pm-btn primary"
            type="submit"
            disabled={mutation.isPending || name.trim() === ""}
          >
            {mutation.isPending ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Check size={14} />
            )}
            保存角色
          </button>
        </div>
      </form>
    </div>
  );
}
