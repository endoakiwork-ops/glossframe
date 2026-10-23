import { useState } from "react";
import { ArrowRight, Loader2, LockKeyhole, ShieldCheck, Sparkles } from "lucide-react";
import { useApp } from "../context/AppContext";
import { api, errorMessage } from "../lib/api";
import { PasswordInput } from "../components/PasswordInput";

export function AuthPage({ mode }: { mode: "login" | "setup" }) {
  const { appName, login, setup } = useApp();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recoveryToken, setRecoveryToken] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recovered, setRecovered] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isSetup = mode === "setup";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (isSetup) {
      if (password.length < 8) {
        setError("パスワードは8文字以上にしてください。");
        return;
      }
      if (password !== confirm) {
        setError("確認用パスワードが一致しません。");
        return;
      }
    }
    setBusy(true);
    try {
      if (isSetup) await setup(password);
      else await login(password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function recover(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/recover", { method: "POST", body: { token: recoveryToken, newPassword: recoveryPassword } });
      setRecoveryToken("");
      setRecoveryPassword("");
      setPassword("");
      setRecovered(true);
      setShowHelp(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card fade-in">
        <div className="auth-brand">
          <span className="brand-mark">G</span>
          <span className="name">{appName}</span>
        </div>

        <div className="auth-hero">
          <div className="eyebrow">
            {isSetup ? <Sparkles size={13} /> : <LockKeyhole size={13} />}
            {isSetup ? "はじめに" : "おかえりなさい"}
          </div>
          <h1>{isSetup ? "あなた専用の翻訳ノートを\n準備します。" : "翻訳ノートを開く。"}</h1>
          <p>
            {isSetup
              ? "画像の文字を翻訳して、気になった単語を貯めて、復習する。単語帳と履歴は、このアプリの保存先に保存されます。"
              : "アプリ専用のパスワードを入力してください。初回はCloudflareでデプロイするときに決めたパスワードを使います。"}
          </p>
        </div>

        {recovered ? <p role="status">パスワードを再設定しました。新しいパスワードでログインしてください。</p> : null}
        <form className="stack" onSubmit={submit}>
          {error ? <div className="form-error">{error}</div> : null}
          <div className="field">
            <label className="label" htmlFor="password">
              {isSetup ? "所有者パスワードを決める" : "パスワード"}
            </label>
            <PasswordInput
              id="password"
              value={password}
              onChange={setPassword}
              placeholder={isSetup ? "8文字以上" : "パスワード"}
              autoComplete={isSetup ? "new-password" : "current-password"}
              autoFocus
              required
            />
          </div>
          {isSetup ? (
            <div className="field">
              <label className="label" htmlFor="confirm">
                確認のためもう一度
              </label>
              <PasswordInput
                id="confirm"
                value={confirm}
                onChange={setConfirm}
                placeholder="もう一度入力"
                autoComplete="new-password"
                required
              />
            </div>
          ) : null}

          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy ? <Loader2 size={18} className="spin" /> : null}
            {busy ? "確認中…" : isSetup ? "はじめる" : "翻訳ノートを開く"}
            {!busy ? <ArrowRight size={18} /> : null}
          </button>
        </form>

        {isSetup ? (
          <div className="hint-box" style={{ marginTop: 14 }}>
            <ShieldCheck size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
            このパスワードは Cloudflare のログインパスワードではありません。このアプリだけに使う、自分だけのパスワードです。
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setShowHelp((v) => !v)}
            >
              パスワードを忘れた場合
            </button>
            {showHelp ? (
              <form className="stack hint-box" style={{ marginTop: 6 }} onSubmit={recover}>
                <p>管理者はスマホでCloudflareのこのWorkerを開き、Settings → Variables and Secretsで、Secret「OWNER_RECOVERY_TOKEN」に新しい32〜200文字のランダムなキーを設定してDeployしてください。下に同じキーと新しいパスワードを入力します。キーは一度だけ使えます。</p>
                <label className="label" htmlFor="recovery-token">復旧キー</label>
                <PasswordInput id="recovery-token" value={recoveryToken} onChange={setRecoveryToken} autoComplete="off" required />
                <label className="label" htmlFor="recovery-password">新しいパスワード（8〜200文字）</label>
                <PasswordInput id="recovery-password" value={recoveryPassword} onChange={setRecoveryPassword} autoComplete="new-password" required />
                <p>学習データは保持され、すべての端末からログアウトします。完了後はCloudflareから復旧キーを削除してください。</p>
                <button type="submit" className="btn btn-primary" disabled={busy}>パスワードを再設定する</button>
              </form>
            ) : null}
          </div>
        )}

        <div className="auth-foot">
          翻訳と解説には Cloudflare Workers AI を使用します。
          <br />
          翻訳する文章や質問は、AIへの入力として送信されます。
        </div>
      </div>
    </div>
  );
}
