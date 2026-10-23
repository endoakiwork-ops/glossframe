import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PADDLE_OCR_MANIFEST } from "../../shared/ocr-manifest";
import {
  checkPaddleCache,
  deletePaddleCache,
  downloadPaddleModels,
  getPaddleCacheSize,
  type PaddleDownloadProgress,
} from "../lib/paddle-cache";

async function getPaddleEngine() {
  const { paddleOcrEngine } = await import("../lib/paddle-ocr");
  return paddleOcrEngine;
}

export type OcrPreloadPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "initializing"
  | "ready"
  | "error";

export interface OcrPreloadState {
  phase: OcrPreloadPhase;
  loadedBytes: number;
  totalBytes: number;
  error: string | null;
  cachedBytesOnDisk: number;
}

interface OcrPreloadContextValue {
  state: OcrPreloadState;
  startPreload: (force?: boolean) => Promise<void>;
  waitForReady: () => Promise<void>;
  clearCache: () => Promise<void>;
  refreshCacheDiskSize: () => Promise<number>;
}

const OcrPreloadContext = createContext<OcrPreloadContextValue | null>(null);

export function useOcrPreload(): OcrPreloadContextValue {
  const value = useContext(OcrPreloadContext);
  if (!value) throw new Error("useOcrPreload must be used inside OcrPreloadProvider");
  return value;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

let activePreloadPromise: Promise<void> | null = null;
let currentEpoch = 0;

export function OcrPreloadProvider({
  authenticated,
  children,
}: {
  authenticated: boolean;
  children: ReactNode;
}) {
  const [state, setState] = useState<OcrPreloadState>({
    phase: "idle",
    loadedBytes: 0,
    totalBytes: PADDLE_OCR_MANIFEST.totalBytes,
    error: null,
    cachedBytesOnDisk: 0,
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const epochRef = useRef(0);

  const refreshCacheDiskSize = useCallback(async () => {
    try {
      const size = await getPaddleCacheSize();
      setState((prev) => ({ ...prev, cachedBytesOnDisk: size }));
      return size;
    } catch {
      return 0;
    }
  }, []);

  const runPreloadInternal = useCallback(async (epoch: number, force = false): Promise<void> => {
    const engine = await getPaddleEngine();
    if (engine.isReady() && !force) {
      if (epoch === epochRef.current) {
        setState((prev) => ({
          ...prev,
          phase: "ready",
          loadedBytes: prev.totalBytes,
          error: null,
        }));
      }
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    if (epoch === epochRef.current) {
      setState((prev) => ({
        ...prev,
        phase: "checking",
        error: null,
      }));
    }

    try {
      const cacheStatus = await checkPaddleCache();
      if (epoch !== epochRef.current) return;

      if (!cacheStatus.ready) {
        setState((prev) => ({
          ...prev,
          phase: "downloading",
          loadedBytes: cacheStatus.cachedBytes,
          totalBytes: cacheStatus.totalBytes,
          cachedBytesOnDisk: cacheStatus.cachedBytes,
          error: null,
        }));

        await downloadPaddleModels((progress: PaddleDownloadProgress) => {
          if (epoch !== epochRef.current) return;
          setState((prev) => ({
            ...prev,
            loadedBytes: progress.loadedBytes,
            totalBytes: progress.totalBytes,
          }));
        }, controller.signal);
      }

      if (epoch !== epochRef.current) return;

      setState((prev) => ({
        ...prev,
        phase: "initializing",
        loadedBytes: prev.totalBytes,
        error: null,
      }));

      await engine.init();

      if (epoch !== epochRef.current) return;

      const diskSize = await getPaddleCacheSize();
      setState((prev) => ({
        ...prev,
        phase: "ready",
        loadedBytes: prev.totalBytes,
        cachedBytesOnDisk: diskSize,
        error: null,
      }));
    } catch (err) {
      if (epoch !== epochRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: message,
      }));
      throw err;
    }
  }, []);

  const startPreload = useCallback(
    async (force = false): Promise<void> => {
      if (!authenticated) return;
      const engine = await getPaddleEngine();
      if (!force && state.phase === "ready" && engine.isReady()) return;

      if (!force && activePreloadPromise) {
        return activePreloadPromise;
      }

      const epoch = ++currentEpoch;
      epochRef.current = epoch;

      const promise = runPreloadInternal(epoch, force).finally(() => {
        if (activePreloadPromise === promise) {
          activePreloadPromise = null;
        }
      });
      activePreloadPromise = promise;
      return promise;
    },
    [authenticated, runPreloadInternal, state.phase],
  );

  const waitForReady = useCallback(async (): Promise<void> => {
    const engine = await getPaddleEngine();
    if (state.phase === "ready" && engine.isReady()) return;
    if (activePreloadPromise) {
      await activePreloadPromise;
      return;
    }
    await startPreload();
  }, [startPreload, state.phase]);

  const clearCache = useCallback(async (): Promise<void> => {
    epochRef.current = ++currentEpoch;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    activePreloadPromise = null;
    const engine = await getPaddleEngine();
    await engine.terminate();
    await deletePaddleCache();
    setState({
      phase: "idle",
      loadedBytes: 0,
      totalBytes: PADDLE_OCR_MANIFEST.totalBytes,
      error: null,
      cachedBytesOnDisk: 0,
    });
  }, []);

  useEffect(() => {
    if (!authenticated) {
      epochRef.current = ++currentEpoch;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      activePreloadPromise = null;
      void getPaddleEngine().then((engine) => engine.terminate());
      setState({
        phase: "idle",
        loadedBytes: 0,
        totalBytes: PADDLE_OCR_MANIFEST.totalBytes,
        error: null,
        cachedBytesOnDisk: 0,
      });
      return;
    }

    void startPreload();
  }, [authenticated, startPreload]);

  useEffect(() => {
    if (authenticated) {
      void refreshCacheDiskSize();
    }
  }, [authenticated, refreshCacheDiskSize]);

  return (
    <OcrPreloadContext.Provider
      value={{
        state,
        startPreload,
        waitForReady,
        clearCache,
        refreshCacheDiskSize,
      }}
    >
      {children}
    </OcrPreloadContext.Provider>
  );
}
