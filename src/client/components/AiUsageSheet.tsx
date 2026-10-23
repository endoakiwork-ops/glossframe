import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import { useApp } from "../context/AppContext";
import { Sheet } from "./Sheet";

const KIND_LABELS: Record<string, string> = {
  translate: "翻訳",
  word: "語義・文脈辞書",
  similar: "類義語・使い分け",
  explain: "レベル別解説",
  chat: "文脈質問チャット",
  word_complete: "手入力のAI補完",
  examples: "別例文の生成",
  cloze: "穴埋め選択肢生成",
  "quiz-plan": "AI出題（候補計画）",
  "quiz-questions": "AI出題（問題生成）",
  "quiz-quality": "AI出題（品質チェック）",
  "quiz-examples": "AI出題（例文）",
  tts: "クラウド音声 (MeloTTS)",
  speech: "クラウド音声 (MeloTTS)",
};

export interface AiQuotaState {
  /** "account" is Cloudflare's own figure; "app" is this app's estimate only. */
  source: "preview" | "account" | "app" | "unknown";
  used: number | null;
  remaining: number | null;
  limit: number;
  /** Remaining share of the daily allocation, 0..1. */
  ratio: number;
  status: "ok" | "warning" | "low" | "unknown";
  /** Compact "used / limit" text for buttons. */
  short: string;
}

export function formatNeurons(value: number): string {
  return Math.round(value).toLocaleString();
}

function quotaFrom(source: AiQuotaState["source"], used: number, limit: number): AiQuotaState {
  const clamped = Math.min(limit, Math.max(0, used));
  const remaining = limit - clamped;
  const ratio = remaining / limit;
  const status = ratio <= 0.1 ? "low" : ratio <= 0.25 ? "warning" : "ok";
  const prefix = source === "app" ? "約" : "";
  return {
    source,
    used,
    remaining,
    limit,
    ratio,
    status,
    short: `${prefix}${formatNeurons(used)}/${formatNeurons(limit)}`,
  };
}

export function useAiQuota(): AiQuotaState {
  const { stats } = useApp();
  const ai = stats?.ai;
  return useMemo(() => {
    const limit = ai?.neuronLimit ?? 10_000;
    try {
      const raw = new URLSearchParams(window.location.search).get("aiPreview");
      if (raw !== null && raw.trim() !== "") {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed >= 0) {
          return quotaFrom("preview", limit - Math.min(limit, parsed), limit);
        }
      }
    } catch {
      // ignore
    }
    if (ai?.account) return quotaFrom("account", ai.account.neurons, limit);
    if (ai) return quotaFrom("app", ai.neurons, limit);
    return {
      source: "unknown",
      used: null,
      remaining: null,
      limit,
      ratio: 1,
      status: "unknown",
      short: "読込中",
    };
  }, [ai]);
}

/** Remaining daily allocation drawn as a battery: full in the morning, empty when spent. */
export function QuotaBattery({
  ratio,
  status,
  known,
}: {
  ratio: number;
  status: AiQuotaState["status"];
  known: boolean;
}) {
  const percent = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  return (
    <span className="quota-battery" data-quota={known ? status : "unknown"}>
      <span className="quota-battery-body" aria-hidden="true">
        <span className="quota-battery-fill" style={{ width: known ? `${percent}%` : "0%" }} />
      </span>
      <span className="quota-battery-text">{known ? `${percent}%` : "—"}</span>
    </span>
  );
}

export function quotaPercentLabel(used: number, limit: number): string {
  const percent = (used / limit) * 100;
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

export function AiUsageSheet() {
  const { usageOpen, setUsageOpen, stats, refreshStats } = useApp();
  const quota = useAiQuota();
  const ai = stats?.ai;
  const byKind = (ai?.byKind ?? []).filter((row) => row.requests > 0);
  const byModel = (ai?.byModel ?? []).filter((row) => row.requests > 0);

  return (
    <Sheet open={usageOpen} title="Workers AI 利用率" onClose={() => setUsageOpen(false)}>
      <div className="stack">
        <div className="quota-summary card-soft card-pad">
          <div className="between" style={{ alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div className="small muted">
                本日の Neurons 利用率
                {quota.source === "account"
                  ? "（Cloudflare アカウント全体）"
                  : quota.source === "preview"
                    ? "（表示例）"
                    : "（このアプリ分の推定）"}
              </div>
              {quota.used !== null ? (
                <>
                  <strong style={{ fontSize: 30, fontWeight: 700, display: "block", marginTop: 4 }}>
                    {quotaPercentLabel(quota.used, quota.limit)}
                  </strong>
                  <progress
                    className="usage-meter"
                    data-level={quota.status}
                    max={quota.limit}
                    value={Math.min(quota.limit, quota.used)}
                  />
                  <span className="small muted" style={{ display: "block", marginTop: 4 }}>
                    {quota.source === "app" ? "約 " : ""}
                    {formatNeurons(quota.used)} / {formatNeurons(quota.limit)} Neurons 使用 · 残り {Math.round(quota.ratio * 100)}% · 日本時間 9:00 にリセット
                  </span>
                </>
              ) : (
                <strong style={{ fontSize: 24, fontWeight: 700, display: "block", marginTop: 4 }}>
                  読み込み中…
                </strong>
              )}
            </div>
            <button
              type="button"
              className="btn-icon"
              onClick={() => void refreshStats()}
              aria-label="利用量を更新"
              title="利用量を更新"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>

        <details className="card card-pad">
          <summary style={{ fontWeight: 600 }}>詳細</summary>
          <div className="stack-sm" style={{ marginTop: 10 }}>
            {quota.source === "account" && ai ? (
              <div className="small muted">
                うちこのアプリ分（推定）: 約 {formatNeurons(ai.neurons)} Neurons
              </div>
            ) : null}

            {byModel.length ? (
              <UsageRows
                title="モデル別"
                rows={byModel.map((row) => ({ key: row.model, label: row.model, requests: row.requests, neurons: row.neurons }))}
              />
            ) : null}
            {byKind.length ? (
              <UsageRows
                title="機能別"
                rows={byKind.map((row) => ({
                  key: row.kind,
                  label: KIND_LABELS[row.kind] ?? row.kind,
                  requests: row.requests,
                  neurons: row.neurons,
                }))}
              />
            ) : (
              <p className="small muted">本日のAI呼び出しはまだ記録されていません。</p>
            )}

            <p className="small muted" style={{ lineHeight: 1.65 }}>
              このアプリ分は、記録したトークン数を Cloudflare 公開のモデル別単価で Neurons に換算した推定値です（音声は1分 18.63 Neurons）。
              Worker のシークレットに <code>CF_ACCOUNT_ID</code> と <code>CF_ANALYTICS_TOKEN</code>（権限: Account Analytics 読み取り）を設定すると、アカウント全体の実績値を表示します。
            </p>
          </div>
        </details>
      </div>
    </Sheet>
  );
}

function UsageRows({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ key: string; label: string; requests: number; neurons: number }>;
}) {
  return (
    <div>
      <div className="small muted" style={{ fontWeight: 600 }}>
        {title}
      </div>
      {rows.map((row) => (
        <div
          key={row.key}
          className="between small"
          style={{ padding: "6px 0", borderBottom: "1px solid var(--line)", gap: 8 }}
        >
          <span style={{ overflowWrap: "anywhere" }}>{row.label}</span>
          <span className="muted" style={{ flexShrink: 0 }}>
            約 {formatNeurons(row.neurons)} Neurons
          </span>
        </div>
      ))}
    </div>
  );
}
