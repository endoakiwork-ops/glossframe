import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BookMarked,
  CalendarClock,
  Check,
  Cpu,
  Database,
  Download,
  HardDrive,
  Image as ImageIcon,
  Info,
  KeyRound,
  Languages,
  Layers3,
  Loader2,
  LogOut,
  Minus,
  Plus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Target,
  Upload,
} from "lucide-react";
import {
  LEARNER_LEVELS,
  type BackupPayload,
  type LearnerLevel,
  type Settings,
} from "../../shared/types";
import { languageLabel } from "../../shared/languages";
import { quotaPercentLabel, useAiQuota } from "../components/AiUsageSheet";
import { formatBytes, formatDate } from "../lib/format";
import { api, downloadBlob, errorMessage } from "../lib/api";
import { clearLocalBlobs } from "../lib/localdb";
import {
  clearInstallPrompt,
  getInstallPrompt,
  isStandalone,
  onInstallPrompt,
  type BeforeInstallPromptEvent,
} from "../lib/install";
import { useApp, type PerformanceMode } from "../context/AppContext";
import { useOcrPreload } from "../context/OcrPreloadContext";
import { LanguagePicker } from "../components/LanguagePicker";
import { PasswordInput } from "../components/PasswordInput";

interface AppConfig {
  appName: string;
  model: string;
  wordModel: string;
  fallbackModel: string;
  maxTextLength: number;
  maxImageBytes: number;
  promptVersion: string;
}

interface RestoreCounts {
  images: number;
  translations: number;
  words: number;
  examples: number;
  reviewEvents: number;
  skipped: number;
}

function Stepper({
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="number-stepper" aria-label="数値を変更">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        aria-label="減らす"
      >
        <Minus size={14} />
      </button>
      <span className="value">
        {value}
        {suffix ? <span className="small muted">{suffix}</span> : null}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        aria-label="増やす"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      onClick={() => onChange(!checked)}
    />
  );
}

