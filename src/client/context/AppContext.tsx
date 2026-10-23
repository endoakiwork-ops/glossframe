import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { LearnerLevel, Settings, Stats } from "../../shared/types";
import { api, errorMessage, onUnauthorized } from "../lib/api";
import { playCloudTts } from "../lib/audio";

type AppStatus = "loading" | "setup" | "login" | "ready" | "error";

/**
 * "response" runs AI and audio ahead of time in the background so screens feel
 * instant; "save" only calls AI when the user asks, to conserve Neurons.
 */
export type PerformanceMode = "response" | "save";

const PERFORMANCE_MODE_STORAGE_KEY = "gf_performance_mode";

function readStoredPerformanceMode(): PerformanceMode {
  try {
    return window.localStorage.getItem(PERFORMANCE_MODE_STORAGE_KEY) === "save" ? "save" : "response";
  } catch {
    return "response";
  }
}

const LEARNER_LEVEL_STORAGE_KEY = "gf_learner_level";

function readStoredLearnerLevel(): LearnerLevel {
  try {
    const raw = window.localStorage.getItem(LEARNER_LEVEL_STORAGE_KEY);
    if (raw === "junior" || raw === "high" || raw === "600" || raw === "800" || raw === "900") return raw;
  } catch {
    // ignore storage errors
  }
  return "800";
}

interface AuthStatusResponse {
  setupRequired: boolean;
  setupDisabled?: boolean;
  authenticated: boolean;
  appName: string;
  sessionExpiresAt: number | null;
}

export interface ToastItem {
  id: number;
  message: string;
  kind: "info" | "success" | "error";
}

interface AppContextValue {
  status: AppStatus;
  appName: string;
  settings: Settings | null;
  stats: Stats | null;
  toasts: ToastItem[];
  learnerLevel: LearnerLevel;
  setLearnerLevel: (level: LearnerLevel) => void;
  performanceMode: PerformanceMode;
  setPerformanceMode: (mode: PerformanceMode) => void;
  usageOpen: boolean;
  setUsageOpen: (open: boolean) => void;
  speak: (text: string, lang?: string) => Promise<void>;
  login: (password: string) => Promise<void>;
  setup: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<boolean>;
  refreshSettings: () => Promise<void>;
  refreshStats: () => Promise<void>;
  toast: (message: string, kind?: ToastItem["kind"]) => void;
  dismissToast: (id: number) => void;
  retry: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AppStatus>("loading");
  const [appName, setAppName] = useState("GlossFrame");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [learnerLevel, setLearnerLevelState] = useState<LearnerLevel>(readStoredLearnerLevel);
  const [performanceMode, setPerformanceModeState] = useState<PerformanceMode>(readStoredPerformanceMode);
  const [usageOpen, setUsageOpen] = useState(false);
  const toastId = useRef(0);
  const timerIds = useRef<number[]>([]);

  const setLearnerLevel = useCallback((next: LearnerLevel) => {
    setLearnerLevelState(next);
    try {
      window.localStorage.setItem(LEARNER_LEVEL_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  const setPerformanceMode = useCallback((next: PerformanceMode) => {
    setPerformanceModeState(next);
    try {
      window.localStorage.setItem(PERFORMANCE_MODE_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, kind: ToastItem["kind"] = "info") => {
      const id = ++toastId.current;
      setToasts((items) => [...items.slice(-2), { id, message, kind }]);
      const timer = window.setTimeout(() => dismissToast(id), kind === "error" ? 6500 : 4000);
      timerIds.current.push(timer);
    },
    [dismissToast],
  );

  useEffect(() => {
    return () => {
      for (const timer of timerIds.current) window.clearTimeout(timer);
    };
  }, []);

  const loadSettings = useCallback(async () => {
    const data = await api<Settings>("/api/settings");
    setSettings(data);
    return data;
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      const data = await api<Stats>("/api/stats");
      setStats(data);
    } catch {
      // Stats are informative only.
    }
  }, []);

  const checkAuth = useCallback(async () => {
    setStatus("loading");
    try {
      const data = await api<AuthStatusResponse>("/api/auth/status");
      setAppName(data.appName || "GlossFrame");
      if (data.setupRequired) {
        setStatus("setup");
        return;
      }
      if (data.setupDisabled) {
        toast("このアプリは所有者専用です。管理者の初期登録が必要です。", "error");
        setStatus("login");
        return;
      }
      if (!data.authenticated) {
        setStatus("login");
        return;
      }
      await loadSettings();
      setStatus("ready");
      void refreshStats();
    } catch (error) {
      toast(errorMessage(error), "error");
      setStatus("error");
    }
  }, [loadSettings, refreshStats, toast]);

  useEffect(() => {
    const unsubscribe = onUnauthorized(() => {
      setStatus("login");
      setSettings(null);
    });
    void checkAuth();
    return unsubscribe;
  }, [checkAuth]);

  const login = useCallback(
    async (password: string) => {
      await api("/api/auth/login", { method: "POST", body: { password } });
      await loadSettings();
      setStatus("ready");
      void refreshStats();
    },
    [loadSettings, refreshStats],
  );

  const setup = useCallback(
    async (password: string) => {
      await api("/api/auth/setup", { method: "POST", body: { password } });
      try { window.localStorage.removeItem("gf_review_sessions_v2"); } catch { /* Storage may be unavailable. */ }
      await loadSettings();
      setStatus("ready");
      void refreshStats();
    },
    [loadSettings, refreshStats],
  );

  const logout = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: {} });
    } catch {
      // Even if the network fails, clear local state.
    }
    setSettings(null);
    setStats(null);
    setStatus("login");
  }, []);

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      if (!settings) return false;
      const previous = settings;
      const optimistic = { ...settings, ...patch };
      setSettings(optimistic);
      try {
        const saved = await api<Settings>("/api/settings", { method: "PUT", body: patch });
        setSettings(saved);
        return true;
      } catch (error) {
        setSettings(previous);
        toast(errorMessage(error), "error");
        return false;
      }
    },
    [settings, toast],
  );

  const refreshSettings = useCallback(async () => {
    try {
      await loadSettings();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  }, [loadSettings, toast]);

  const speak = useCallback(
    async (text: string, lang?: string) => {
      try {
        await playCloudTts(text, lang ?? settings?.sourceLang ?? "en");
        void refreshStats();
      } catch (error) {
        toast(errorMessage(error), "error");
      }
    },
    [settings?.sourceLang, refreshStats, toast],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      status,
      appName,
      settings,
      stats,
      toasts,
      learnerLevel,
      setLearnerLevel,
      performanceMode,
      setPerformanceMode,
      usageOpen,
      setUsageOpen,
      speak,
      login,
      setup,
      logout,
      updateSettings,
      refreshSettings,
      refreshStats,
      toast,
      dismissToast,
      retry: () => void checkAuth(),
    }),
    [
      status,
      appName,
      settings,
      stats,
      toasts,
      learnerLevel,
      setLearnerLevel,
      performanceMode,
      setPerformanceMode,
      usageOpen,
      speak,
      login,
      setup,
      logout,
      updateSettings,
      refreshSettings,
      refreshStats,
      toast,
      dismissToast,
      checkAuth,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
