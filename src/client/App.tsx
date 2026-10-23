import { AlertTriangle, RotateCcw } from "lucide-react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppProvider, useApp } from "./context/AppContext";
import { OcrPreloadProvider } from "./context/OcrPreloadContext";
import { Layout } from "./components/Layout";
import { AuthPage } from "./pages/AuthPage";
import { CapturePage } from "./pages/CapturePage";
import { HistoryPage } from "./pages/HistoryPage";
import { ResultPage } from "./pages/ResultPage";
import { ReviewPage } from "./pages/ReviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WordbookPage } from "./pages/WordbookPage";

function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div>
        <div className="loading-mark">G</div>
        <div>GlossFrame を起動しています…</div>
      </div>
    </div>
  );
}

function ErrorScreen() {
  const { retry, toast } = useApp();
  return (
    <div className="loading-screen">
      <div className="card card-pad stack" style={{ maxWidth: 420, textAlign: "left" }}>
        <div className="row" style={{ color: "var(--danger)", fontWeight: 700 }}>
          <AlertTriangle size={18} /> サーバーに接続できません
        </div>
        <p className="small muted">
          ネットワーク接続を確認してください。デプロイ直後の場合は、D1 のマイグレーションが適用されているかも確認が必要です。
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            retry();
            toast("再接続しています…", "info");
          }}
        >
          <RotateCcw size={15} /> 再試行
        </button>
      </div>
    </div>
  );
}

function AppRoutes() {
  const { status } = useApp();

  if (status === "loading") return <LoadingScreen />;
  if (status === "error") return <ErrorScreen />;
  if (status === "setup") return <AuthPage mode="setup" />;
  if (status === "login") return <AuthPage mode="login" />;

  return (
    <OcrPreloadProvider authenticated={status === "ready"}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<CapturePage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="result/:id" element={<ResultPage />} />
          <Route path="words" element={<WordbookPage />} />
          <Route path="review" element={<ReviewPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </OcrPreloadProvider>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppRoutes />
    </AppProvider>
  );
}
