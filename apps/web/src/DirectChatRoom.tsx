import { Bot, CircleStop, MessageCircle, RotateCcw, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DirectChatMessage, DirectChatTurn } from "@pluginmax/contracts";
import {
  cancelDirectChatTurn,
  getDirectChat,
  retryDirectChatTurn,
  sendDirectChatMessage,
} from "./api.js";

export function DirectChatRoom({ threadId }: { readonly threadId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const detailQuery = useQuery({
    queryKey: ["direct-chat", threadId],
    queryFn: () => getDirectChat(threadId),
    enabled: threadId !== "",
    refetchInterval: 1_200,
  });
  useEffect(() => {
    setDraft("");
  }, [threadId]);

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: ["direct-chat", threadId],
    });
    void queryClient.invalidateQueries({ queryKey: ["direct-chats"] });
  };
  const sendMutation = useMutation({
    mutationFn: (input: { readonly content: string; readonly id: string }) =>
      sendDirectChatMessage(threadId, input.content, input.id),
    onSuccess: () => {
      setDraft("");
      refresh();
    },
  });
  const cancelMutation = useMutation({
    mutationFn: (turnId: string) => cancelDirectChatTurn(threadId, turnId),
    onSuccess: refresh,
  });
  const retryMutation = useMutation({
    mutationFn: (turnId: string) => retryDirectChatTurn(threadId, turnId),
    onSuccess: refresh,
  });
  const detail = detailQuery.data;
  if (detailQuery.isPending) {
    return (
      <div className="pm-empty meeting-empty">
        <MessageCircle size={28} />
        <strong>正在加载 AI 对话</strong>
      </div>
    );
  }
  if (detail === undefined) {
    return (
      <div className="pm-empty meeting-empty">
        <MessageCircle size={28} />
        <strong>AI 对话不可用</strong>
        <span>{detailQuery.error?.message ?? "请返回会话列表重试。"}</span>
      </div>
    );
  }
  const agentDisabled = detail.thread.agent.status !== "active";
  const runtimeUnavailable = !["fake", "dsh-sdk"].includes(
    detail.thread.agent.runtimeKind,
  );
  const dispatchBlocked = agentDisabled || runtimeUnavailable;
  const activeTurns = detail.turns.filter(
    (turn) => turn.status === "queued" || turn.status === "running",
  );
  const activeTurn = activeTurns[0];
  const error =
    detailQuery.error?.message ??
    sendMutation.error?.message ??
    cancelMutation.error?.message ??
    retryMutation.error?.message;

  return (
    <>
      <div className="instance-head meeting-room-head direct-chat-head">
        <div>
          <strong>{detail.thread.agent.name}</strong>
          <span>
            归属 {detail.thread.ownerId}
            <i className="direct-chat-kind">
              <MessageCircle size={11} />
              AI 对话
            </i>
          </span>
        </div>
        <div className="pm-head-actions direct-chat-status">
          {activeTurn !== undefined && (
            <span className="pm-pill progress">
              {activeTurn.status === "running" ? "运行中" : "排队中"}
            </span>
          )}
          {activeTurn !== undefined && (
            <button
              className="pm-icon-button danger"
              type="button"
              aria-label="取消运行"
              title="取消运行"
              disabled={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate(activeTurn.id)}
            >
              <CircleStop size={14} />
            </button>
          )}
          <span className={`pm-pill ${dispatchBlocked ? "done" : "progress"}`}>
            {agentDisabled
              ? "已停用"
              : runtimeUnavailable
                ? "运行时不可用"
                : detail.thread.agent.runtimeKind}
          </span>
        </div>
      </div>
      <div className="direct-chat-agent-strip">
        <span className="direct-chat-avatar">
          <Bot size={16} />
        </span>
        <span>
          <b>{detail.thread.agent.name}</b>
          <small>{detail.thread.agent.description || "AI 私聊伙伴"}</small>
        </span>
      </div>
      <div className="message-stream direct-chat-stream">
        {detail.messages.map((message) => (
          <DirectChatMessageRow
            key={message.id}
            message={message}
            turn={detail.turns.find(
              (candidate) => candidate.id === message.turnId,
            )}
            retrying={retryMutation.isPending}
            onRetry={(turnId) => retryMutation.mutate(turnId)}
          />
        ))}
        {detail.messages.length === 0 && (
          <div className="pm-empty compact">
            与 {detail.thread.agent.name} 开始私聊
          </div>
        )}
      </div>
      {error !== undefined && <div className="pm-error">{error}</div>}
      <form
        className="message-composer direct-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          const content = draft.trim();
          if (content === "" || dispatchBlocked || sendMutation.isPending)
            return;
          sendMutation.mutate({
            content,
            id: crypto.randomUUID(),
          });
        }}
      >
        <textarea
          aria-label="AI 私聊消息"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={
            agentDisabled
              ? "AI 伙伴已停用，历史消息只读"
              : runtimeUnavailable
                ? "运行时不可用，历史消息只读"
                : "给 AI 伙伴发送消息"
          }
          rows={2}
          disabled={dispatchBlocked}
        />
        <button
          className="pm-btn primary"
          type="submit"
          aria-label="发送"
          title="发送"
          disabled={
            draft.trim() === "" || dispatchBlocked || sendMutation.isPending
          }
        >
          <Send size={14} />
        </button>
      </form>
    </>
  );
}

function DirectChatMessageRow({
  message,
  turn,
  retrying,
  onRetry,
}: {
  readonly message: DirectChatMessage;
  readonly turn: DirectChatTurn | undefined;
  readonly retrying: boolean;
  readonly onRetry: (turnId: string) => void;
}) {
  const failed = message.status === "failed";
  return (
    <article
      className={`meeting-message direct-chat-message message-${message.senderType}`}
    >
      <div>
        <strong>
          {message.senderType === "agent" && <Bot size={11} />}
          {message.senderName}
        </strong>
        <time>{formatDateTime(message.createdAt)}</time>
      </div>
      <p>{message.content}</p>
      {(message.runId !== null ||
        message.traceId !== null ||
        failed ||
        message.status === "cancelled") && (
        <div className="direct-chat-message-meta">
          {message.status === "failed" && <span className="danger">失败</span>}
          {message.status === "cancelled" && <span>已取消</span>}
          {message.errorCode !== null && <code>{message.errorCode}</code>}
          {message.runId !== null && (
            <code title={message.runId}>Run {message.runId.slice(0, 8)}</code>
          )}
          {message.traceId !== null && (
            <code title={message.traceId}>
              Trace {message.traceId.slice(0, 8)}
            </code>
          )}
          {failed && turn !== undefined && (
            <button
              type="button"
              disabled={retrying}
              onClick={() => onRetry(turn.id)}
            >
              <RotateCcw size={11} />
              重试
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  const now = Date.now();
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
  if (Math.abs(now - date.getTime()) < 48 * 60 * 60 * 1_000) {
    return `${date.toDateString() === new Date().toDateString() ? "今天" : "昨天"} ${time}`;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}
