import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  BookMarked,
  Camera,
  Clock3,
  Layers3,
  Settings2,
  WifiOff,
} from "lucide-react";
import { useApp } from "../context/AppContext";
import { AiUsageSheet, QuotaBattery, useAiQuota } from "./AiUsageSheet";
import { stopCloudTts } from "../lib/audio";
import { ToastViewport } from "./Toast";
import "../camera.css";

const NAV = [
  { to: "/", label: "撮影", icon: Camera, end: true },
  { to: "/history", label: "履歴", icon: Clock3, end: false },
  { to: "/words", label: "単語帳", icon: BookMarked, end: false },
  { to: "/review", label: "復習", icon: Layers3, end: false },
  { to: "/settings", label: "設定", icon: Settings2, end: false },
];

export function Layout() {
  const { appName, stats, setUsageOpen } = useApp();
  const quota = useAiQuota();
  const location = useLocation();
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    stopCloudTts();
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [location.pathname]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const isCameraRoute = location.pathname === "/";
  const isTranslationRoute =
    location.pathname === "/result" || location.pathname.startsWith("/result/");
  const shellClassName = [
    "app-shell",
    isCameraRoute ? "camera-shell" : "",
    isTranslationRoute ? "translation-shell" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClassName}>
      {!online ? (
        <div className="offline-banner">
          <WifiOff size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          オフラインです。保存済みの内容は閲覧できます。
        </div>
      ) : null}
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label={`${appName} ホーム`}>
          <span className="brand-mark">G</span>
          <span>{appName}</span>
        </NavLink>
        <div className="topbar-actions">
          <button
            type="button"
            className="wb-quota"
            onClick={() => setUsageOpen(true)}
            aria-label={quota.remaining !== null ? `Workers AI 残り ${Math.round(quota.ratio * 100)}%` : "Workers AI の利用状況を開く"}
          >
            AI枠
            <QuotaBattery ratio={quota.ratio} status={quota.status} known={quota.used !== null} />
          </button>
          <NavLink
            to="/settings"
            className="btn-icon"
            aria-label="設定"
            style={{ display: "grid", placeItems: "center" }}
          >
            <Settings2 size={18} />
          </NavLink>
        </div>
      </header>

      <main className="page">
        <Outlet />
      </main>

      <nav className="bottom-nav" aria-label="メインナビゲーション">
        {NAV.map((item) => {
          const Icon = item.icon;
          const isReview = item.to === "/review";
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
            >
              <span className="nav-icon">
                <Icon size={20} strokeWidth={1.85} />
                {isReview && (stats?.dueWords ?? 0) > 0 ? <span className="nav-dot" /> : null}
              </span>
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      <AiUsageSheet />
      <ToastViewport />
    </div>
  );
}