export function SettingsPage() {
  const {
    appName,
    settings,
    stats,
    learnerLevel,
    setLearnerLevel,
    performanceMode,
    setPerformanceMode,
    setUsageOpen,
    updateSettings,
    refreshSettings,
    refreshStats,
    logout,
    toast,
  } = useApp();
  const {
    state: ocrState,
    startPreload: startOcrPreload,
    clearCache: clearOcrCache,
    refreshCacheDiskSize: refreshOcrDiskSize,
  } = useOcrPreload();
  const [clearingOcr, setClearingOcr] = useState(false);
  const [picker, setPicker] = useState<"source" | "target" | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [backupImages, setBackupImages] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreCounts, setRestoreCounts] = useState<RestoreCounts | null>(null);
  const [clearingLocal, setClearingLocal] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(
    () => getInstallPrompt(),
  );
  const [standalone, setStandalone] = useState(isStandalone);
  const restoreInput = useRef<HTMLInputElement>(null);

  const loadMeta = useCallback(async () => {
    try {
      setConfig(await api<AppConfig>("/api/config"));
    } catch {
      // Supplementary information; settings remain usable.
    }
  }, []);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    const unsubscribe = onInstallPrompt((event) => {
      setInstallPrompt(event);
      if (!event) setStandalone(true);
    });
    const onInstalled = () => {
      setStandalone(true);
      setInstallPrompt(null);
    };
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      unsubscribe();
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!settings) {
    return (
      <div className="card card-pad center" style={{ marginTop: 30 }}>
        <Loader2 className="spin" style={{ color: "var(--teal-3)" }} />
        <p className="small muted" style={{ marginTop: 8 }}>
          設定を読み込んでいます…
        </p>
      </div>
    );
  }

  const patch = (next: Partial<Settings>) => {
    void updateSettings(next);
  };

  async function installApp() {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") {
        toast("ホーム画面に追加しました。", "success");
        setStandalone(true);
      }
      clearInstallPrompt();
      setInstallPrompt(null);
    } catch {
      toast("インストールを開始できませんでした。ブラウザのメニューから追加してください。", "error");
    }
  }

  async function exportBackup() {
    setExporting(true);
    try {
      const payload = await api<BackupPayload>(`/api/backup?includeImages=${backupImages}`, { timeoutMs: 180_000 });
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      const date = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `glossframe-backup-${date}.json`);
      toast(`バックアップを書き出しました（${formatBytes(blob.size)}）。`, "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setExporting(false);
    }
  }

  async function restoreBackup(file: File) {
    setRestoreCounts(null);
    if (file.size > 80 * 1024 * 1024) {
      toast("バックアップファイルは80MB以下にしてください。", "error");
      return;
    }
    let payload: BackupPayload;
    try {
      payload = JSON.parse(await file.text()) as BackupPayload;
    } catch {
      toast("バックアップファイルを読み込めませんでした。JSON形式を確認してください。", "error");
      return;
    }
    if (
      payload?.format !== "glossframe-backup" ||
      payload.version !== 1 ||
      !payload.settings ||
      !Array.isArray(payload.translations) ||
      !Array.isArray(payload.words) ||
      !Array.isArray(payload.examples) ||
      !Array.isArray(payload.reviewEvents) ||
      !Array.isArray(payload.images)
    ) {
      toast("GlossFrame のバックアップファイルではないようです。", "error");
      return;
    }
    const confirmed = window.confirm(
      `バックアップを復元しますか？\n\n翻訳 ${payload.translations.length} 件・単語 ${payload.words.length} 語・画像 ${payload.images.length} 件を既存データに追加します。同じデータは重複登録されません。`,
    );
    if (!confirmed) return;

    setRestoring(true);
    try {
      const result = await api<{ ok: boolean; counts: RestoreCounts }>("/api/backup/restore", {
        method: "POST",
        body: payload,
        timeoutMs: 300_000,
      });
      setRestoreCounts(result.counts);
      toast("バックアップを復元しました。", "success");
      await refreshSettings();
      void refreshStats();
      void loadMeta();
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setRestoring(false);
      if (restoreInput.current) restoreInput.current.value = "";
    }
  }

  async function clearCache() {
    if (!window.confirm("この端末に保存した翻訳画像のローカルキャッシュを消去しますか？サーバー上のデータは消えません。")) {
      return;
    }
    setClearingLocal(true);
    try {
      await clearLocalBlobs();
      toast("ローカル画像キャッシュを消去しました。", "success");
    } finally {
      setClearingLocal(false);
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setPasswordError("");
    if (newPassword.length < 8) {
      setPasswordError("新しいパスワードは8文字以上にしてください。");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("確認用パスワードが一致しません。");
      return;
    }
    setPasswordBusy(true);
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: { currentPassword, newPassword },
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setShowPassword(false);
      toast("パスワードを変更しました。他の端末のセッションは切断されました。", "success");
    } catch (error) {
      setPasswordError(errorMessage(error));
    } finally {
      setPasswordBusy(false);
    }
  }

  async function signOut() {
    if (!window.confirm("ログアウトしますか？")) return;
    await logout();
  }

  const quota = useAiQuota();
  const storage = stats?.storage;

  return (
    <div className="stack fade-in">
      <div className="page-head">
        <div>
          <h1 className="title-lg">設定</h1>
          <p className="subtitle">変更は自動的に保存されます。</p>
        </div>
        <span className="badge done">
          <Check size={11} /> 自動保存
        </span>
      </div>

      <section className="settings-section">
        <h2>学習状況</h2>
        <div className="stat-grid">
          <div className="stat">
            <div className="value">{stats?.translations ?? 0}</div>
            <div className="label">翻訳</div>
          </div>
          <div className="stat">
            <div className="value">{stats?.words ?? 0}</div>
            <div className="label">単語</div>
          </div>
          <div className="stat">
            <div className="value">{stats?.dueWords ?? 0}</div>
            <div className="label">復習対象</div>
          </div>
          <div className="stat">
            <div className="value">{stats?.masteredWords ?? 0}</div>
            <div className="label">習得済み</div>
          </div>
        </div>
        <div className="card settings-card">
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">Workers AI 利用率</div>
              <div className="setting-desc">
                {quota.used !== null
                  ? `本日 ${quotaPercentLabel(quota.used, quota.limit)} 使用・残り ${Math.round(quota.ratio * 100)}%${quota.source === "app" ? "（推定）" : ""}`
                  : "読み込み中…"}
              </div>
              {quota.used !== null ? (
                <progress
                  className="usage-meter"
                  data-level={quota.status}
                  max={quota.limit}
                  value={Math.min(quota.limit, quota.used)}
                />
              ) : null}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => setUsageOpen(true)}
              >
                詳細
              </button>
              <button
                type="button"
                className="btn-icon"
                onClick={() => void refreshStats()}
                aria-label="利用状況を更新"
              >
                <RefreshCw size={16} />
              </button>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">動作モード</div>
              <div className="setting-desc">
                {performanceMode === "response"
                  ? "レスポンス: 例文や音声を裏で先に用意して待ち時間を減らします。"
                  : "セーブ: 音声や似た表現は操作したときだけ呼び出し、Neurons を節約します。"}
              </div>
            </div>
            <select
              className="select"
              style={{ width: 175 }}
              value={performanceMode}
              onChange={(e) => setPerformanceMode(e.target.value as PerformanceMode)}
              aria-label="動作モード"
            >
              <option value="response">レスポンス（標準）</option>
              <option value="save">セーブ</option>
            </select>
          </div>
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">解説・AI出題レベル</div>
              <div className="setting-desc">
                翻訳カードの解説・質問チャット・AI出題の難易度に反映されます。
              </div>
            </div>
            <select
              className="select"
              style={{ width: 175 }}
              value={learnerLevel}
              onChange={(e) => setLearnerLevel(e.target.value as LearnerLevel)}
              aria-label="解説・AI出題レベル"
            >
              {LEARNER_LEVELS.map((lvl) => (
                <option key={lvl.value} value={lvl.value}>
                  {lvl.label}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">保存容量（Cloudflare 無料枠）</div>
              {storage ? (
                <div className="stack-sm" style={{ marginTop: 4 }}>
                  <StorageMeter
                    label="データベース (D1)"
                    used={storage.d1.usedBytes}
                    limit={storage.d1.limitBytes}
                  />
                  <StorageMeter
                    label={storage.kv.source === "account" ? "画像・音声 (KV)" : "画像 (KV・このアプリ分)"}
                    used={storage.kv.usedBytes}
                    limit={storage.kv.limitBytes}
                  />
                </div>
              ) : (
                <div className="setting-desc">読み込み中…</div>
              )}
            </div>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => void clearCache()}
              disabled={clearingLocal}
            >
              {clearingLocal ? <Loader2 size={14} className="spin" /> : <HardDrive size={14} />}
              端末キャッシュ消去
            </button>
          </div>
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">文字読み取りデータ（OCR）</div>
              <div className="setting-desc">
                {ocrState.phase === "downloading"
                  ? `取得中: ${formatBytes(ocrState.loadedBytes)} / ${formatBytes(ocrState.totalBytes)}`
                  : ocrState.cachedBytesOnDisk > 0
                    ? `保存済み: ${formatBytes(ocrState.cachedBytesOnDisk)}`
                    : "未保存（初回撮影時に自動取得）"}
              </div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              {ocrState.cachedBytesOnDisk > 0 ? (
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={async () => {
                    setClearingOcr(true);
                    try {
                      await clearOcrCache();
                      toast("OCR用キャッシュを削除しました。履歴や単語帳は保持されます。", "info");
                    } catch {
                      toast("OCRキャッシュの削除に失敗しました。", "error");
                    } finally {
                      setClearingOcr(false);
                    }
                  }}
                  disabled={clearingOcr}
                >
                  {clearingOcr ? <Loader2 size={14} className="spin" /> : <HardDrive size={14} />}
                  OCRデータ削除
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={async () => {
                    try {
                      await startOcrPreload(true);
                      toast("文字読み取りデータの準備を開始しました。", "info");
                    } catch (e) {
                      toast(errorMessage(e), "error");
                    }
                  }}
                  disabled={ocrState.phase === "downloading" || ocrState.phase === "initializing"}
                >
                  {ocrState.phase === "downloading" || ocrState.phase === "initializing" ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Download size={14} />
                  )}
                  今すぐ取得
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>言語</h2>
        <div className="card settings-card">
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">
                <Languages size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                翻訳方向
              </div>
              <div className="setting-desc">OCR と翻訳に使う言語の組み合わせです。</div>
            </div>
          </div>
          <button
            type="button"
            className="setting-row"
            style={{ width: "100%", background: "transparent", textAlign: "left", border: 0, borderBottom: "1px solid var(--line)" }}
            onClick={() => setPicker("source")}
          >
            <div className="setting-text">
              <div className="setting-title">翻訳元</div>
              <div className="setting-desc">画像から読み取る言語</div>
            </div>
            <span className="row" style={{ gap: 5, fontWeight: 700, fontSize: 13 }}>
              {languageLabel(settings.sourceLang)}
              <ArrowRight size={14} color="var(--muted)" />
            </span>
          </button>
          <button
            type="button"
            className="setting-row"
            style={{ width: "100%", background: "transparent", textAlign: "left", border: 0 }}
            onClick={() => setPicker("target")}
          >
            <div className="setting-text">
              <div className="setting-title">翻訳先</div>
              <div className="setting-desc">訳文と解説の言語</div>
            </div>
            <span className="row" style={{ gap: 5, fontWeight: 700, fontSize: 13 }}>
              {languageLabel(settings.targetLang)}
              <ArrowRight size={14} color="var(--muted)" />
            </span>
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h2>撮影と保存</h2>
        <div className="card settings-card">
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">
                <ImageIcon size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                画像を保存する
              </div>
              <div className="setting-desc">
                単語登録時に画像を WebP に圧縮して KV へ保存します。オフにすると容量を節約できます。
              </div>
            </div>
            <Switch
              checked={settings.saveImages}
              onChange={(value) => patch({ saveImages: value })}
              label="画像を保存する"
            />
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>復習</h2>
        <div className="card settings-card">
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">
                <CalendarClock size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                復習間隔
              </div>
              <div className="setting-desc">「覚えた」の次回出題までの日数</div>
            </div>
            <Stepper
              value={settings.reviewIntervalDays}
              min={1}
              max={365}
              suffix="日"
              onChange={(value) => patch({ reviewIntervalDays: value })}
            />
          </div>
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">
                <Target size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                習得に必要な回数
              </div>
              <div className="setting-desc">この回数「覚えた」で習得済みになります</div>
            </div>
            <Stepper
              value={settings.reviewTargetCount}
              min={1}
              max={10}
              suffix="回"
              onChange={(value) => patch({ reviewTargetCount: value })}
            />
          </div>
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">
                <Layers3 size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                1回の復習枚数
              </div>
              <div className="setting-desc">一度に出すカードの上限</div>
            </div>
            <Stepper
              value={settings.reviewBatchSize}
              min={1}
              max={100}
              suffix="枚"
              onChange={(value) => patch({ reviewBatchSize: value })}
            />
          </div>
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">復習カードに画像を表示</div>
              <div className="setting-desc">登録した画像をヒントとして表示します</div>
            </div>
            <Switch
              checked={settings.reviewShowImage}
              onChange={(value) => patch({ reviewShowImage: value })}
              label="復習カードに画像を表示"
            />
          </div>
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">出題順</div>
              <div className="setting-desc">復習キューに並べる順番</div>
            </div>
            <select
              className="select"
              style={{ width: 132 }}
              value={settings.reviewOrder}
              onChange={(event) =>
                patch({ reviewOrder: event.target.value as Settings["reviewOrder"] })
              }
              aria-label="復習の出題順"
            >
              <option value="due">復習期限順</option>
              <option value="created">登録順</option>
              <option value="random">ランダム</option>
            </select>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>バックアップ</h2>
        <div className="card settings-card">
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">
                <Download size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                バックアップを書き出す
              </div>
              <div className="setting-desc">
                翻訳履歴・単語帳・復習履歴・設定を1つの JSON にまとめます。パスワードは含みません。
                <label style={{display:"flex",gap:8,marginTop:8}}><input type="checkbox" checked={backupImages} onChange={event => setBackupImages(event.target.checked)} />画像も含める（合計20MBまで）</label>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => void exportBackup()}
              disabled={exporting || restoring}
            >
              {exporting ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
              {exporting ? "作成中…" : "書き出す"}
            </button>
          </div>
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">
                <Upload size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                バックアップから復元
              </div>
              <div className="setting-desc">
                既存データに追加します。同じ翻訳・単語・画像は重複登録されません。
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => restoreInput.current?.click()}
              disabled={restoring || exporting}
            >
              {restoring ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
              {restoring ? "復元中…" : "選ぶ"}
            </button>
            <input
              ref={restoreInput}
              className="sr-only"
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void restoreBackup(file);
              }}
              aria-label="バックアップファイルを選択"
            />
          </div>
          {restoreCounts ? (
            <div className="setting-row">
              <div className="setting-text">
                <div className="setting-title" style={{ color: "var(--success)" }}>
                  復元が完了しました
                </div>
                <div className="setting-desc">
                  画像 {restoreCounts.images}・翻訳 {restoreCounts.translations}・単語{" "}
                  {restoreCounts.words}・用例 {restoreCounts.examples}・復習{" "}
                  {restoreCounts.reviewEvents} 件を追加
                  {restoreCounts.skipped > 0 ? `（${restoreCounts.skipped} 件は重複または無効）` : ""}
                </div>
              </div>
              <Check size={18} color="var(--success)" />
            </div>
          ) : null}
        </div>
        <p className="small muted" style={{ paddingLeft: 4 }}>
          バックアップは JSON 形式です。画像が多い場合はファイルが大きくなるため、Wi-Fi 環境での保存をおすすめします。
        </p>
      </section>

      <section className="settings-section">
        <h2>セキュリティ</h2>
        <div className="card settings-card">
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">
                <KeyRound size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                所有者パスワード
              </div>
              <div className="setting-desc">
                このアプリ専用のパスワードです。変更すると他の端末のセッションは切断されます。
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => setShowPassword((value) => !value)}
            >
              {showPassword ? "閉じる" : "変更"}
            </button>
          </div>
          {showPassword ? (
            <form onSubmit={changePassword} style={{ padding: 16, borderBottom: "1px solid var(--line)" }}>
              <div className="stack-sm">
                {passwordError ? <div className="form-error">{passwordError}</div> : null}
                <div className="field">
                  <label className="label" htmlFor="current-password">
                    現在のパスワード
                  </label>
                  <PasswordInput
                    id="current-password"
                    value={currentPassword}
                    onChange={setCurrentPassword}
                    autoComplete="current-password"
                    required
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="new-password">
                    新しいパスワード（8文字以上）
                  </label>
                  <PasswordInput
                    id="new-password"
                    value={newPassword}
                    onChange={setNewPassword}
                    autoComplete="new-password"
                    required
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="confirm-password">
                    新しいパスワード（確認）
                  </label>
                  <PasswordInput
                    id="confirm-password"
                    value={confirmPassword}
                    onChange={setConfirmPassword}
                    autoComplete="new-password"
                    required
                  />
                </div>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={passwordBusy || !currentPassword || !newPassword}
                >
                  {passwordBusy ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />}
                  パスワードを変更
                </button>
              </div>
            </form>
          ) : null}
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">
                <LogOut size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                ログアウト
              </div>
              <div className="setting-desc">この端末のセッションを終了します。</div>
            </div>
            <button type="button" className="btn btn-sm btn-secondary" onClick={() => void signOut()}>
              <LogOut size={14} /> ログアウト
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>アプリ</h2>
        <div className="card settings-card">
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">
                <Smartphone size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
                ホーム画面に追加
              </div>
              <div className="setting-desc">
                {standalone
                  ? "すでにアプリとして起動しています。"
                  : installPrompt
                    ? "オフラインでも起動できる PWA としてインストールできます。"
                    : "Safari は共有メニュー、Chrome はメニューから「ホーム画面に追加」を選んでください。"}
              </div>
            </div>
            {standalone ? (
              <span className="badge done">
                <Check size={11} /> インストール済み
              </span>
            ) : installPrompt ? (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => void installApp()}>
                追加する
              </button>
            ) : (
              <Info size={18} color="var(--muted)" />
            )}
          </div>
          <div className="about-list">
            <div className="about-row">
              <span className="k">バージョン</span>
              <span className="v">0.1.0</span>
            </div>
            <div className="about-row">
              <span className="k">AI モデル</span>
              <span className="v mono">{config?.model ?? "—"}</span>
            </div>
            <div className="about-row">
              <span className="k">単語解説モデル</span>
              <span className="v mono">{config?.wordModel ?? "—"}</span>
            </div>
            <div className="about-row">
              <span className="k">フォールバック</span>
              <span className="v mono">{config?.fallbackModel ?? "—"}</span>
            </div>
            <div className="about-row">
              <span className="k">プロンプト版</span>
              <span className="v mono">{config?.promptVersion ?? "—"}</span>
            </div>
            <div className="about-row">
              <span className="k">利用開始</span>
              <span className="v">{formatDate(settings.createdAt)}</span>
            </div>
          </div>
        </div>
        <div className="hint-box">
          <ShieldCheck size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
          {appName} のデータは、あなたの Cloudflare アカウントの D1 と KV にだけ保存されます。画像と文章は端末の OCR
          と Workers AI 以外へ送信されません。
        </div>
      </section>

      <section className="settings-section">
        <h2>知っておくこと</h2>
        <div className="card settings-card">
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">
                <Cpu size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} /> Workers AI
                の無料枠
              </div>
              <div className="setting-desc">
                翻訳・文法・単語解説は Cloudflare Workers AI の無料割当内で動作します。上限に達すると翻訳はエラーになりますが、自動課金は発生しません。
              </div>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">
                <Database size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} /> D1 / KV
                の上限
              </div>
              <div className="setting-desc">
                無料枠を超えると保存に失敗することがあります。定期的なバックアップと、画像保存のオフを組み合わせてください。
              </div>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">
                <Sparkles size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} /> OCR
                について
              </div>
              <div className="setting-desc">
                文字認識は端末内の Tesseract.js が行います。初回のみ言語データをダウンロードするため、通信と時間がかかります。認識精度は画像の明るさ・傾き・解像度に左右されます。
              </div>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-title">
                <BookMarked size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} /> この
                インスタンスについて
              </div>
              <div className="setting-desc">
                所有者1名のための個人用インスタンスです。公開 URL を知っていても、パスワードなしで履歴・単語帳・画像を取得することはできません。
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="row" style={{ justifyContent: "center" }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refreshSettings()}>
          <RefreshCw size={13} /> 設定を再読み込み
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()}>
          <LogOut size={13} /> ログアウト
        </button>
      </div>

      <LanguagePicker
        open={picker !== null}
        title={picker === "target" ? "翻訳先の言語" : "翻訳元の言語"}
        selected={picker === "target" ? settings.targetLang : settings.sourceLang}
        exclude={picker === "target" ? settings.sourceLang : settings.targetLang}
        onSelect={(code) => {
          if (!picker) return;
          patch(picker === "target" ? { targetLang: code } : { sourceLang: code });
        }}
        onClose={() => setPicker(null)}
      />
    </div>
  );
}

function formatMb(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb < 10 ? mb.toFixed(1) : Math.round(mb).toLocaleString();
}

function StorageMeter({ label, used, limit }: { label: string; used: number | null; limit: number }) {
  return (
    <div>
      <div className="between small">
        <span>{label}</span>
        <span className="muted">
          {used === null ? "取得できません" : `${formatMb(used)} / ${formatMb(limit)} MB 使用中`}
        </span>
      </div>
      {used !== null ? (
        <progress
          className="usage-meter"
          data-level={used / limit >= 0.9 ? "low" : used / limit >= 0.75 ? "warning" : "ok"}
          max={limit}
          value={Math.min(limit, used)}
        />
      ) : null}
    </div>
  );
}
