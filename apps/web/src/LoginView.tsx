import { LockKeyhole, LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ApiRequestError, login } from "./api.js";

export function LoginView({ onLoggedIn }: { readonly onLoggedIn: () => void }) {
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await login({ loginId, password });
      onLoggedIn();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : "登录暂时不可用，请稍后重试。",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-screen">
      <form className="auth-panel" onSubmit={(event) => void submit(event)}>
        <div className="auth-mark" aria-hidden="true">
          <LockKeyhole size={20} />
        </div>
        <header>
          <span>Pluginmax</span>
          <h1>登录工作台</h1>
        </header>
        <label>
          <span>登录 ID</span>
          <input
            autoComplete="username"
            autoFocus
            name="loginId"
            value={loginId}
            onChange={(event) => setLoginId(event.target.value)}
          />
        </label>
        <label>
          <span>密码</span>
          <input
            autoComplete="current-password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error === undefined ? null : (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="auth-submit"
          type="submit"
          disabled={submitting || loginId.trim() === "" || password === ""}
        >
          <LogIn size={16} />
          <span>{submitting ? "正在登录" : "登录"}</span>
        </button>
      </form>
    </main>
  );
}
