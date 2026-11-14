import type {
  SharedSpaceEntry,
  SharedSpaceFileContent,
  SharedSpacePolicy,
  SharedSpacePolicyPermission,
  SharedSpaceVersion,
  Workspace,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Check,
  Download,
  File,
  FilePlus2,
  Folder,
  FolderPlus,
  History,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Unlock,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiRequestError,
  acquireSharedSpaceLock,
  archiveSharedSpaceFile,
  createGlobalWriteRequest,
  createSharedSpaceDirectory,
  createSharedSpacePolicy,
  decideSharedSpaceWriteRequest,
  downloadSharedSpaceFile,
  generateSharedSpaceDigest,
  getSharedSpaceWorkspace,
  listSharedSpaceAudit,
  listSharedSpaceDigests,
  listSharedSpaceFiles,
  listSharedSpaceLocks,
  listSharedSpacePolicies,
  listSharedSpaceVersions,
  listSharedSpaceWriteRequests,
  listWorkspaces,
  previewSharedSpacePolicy,
  readSharedSpaceFile,
  releaseSharedSpaceLock,
  revokeSharedSpacePolicy,
  updateSharedSpaceFile,
  uploadSharedSpaceFile,
} from "./api.js";

type SharedSpacePane = "files" | "policies" | "approvals" | "audit";

interface SharedSpaceViewProps {
  readonly viewerPrincipalId: string;
  readonly platformAdministrator: boolean;
}

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "shared_space_version_conflict") {
      return `版本冲突：${error.message}`;
    }
    if (error.code === "shared_space_lock_conflict") {
      return `锁冲突：${error.message}`;
    }
    return `${error.message} (${error.code})`;
  }
  return error instanceof Error ? error.message : String(error);
}

function bytesLabel(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function base64FromFile(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("文件读取失败"));
        return;
      }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function textContent(content: SharedSpaceFileContent): string {
  const bytes = Uint8Array.from(atob(content.contentBase64), (value) =>
    value.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

function base64FromText(value: string): string {
  return btoa(
    Array.from(new TextEncoder().encode(value), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );
}

function PolicyRow({
  policy,
  onRevoke,
}: {
  readonly policy: SharedSpacePolicy;
  readonly onRevoke: (policy: SharedSpacePolicy) => void;
}) {
  return (
    <article className="shared-policy-row">
      <div>
        <strong>{policy.pathPattern}</strong>
        <small>
          {policy.subjectKind} · {policy.subjectId}
        </small>
      </div>
      <div className="shared-policy-chips">
        <span className={`shared-effect ${policy.effect}`}>{policy.effect}</span>
        {policy.permissions.map((permission) => (
          <span key={permission}>{permission}</span>
        ))}
      </div>
      <button
        className="pm-icon-btn"
        type="button"
        title="撤销策略"
        onClick={() => onRevoke(policy)}
      >
        <X size={14} />
      </button>
    </article>
  );
}

export function SharedSpaceView({
  viewerPrincipalId,
  platformAdministrator,
}: SharedSpaceViewProps) {
  const queryClient = useQueryClient();
  const workspacesQuery = useQuery({
    queryKey: ["workspaces", "shared-space"],
    queryFn: listWorkspaces,
  });
  const [workspaceId, setWorkspaceId] = useState("");
  const effectiveWorkspaceId =
    workspaceId || workspacesQuery.data?.[0]?.id || "";
  const workspace = workspacesQuery.data?.find(
    (item) => item.id === effectiveWorkspaceId,
  );
  const [pane, setPane] = useState<SharedSpacePane>("files");
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<SharedSpaceFileContent | null>(null);
  const [previewDraft, setPreviewDraft] = useState("");
  const [versions, setVersions] = useState<SharedSpaceVersion[] | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<SharedSpaceEntry | null>(
    null,
  );
  const [notice, setNotice] = useState("");
  const [directoryPath, setDirectoryPath] = useState("");
  const [uploadPath, setUploadPath] = useState("");
  const [uploadName, setUploadName] = useState("");
  const [uploadMime, setUploadMime] = useState("text/markdown");
  const [uploadChoice, setUploadChoice] = useState<globalThis.File | null>(null);
  const [policyForm, setPolicyForm] = useState({
    subjectKind: "principal" as "principal" | "workspace-role",
    subjectId: viewerPrincipalId,
    pathPattern: "**",
    permissions: ["read", "write"] as SharedSpacePolicyPermission[],
    effect: "allow" as "allow" | "deny",
  });
  const [previewPrincipal, setPreviewPrincipal] = useState(viewerPrincipalId);
  const [previewPath, setPreviewPath] = useState("research/**");
  const [globalPath, setGlobalPath] = useState("reports/global-summary.md");
  const [globalName, setGlobalName] = useState("global-summary.md");
  const [globalPurpose, setGlobalPurpose] = useState("跨工作区共享摘要");
  const [globalFile, setGlobalFile] = useState<globalThis.File | null>(null);
  const [approvalBasis, setApprovalBasis] = useState(
    "已核对来源 Workspace、路径、摘要和用途",
  );
  const directoryInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPath("");
    setPreview(null);
    setVersions(null);
    setSelectedEntry(null);
  }, [effectiveWorkspaceId]);

  const spaceQuery = useQuery({
    queryKey: ["shared-space", effectiveWorkspaceId],
    queryFn: () => getSharedSpaceWorkspace(effectiveWorkspaceId),
    enabled: effectiveWorkspaceId !== "",
  });
  const filesQuery = useQuery({
    queryKey: ["shared-space", effectiveWorkspaceId, "files", path],
    queryFn: () =>
      listSharedSpaceFiles({ workspaceId: effectiveWorkspaceId, path }),
    enabled: effectiveWorkspaceId !== "",
  });
  const policiesQuery = useQuery({
    queryKey: ["shared-space", effectiveWorkspaceId, "policies"],
    queryFn: () => listSharedSpacePolicies(effectiveWorkspaceId),
    enabled: effectiveWorkspaceId !== "" && spaceQuery.data?.canManage === true,
  });
  const locksQuery = useQuery({
    queryKey: ["shared-space", effectiveWorkspaceId, "locks"],
    queryFn: () => listSharedSpaceLocks(effectiveWorkspaceId),
    enabled: effectiveWorkspaceId !== "",
  });
  const requestsQuery = useQuery({
    queryKey: ["shared-space", effectiveWorkspaceId, "requests"],
    queryFn: () => listSharedSpaceWriteRequests(effectiveWorkspaceId),
    enabled: effectiveWorkspaceId !== "" && spaceQuery.data?.canManage === true,
    refetchInterval: 5_000,
  });
  const auditQuery = useQuery({
    queryKey: ["shared-space", effectiveWorkspaceId, "audit"],
    queryFn: () =>
      listSharedSpaceAudit(effectiveWorkspaceId, { limit: 100 }),
    enabled: effectiveWorkspaceId !== "" && spaceQuery.data?.canManage === true,
  });
  const digestsQuery = useQuery({
    queryKey: ["shared-space", effectiveWorkspaceId, "digests"],
    queryFn: () => listSharedSpaceDigests(effectiveWorkspaceId),
    enabled: effectiveWorkspaceId !== "" && spaceQuery.data?.canManage === true,
  });

  const refreshFiles = () => {
    void queryClient.invalidateQueries({
      queryKey: ["shared-space", effectiveWorkspaceId],
    });
  };
  const directoryMutation = useMutation({
    mutationFn: () =>
      createSharedSpaceDirectory(effectiveWorkspaceId, {
        path: directoryPath,
      }),
    onSuccess: () => {
      setDirectoryPath("");
      refreshFiles();
    },
  });
  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (uploadChoice === null) throw new Error("请选择文件");
      return uploadSharedSpaceFile(effectiveWorkspaceId, {
        path: uploadPath,
        name: uploadName || uploadChoice.name,
        mimeType: uploadMime,
        contentBase64: await base64FromFile(uploadChoice),
        expectedVersion: 0,
      });
    },
    onSuccess: () => {
      setUploadPath("");
      setUploadName("");
      setUploadChoice(null);
      refreshFiles();
    },
  });
  const readMutation = useMutation({
    mutationFn: (entry: SharedSpaceEntry) =>
      readSharedSpaceFile(effectiveWorkspaceId, entry.id),
    onSuccess: (content) => {
      setPreview(content);
      setPreviewDraft(textContent(content));
    },
  });
  const updateMutation = useMutation({
    mutationFn: () => {
      if (preview === null) throw new Error("没有可编辑的文件");
      return updateSharedSpaceFile(
        effectiveWorkspaceId,
        preview.entry.id,
        {
          contentBase64: base64FromText(previewDraft),
          expectedVersion: preview.entry.currentVersion,
          mimeType: preview.entry.mimeType ?? "text/plain",
          lockId:
            preview.entry.currentLock?.ownerPrincipalId === viewerPrincipalId
              ? preview.entry.currentLock.id
              : null,
        },
      );
    },
    onSuccess: (entry) => {
      setPreview((current) =>
        current === null ? null : { ...current, entry },
      );
      setNotice(`已保存 v${entry.currentVersion}`);
      refreshFiles();
    },
  });
  const versionMutation = useMutation({
    mutationFn: (entry: SharedSpaceEntry) =>
      listSharedSpaceVersions(effectiveWorkspaceId, entry.id),
    onSuccess: setVersions,
  });
  const lockMutation = useMutation({
    mutationFn: (entry: SharedSpaceEntry) =>
      acquireSharedSpaceLock(effectiveWorkspaceId, {
        path: entry.path,
        mode: "exclusive",
        leaseSeconds: 900,
        sessionId: `browser:${viewerPrincipalId}`,
      }),
    onSuccess: () => {
      setNotice("已获取 15 分钟租约锁");
      refreshFiles();
    },
  });
  const releaseLockMutation = useMutation({
    mutationFn: (lockId: string) =>
      releaseSharedSpaceLock(effectiveWorkspaceId, lockId),
    onSuccess: () => {
      setNotice("锁已释放");
      refreshFiles();
    },
  });
  const policyMutation = useMutation({
    mutationFn: () =>
      createSharedSpacePolicy(effectiveWorkspaceId, {
        subjectKind: policyForm.subjectKind,
        subjectId: policyForm.subjectId,
        pathPattern: policyForm.pathPattern,
        permissions: policyForm.permissions,
        effect: policyForm.effect,
        expiresAt: null,
      }),
    onSuccess: () => {
      setNotice("路径策略已创建");
      refreshFiles();
    },
  });
  const revokePolicyMutation = useMutation({
    mutationFn: (policy: SharedSpacePolicy) =>
      revokeSharedSpacePolicy(
        effectiveWorkspaceId,
        policy.id,
        policy.version,
      ),
    onSuccess: refreshFiles,
  });
  const previewMutation = useMutation({
    mutationFn: () =>
      previewSharedSpacePolicy({
        workspaceId: effectiveWorkspaceId,
        principalId: previewPrincipal,
        path: previewPath,
      }),
  });
  const globalMutation = useMutation({
    mutationFn: async () => {
      if (globalFile === null) throw new Error("请选择全局写入文件");
      return createGlobalWriteRequest(effectiveWorkspaceId, {
        path: globalPath,
        name: globalName || globalFile.name,
        mimeType: "text/markdown",
        contentBase64: await base64FromFile(globalFile),
        expectedVersion: 0,
        purpose: globalPurpose,
        scope: "global",
        lockId: null,
      });
    },
    onSuccess: () => {
      setGlobalFile(null);
      setNotice("Global Write 已提交平台管理员审批");
      refreshFiles();
    },
  });
  const decisionMutation = useMutation({
    mutationFn: (input: {
      readonly requestId: string;
      readonly decision: "approve" | "reject";
    }) =>
      decideSharedSpaceWriteRequest(effectiveWorkspaceId, input.requestId, {
        decision: input.decision,
        basis: approvalBasis,
      }),
    onSuccess: refreshFiles,
  });
  const digestMutation = useMutation({
    mutationFn: () =>
      generateSharedSpaceDigest(effectiveWorkspaceId, {
        sceneSessionId: null,
      }),
    onSuccess: refreshFiles,
  });

  const pathSegments = useMemo(
    () => (path === "" ? [] : path.split("/")),
    [path],
  );
  const pendingRequests =
    requestsQuery.data?.filter((request) => request.status === "pending") ?? [];
  const locksByPath = new Map(
    locksQuery.data?.map((lock) => [lock.path, lock]) ?? [],
  );

  if (workspacesQuery.isLoading) {
    return (
      <main className="pm-page shared-space-page">
        <div className="pm-empty">
          <LoaderCircle className="spin" size={18} /> 正在加载 Workspace
        </div>
      </main>
    );
  }

  if ((workspacesQuery.data?.length ?? 0) === 0) {
    return (
      <main className="pm-page shared-space-page">
        <div className="pm-empty">
          <Folder size={20} />
          当前 Principal 尚无 Workspace 成员关系
        </div>
      </main>
    );
  }

  return (
    <main className="pm-page shared-space-page">
      <header className="shared-space-head">
        <div>
          <h1>共享空间</h1>
          <p>{workspace?.displayName ?? effectiveWorkspaceId}</p>
        </div>
        <div className="shared-space-head-actions">
          <select
            className="pm-compact-select"
            aria-label="选择 Workspace"
            value={effectiveWorkspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            {workspacesQuery.data?.map((item: Workspace) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </select>
          <span
            className={`shared-space-mode ${spaceQuery.data?.canWrite ? "writable" : ""}`}
          >
            {spaceQuery.data?.canWrite ? "受控写入" : "默认只读"}
          </span>
          <button
            className="pm-icon-btn"
            type="button"
            title="刷新共享空间"
            onClick={() =>
              void queryClient.invalidateQueries({
                queryKey: ["shared-space", effectiveWorkspaceId],
              })
            }
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      <nav className="pm-tabs shared-space-tabs" aria-label="共享空间视图">
        {(
          [
            ["files", "文件", Folder],
            ["policies", "策略", ShieldCheck],
            ["approvals", "审批", KeyRound],
            ["audit", "审计与摘要", History],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            className={pane === key ? "active" : ""}
            onClick={() => setPane(key)}
          >
            <Icon size={14} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {spaceQuery.isError && (
        <div className="pm-error">{errorText(spaceQuery.error)}</div>
      )}
      {notice !== "" && (
        <div className="shared-space-notice" role="status">
          <Check size={14} />
          {notice}
          <button type="button" onClick={() => setNotice("")}>
            <X size={13} />
          </button>
        </div>
      )}

      {pane === "files" && (
        <section className="shared-space-files">
          <div className="shared-breadcrumb" aria-label="目录路径">
            <button type="button" onClick={() => setPath("")}>
              根目录
            </button>
            {pathSegments.map((segment, index) => (
              <button
                type="button"
                key={`${segment}-${index}`}
                onClick={() => setPath(pathSegments.slice(0, index + 1).join("/"))}
              >
                {segment}
              </button>
            ))}
          </div>

          <div className="shared-file-toolbar">
            <form
              className="shared-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                directoryMutation.mutate();
              }}
            >
              <FolderPlus size={14} />
              <input
                ref={directoryInput}
                aria-label="新目录路径"
                value={directoryPath}
                placeholder={`${path === "" ? "" : `${path}/`}新目录`}
                onChange={(event) => setDirectoryPath(event.target.value)}
              />
              <button
                className="pm-btn secondary"
                type="submit"
                disabled={
                  !spaceQuery.data?.canWrite ||
                  directoryPath.trim() === "" ||
                  directoryMutation.isPending
                }
              >
                创建目录
              </button>
            </form>
            <form
              className="shared-upload-form"
              onSubmit={(event) => {
                event.preventDefault();
                uploadMutation.mutate();
              }}
            >
              <FilePlus2 size={14} />
              <input
                aria-label="上传路径"
                value={uploadPath}
                placeholder={`${path === "" ? "" : `${path}/`}文件路径.md`}
                onChange={(event) => setUploadPath(event.target.value)}
              />
              <label>
                <span>选择文件</span>
                <input
                  type="file"
                  onChange={(event) => {
                    const selected = event.target.files?.[0] ?? null;
                    setUploadChoice(selected);
                    if (selected !== null) {
                      setUploadName(selected.name);
                      setUploadMime(
                        selected.type || "application/octet-stream",
                      );
                      if (uploadPath === "") {
                        setUploadPath(
                          `${path === "" ? "" : `${path}/`}${selected.name}`,
                        );
                      }
                    }
                  }}
                />
              </label>
              <button
                className="pm-btn primary"
                type="submit"
                disabled={
                  !spaceQuery.data?.canWrite ||
                  uploadChoice === null ||
                  uploadPath.trim() === "" ||
                  uploadMutation.isPending
                }
              >
                上传
              </button>
            </form>
          </div>

          {(directoryMutation.error ?? uploadMutation.error) !== null && (
            <div className="pm-error">
              {errorText(directoryMutation.error ?? uploadMutation.error)}
            </div>
          )}

          <div className="shared-file-table">
            <header>
              <span>名称</span>
              <span>版本</span>
              <span>大小</span>
              <span>更新</span>
              <span>权限</span>
              <span>操作</span>
            </header>
            {filesQuery.isLoading && (
              <div className="pm-empty" aria-busy="true">
                <LoaderCircle className="spin" size={16} /> 正在读取目录
              </div>
            )}
            {filesQuery.data?.entries.length === 0 && (
              <div className="pm-empty">
                <Folder size={18} />
                当前目录为空
              </div>
            )}
            {filesQuery.data?.entries.map((entry) => {
              const lock = locksByPath.get(entry.path) ?? entry.currentLock;
              return (
                <article key={entry.id} className="shared-file-row">
                  <button
                    className="shared-file-name"
                    type="button"
                    onClick={() => {
                      if (entry.kind === "directory") {
                        setPath(entry.path);
                        setSelectedEntry(null);
                      } else {
                        setSelectedEntry(entry);
                        readMutation.mutate(entry);
                      }
                    }}
                  >
                    {entry.kind === "directory" ? (
                      <Folder size={17} />
                    ) : (
                      <File size={17} />
                    )}
                    <span>
                      <strong>{entry.name}</strong>
                      <small>{entry.mimeType ?? "directory"}</small>
                    </span>
                  </button>
                  <code>{entry.kind === "file" ? `v${entry.currentVersion}` : "-"}</code>
                  <span>{entry.kind === "file" ? bytesLabel(entry.size) : "-"}</span>
                  <span>
                    <strong>{entry.updatedBy}</strong>
                    <small>{formatDateTime(entry.updatedAt)}</small>
                  </span>
                  <span className="shared-row-permissions">
                    {(["read", "write", "delete"] as const)
                      .filter(
                        (permission) =>
                          entry.effectivePermissions[permission],
                      )
                      .map((permission) => (
                        <b key={permission}>{permission}</b>
                      ))}
                    {lock !== null && lock !== undefined && (
                      <b className="locked">locked</b>
                    )}
                  </span>
                  <span className="shared-row-actions">
                    {entry.kind === "file" && (
                      <>
                        <button
                          className="pm-icon-btn"
                          type="button"
                          title="下载文件"
                          onClick={() =>
                            void downloadSharedSpaceFile(
                              effectiveWorkspaceId,
                              entry,
                            )
                          }
                        >
                          <Download size={14} />
                        </button>
                        <button
                          className="pm-icon-btn"
                          type="button"
                          title="查看版本"
                          onClick={() => {
                            setSelectedEntry(entry);
                            versionMutation.mutate(entry);
                          }}
                        >
                          <History size={14} />
                        </button>
                      </>
                    )}
                    {entry.kind === "file" &&
                      entry.effectivePermissions.write &&
                      (lock === null || lock === undefined) && (
                        <button
                          className="pm-icon-btn"
                          type="button"
                          title="获取文件锁"
                          onClick={() => lockMutation.mutate(entry)}
                        >
                          <LockKeyhole size={14} />
                        </button>
                      )}
                    {lock !== null &&
                      lock !== undefined &&
                      lock.ownerPrincipalId === viewerPrincipalId && (
                        <button
                          className="pm-icon-btn"
                          type="button"
                          title="释放文件锁"
                          onClick={() => releaseLockMutation.mutate(lock.id)}
                        >
                          <Unlock size={14} />
                        </button>
                      )}
                  </span>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {pane === "policies" && (
        <section className="shared-policy-layout">
          <div className="shared-policy-list">
            <header>
              <div>
                <h2>路径策略</h2>
                <span>{policiesQuery.data?.length ?? 0} 条生效规则</span>
              </div>
            </header>
            {policiesQuery.data?.map((policy) => (
              <PolicyRow
                key={policy.id}
                policy={policy}
                onRevoke={(item) => revokePolicyMutation.mutate(item)}
              />
            ))}
            {!spaceQuery.data?.canManage && (
              <div className="pm-empty">仅 Workspace 管理员可配置策略</div>
            )}
          </div>
          <form
            className="shared-config-form"
            onSubmit={(event) => {
              event.preventDefault();
              policyMutation.mutate();
            }}
          >
            <h2>新增路径规则</h2>
            <label>
              <span>主体类型</span>
              <select
                value={policyForm.subjectKind}
                onChange={(event) =>
                  setPolicyForm((current) => ({
                    ...current,
                    subjectKind: event.target.value as
                      | "principal"
                      | "workspace-role",
                    subjectId:
                      event.target.value === "workspace-role"
                        ? "ADMIN"
                        : viewerPrincipalId,
                  }))
                }
              >
                <option value="principal">Principal</option>
                <option value="workspace-role">Workspace 角色</option>
              </select>
            </label>
            <label>
              <span>主体</span>
              {policyForm.subjectKind === "workspace-role" ? (
                <select
                  value={policyForm.subjectId}
                  onChange={(event) =>
                    setPolicyForm((current) => ({
                      ...current,
                      subjectId: event.target.value,
                    }))
                  }
                >
                  <option value="ADMIN">ADMIN</option>
                  <option value="MEMBER">MEMBER</option>
                </select>
              ) : (
                <input
                  value={policyForm.subjectId}
                  onChange={(event) =>
                    setPolicyForm((current) => ({
                      ...current,
                      subjectId: event.target.value,
                    }))
                  }
                />
              )}
            </label>
            <label>
              <span>路径模式</span>
              <input
                value={policyForm.pathPattern}
                onChange={(event) =>
                  setPolicyForm((current) => ({
                    ...current,
                    pathPattern: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>效果</span>
              <select
                value={policyForm.effect}
                onChange={(event) =>
                  setPolicyForm((current) => ({
                    ...current,
                    effect: event.target.value as "allow" | "deny",
                  }))
                }
              >
                <option value="allow">allow</option>
                <option value="deny">deny</option>
              </select>
            </label>
            <fieldset>
              <legend>权限</legend>
              {(["list", "read", "write", "delete"] as const).map(
                (permission) => (
                  <label key={permission}>
                    <input
                      type="checkbox"
                      checked={policyForm.permissions.includes(permission)}
                      onChange={(event) =>
                        setPolicyForm((current) => ({
                          ...current,
                          permissions: event.target.checked
                            ? [...current.permissions, permission]
                            : current.permissions.filter(
                                (item) => item !== permission,
                              ),
                        }))
                      }
                    />
                    <span>{permission}</span>
                  </label>
                ),
              )}
            </fieldset>
            {(policyMutation.error ?? revokePolicyMutation.error) !== null && (
              <div className="pm-error">
                {errorText(policyMutation.error ?? revokePolicyMutation.error)}
              </div>
            )}
            <button
              className="pm-btn primary"
              type="submit"
              disabled={
                !spaceQuery.data?.canManage ||
                policyForm.permissions.length === 0 ||
                policyMutation.isPending
              }
            >
              保存策略
            </button>
          </form>
          <form
            className="shared-config-form shared-preview-form"
            onSubmit={(event) => {
              event.preventDefault();
              previewMutation.mutate();
            }}
          >
            <h2>有效权限预览</h2>
            <label>
              <span>Principal</span>
              <input
                value={previewPrincipal}
                onChange={(event) => setPreviewPrincipal(event.target.value)}
              />
            </label>
            <label>
              <span>路径</span>
              <input
                value={previewPath}
                onChange={(event) => setPreviewPath(event.target.value)}
              />
            </label>
            <button
              className="pm-btn secondary"
              type="submit"
              disabled={previewMutation.isPending}
            >
              预览
            </button>
            {previewMutation.data !== undefined && (
              <div className="shared-preview-result">
                <strong>{previewMutation.data.reason}</strong>
                <div className="shared-policy-chips">
                  {Object.entries(previewMutation.data.permissions).map(
                    ([permission, allowed]) =>
                      allowed ? <span key={permission}>{permission}</span> : null,
                  )}
                </div>
                <small>
                  allow {previewMutation.data.matchedPolicyIds.length} / deny{" "}
                  {previewMutation.data.deniedPolicyIds.length}
                </small>
              </div>
            )}
            {previewMutation.error !== null && (
              <div className="pm-error">{errorText(previewMutation.error)}</div>
            )}
          </form>
        </section>
      )}

      {pane === "approvals" && (
        <section className="shared-approvals">
          <div className="shared-approval-grid">
            <div className="shared-request-list">
              <header>
                <div>
                  <h2>写入审批</h2>
                  <span>{pendingRequests.length} 条待处理</span>
                </div>
              </header>
              {requestsQuery.data?.map((request) => (
                <article key={request.id} className="shared-request-row">
                  <div>
                    <strong>{request.targetPath}</strong>
                    <small>
                      {request.scope} · {request.operation} · {request.sha256.slice(0, 12)}
                    </small>
                  </div>
                  <span className={`shared-request-status ${request.status}`}>
                    {request.status}
                  </span>
                  {request.status === "pending" && (
                    <div className="shared-request-actions">
                      <button
                        className="pm-btn secondary"
                        type="button"
                        disabled={
                          request.scope === "global" && !platformAdministrator
                        }
                        onClick={() =>
                          decisionMutation.mutate({
                            requestId: request.id,
                            decision: "approve",
                          })
                        }
                      >
                        <Check size={13} /> 批准
                      </button>
                      <button
                        className="pm-btn danger"
                        type="button"
                        disabled={
                          request.scope === "global" && !platformAdministrator
                        }
                        onClick={() =>
                          decisionMutation.mutate({
                            requestId: request.id,
                            decision: "reject",
                          })
                        }
                      >
                        <X size={13} /> 拒绝
                      </button>
                    </div>
                  )}
                </article>
              ))}
              {pendingRequests.length === 0 && (
                <div className="pm-empty">
                  <ShieldCheck size={18} /> 暂无待审批写入
                </div>
              )}
              <label className="shared-approval-basis">
                <span>审批依据</span>
                <input
                  value={approvalBasis}
                  onChange={(event) => setApprovalBasis(event.target.value)}
                />
              </label>
              {decisionMutation.error !== null && (
                <div className="pm-error">
                  {errorText(decisionMutation.error)}
                </div>
              )}
            </div>
            <form
              className="shared-config-form"
              onSubmit={(event) => {
                event.preventDefault();
                globalMutation.mutate();
              }}
            >
              <h2>Global Write Request</h2>
              <label>
                <span>目标路径</span>
                <input
                  aria-label="Global Write 路径"
                  value={globalPath}
                  onChange={(event) => setGlobalPath(event.target.value)}
                />
              </label>
              <label>
                <span>用途</span>
                <input
                  value={globalPurpose}
                  onChange={(event) => setGlobalPurpose(event.target.value)}
                />
              </label>
              <label>
                <span>文件</span>
                <input
                  type="file"
                  onChange={(event) => {
                    const selected = event.target.files?.[0] ?? null;
                    setGlobalFile(selected);
                    if (selected !== null) setGlobalName(selected.name);
                  }}
                />
              </label>
              <button
                className="pm-btn primary"
                type="submit"
                disabled={
                  !spaceQuery.data?.canManage ||
                  globalFile === null ||
                  globalMutation.isPending
                }
              >
                提交审批
              </button>
              {globalMutation.error !== null && (
                <div className="pm-error">
                  {errorText(globalMutation.error)}
                </div>
              )}
            </form>
          </div>
        </section>
      )}

      {pane === "audit" && (
        <section className="shared-audit-layout">
          <div className="shared-audit-table">
            <header>
              <div>
                <h2>文件审计</h2>
                <span>{auditQuery.data?.total ?? 0} 条事件</span>
              </div>
            </header>
            <div className="shared-audit-columns">
              <span>时间</span>
              <span>动作</span>
              <span>主体 / 路径</span>
              <span>结果</span>
            </div>
            {auditQuery.data?.items.map((event) => (
              <article key={event.id}>
                <span>{formatDateTime(event.createdAt)}</span>
                <code>{event.action}</code>
                <span>
                  <strong>{event.actorPrincipalId ?? "system"}</strong>
                  <small>{event.path ?? "Workspace"}</small>
                </span>
                <b className={event.decision}>{event.decision}</b>
              </article>
            ))}
          </div>
          <div className="shared-digest-panel">
            <header>
              <div>
                <h2>脱敏 Session Digest</h2>
                <span>{digestsQuery.data?.length ?? 0} 份摘要</span>
              </div>
              <button
                className="pm-btn secondary"
                type="button"
                onClick={() => digestMutation.mutate()}
                disabled={digestMutation.isPending}
              >
                生成摘要
              </button>
            </header>
            {digestsQuery.data?.map((digest) => (
              <article key={digest.id}>
                <strong>
                  {digest.digestDate} · {digest.sceneSessionId ?? "workspace"}
                </strong>
                <small>{formatDateTime(digest.generatedAt)}</small>
                <pre>{digest.content}</pre>
              </article>
            ))}
          </div>
        </section>
      )}

      {preview !== null && (
        <section className="shared-preview-overlay" role="dialog" aria-modal>
          <div className="shared-preview-window">
            <header>
              <div>
                <h2>{preview.entry.name}</h2>
                <span>
                  v{preview.entry.currentVersion} · {preview.entry.mimeType}
                </span>
              </div>
              <button
                className="pm-icon-btn"
                type="button"
                title="关闭预览"
                onClick={() => setPreview(null)}
              >
                <X size={15} />
              </button>
            </header>
            {preview.entry.mimeType?.startsWith("text/") ||
            preview.entry.mimeType === "application/json" ? (
              <textarea
                className="shared-preview-editor"
                aria-label="文件内容"
                value={previewDraft}
                onChange={(event) => setPreviewDraft(event.target.value)}
              />
            ) : (
              <pre>{textContent(preview)}</pre>
            )}
            {preview.truncated && <small>预览已截断，下载可获取完整内容</small>}
            {preview.entry.effectivePermissions.write && (
              <div className="shared-preview-actions">
                <button
                  className="pm-btn primary"
                  type="button"
                  disabled={updateMutation.isPending}
                  onClick={() => updateMutation.mutate()}
                >
                  保存为 v{preview.entry.currentVersion + 1}
                </button>
              </div>
            )}
            {updateMutation.error !== null && (
              <small className="shared-preview-error">
                {errorText(updateMutation.error)}
              </small>
            )}
          </div>
        </section>
      )}

      {versions !== null && selectedEntry !== null && (
        <section className="shared-preview-overlay" role="dialog" aria-modal>
          <div className="shared-preview-window shared-versions-window">
            <header>
              <div>
                <h2>{selectedEntry.name} 版本</h2>
                <span>{versions.length} 个不可变版本</span>
              </div>
              <button
                className="pm-icon-btn"
                type="button"
                title="关闭版本"
                onClick={() => setVersions(null)}
              >
                <X size={15} />
              </button>
            </header>
            {versions.map((version) => (
              <article key={version.id}>
                <strong>v{version.version}</strong>
                <code>{version.sha256.slice(0, 16)}</code>
                <span>{bytesLabel(version.size)}</span>
                <small>{formatDateTime(version.createdAt)}</small>
              </article>
            ))}
          </div>
        </section>
      )}

      {selectedEntry !== null && (
        <button
          className="shared-floating-archive"
          type="button"
          title="归档文件"
          hidden={!selectedEntry.effectivePermissions.delete}
          onClick={() => {
            // Destructive archive remains a deliberate API operation.
            const confirmed = window.confirm("确认归档这个文件？");
            if (!confirmed) return;
            void archiveSharedSpaceFile(
              effectiveWorkspaceId,
              selectedEntry.id,
              selectedEntry.currentVersion,
            )
              .then(() => {
                setSelectedEntry(null);
                refreshFiles();
              });
          }}
        >
          <Archive size={14} />
        </button>
      )}
    </main>
  );
}
