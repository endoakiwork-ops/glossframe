import { useEffect, useRef, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { ResultPage } from "./ResultPage";
import type { TranslationResult } from "../../shared/types";
import {
  buildTranslationRegions,
  mergeTranslationRegions,
  type TranslationRegion,
  type TranslationRegionInput,
} from "../../shared/translation-regions";
import { api, errorMessage } from "../lib/api";
import { loadImageFile, prepareImageForSave, prepareOcrContrast, prepareOcrPanels } from "../lib/image";
import { putLocalBlob, translationImageKey } from "../lib/localdb";
import {
  recognize,
  type OcrRegion,
} from "../lib/ocr";
import { useApp } from "../context/AppContext";
import { formatBytes, useOcrPreload } from "../context/OcrPreloadContext";

type FlowStage = "preparing" | "ocr" | "translating" | "empty" | "error";

interface TranslateRegionsResponse extends TranslationResult {
  regions?: TranslationRegion[];
}

function sanitizeOcrRegions(
  rawRegions: OcrRegion[],
  width: number,
  height: number,
): TranslationRegionInput[] {
  const safeW = Math.max(1, Math.round(width));
  const safeH = Math.max(1, Math.round(height));
  const sourceList = rawRegions;

  if (sourceList.length > 100 || sourceList.reduce((sum, region) => sum + region.text.trim().length, 0) > 6000) {
    throw new Error("画像内の文字が多すぎます。読む箇所を近くから撮り直してください（6000文字まで）。");
  }
  const seenIds = new Set<string>();
  const sanitized: TranslationRegionInput[] = [];
  let totalChars = 0;

  for (let i = 0; i < sourceList.length; i += 1) {
    if (sanitized.length >= 100) break;
    const region = sourceList[i];
    const remaining = 6000 - totalChars;
    if (remaining <= 0) break;

    const text = String(region?.text ?? "")
      .trim()
      .slice(0, remaining)
      .trim();
    if (!text) continue;

    const baseId = String(region?.id ?? "").trim() || `r${i}`;
    let id = baseId.slice(0, 100);
    if (seenIds.has(id)) {
      id = `r${i}-${sanitized.length}`;
    }
    seenIds.add(id);

    const rawX0 = Number.isFinite(region?.bbox?.x0) ? region.bbox.x0 : 0;
    const rawY0 = Number.isFinite(region?.bbox?.y0) ? region.bbox.y0 : 0;
    const rawX1 = Number.isFinite(region?.bbox?.x1) ? region.bbox.x1 : safeW;
    const rawY1 = Number.isFinite(region?.bbox?.y1) ? region.bbox.y1 : safeH;

    const x0 = Math.max(0, Math.min(safeW - 1, Math.min(rawX0, rawX1)));
    const y0 = Math.max(0, Math.min(safeH - 1, Math.min(rawY0, rawY1)));
    const x1 = Math.max(x0 + 1, Math.min(safeW, Math.max(rawX0, rawX1)));
    const y1 = Math.max(y0 + 1, Math.min(safeH, Math.max(rawY0, rawY1)));

    sanitized.push({
      id,
      text,
      bbox: { x0, y0, x1, y1 },
    });
    totalChars += text.length;
  }

  return sanitized;
}

export function OcrFlow({ file, onCancel }: { file: File; onCancel: () => void }) {
  const { settings, toast, refreshStats } = useApp();
  const { state: preloadState, waitForReady } = useOcrPreload();

  const [stage, setStage] = useState<FlowStage>("preparing");
  const [completedResult, setCompletedResult] = useState<TranslationResult | null>(null);
  const [visibleRegions, setVisibleRegions] = useState<TranslationRegion[]>([]);
  const [errorText, setErrorText] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  const mountedRef = useRef(false);
  const runIdRef = useRef(0);

  const toastRef = useRef(toast);
  toastRef.current = toast;
  const refreshStatsRef = useRef(refreshStats);
  refreshStatsRef.current = refreshStats;
  const saveImagesRef = useRef(settings?.saveImages ?? true);
  saveImagesRef.current = settings?.saveImages ?? true;

  const sourceLang = settings?.sourceLang ?? "en";
  const rawTargetLang = settings?.targetLang ?? "ja";
  const targetLang =
    rawTargetLang === sourceLang ? (sourceLang === "ja" ? "en" : "ja") : rawTargetLang;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const currentRun = ++runIdRef.current;
    const isStale = () =>
      cancelled || !mountedRef.current || currentRun !== runIdRef.current;

    setStage("preparing");
    setErrorText("");
    setVisibleRegions([]);
    setCompletedResult(null);

    const runPipeline = async () => {
      // Yield a microtask so React StrictMode's synchronous double-mount cleanup
      // cancels the first pass before enqueuing duplicate OCR or API requests.
      await Promise.resolve();
      if (isStale()) return;

      try {
        const loaded = await loadImageFile(file);
        if (isStale()) return;

        if (sourceLang === "en") {
          await waitForReady();
          if (isStale()) return;
        }

        setStage("ocr");
        const ocrResult = await recognize(
          loaded.canvas,
          sourceLang,
          undefined,
          prepareOcrContrast(loaded.canvas),
          sourceLang === "en" ? prepareOcrPanels(loaded.canvas) : [],
        );
        if (isStale()) return;

        const width = Math.max(1, Math.round(loaded.width));
        const height = Math.max(1, Math.round(loaded.height));
        const validRegions = sanitizeOcrRegions(
          ocrResult.regions,
          width,
          height,
        );

        const unresolved = ocrResult.unresolved ?? 0;
        if (validRegions.length === 0) {
          setStage("empty");
          setErrorText(
            unresolved > 0
              ? "文字をうまく検出できませんでした。文字が重ならない角度で撮り直してください。"
              : "画像から文字を認識できませんでした。別の画像を選ぶか、もう一度お試しください。",
          );
          return;
        }
        if (unresolved > 0) {
          // Regions that overlapped even after three re-reads were dropped;
          // everything else is still translated.
          toastRef.current(`${unresolved} か所の文字をうまく検出できませんでした。`, "info");
        }

        setStage("translating");

        setVisibleRegions(validRegions.map(r => ({
          id:r.id,source:r.text,translation:"",phase:"ocr",
          x:r.bbox.x0/width,y:r.bbox.y0/height,
          width:(r.bbox.x1-r.bbox.x0)/width,height:(r.bbox.y1-r.bbox.y0)/height,
        })));
        const result = await api<TranslateRegionsResponse>("/api/translate/regions", {
          method: "POST",
          timeoutMs: 120_000,
          signal: controller.signal,
          onEvent: (event) => {
            const update = event as { type: string; regions?: TranslationRegion[] };
            if (!isStale() && (update.type === "regions" || update.type === "draft") && Array.isArray(update.regions)) {
              setVisibleRegions(previous => mergeTranslationRegions(previous, update.regions!.map(r => ({...r, phase:update.type === "draft" ? "draft" : "final"}))));
            }
          },
          body: {
            progressive: true,
            regions: validRegions,
            width,
            height,
            sourceLang,
            targetLang,
          },
        });
        if (isStale()) return;

        const serverRegions =
          Array.isArray(result.regions) && result.regions.length > 0
            ? result.regions
            : null;
        const resolvedRegions: TranslationRegion[] =
          serverRegions ??
          buildTranslationRegions(
            result.sourceText,
            result.segments ?? [],
            validRegions,
            width,
            height,
          );
        setVisibleRegions(resolvedRegions);
        setCompletedResult(result);

        if (result.id && !Array.isArray(result.regions) && resolvedRegions.length > 0) {
          await api(`/api/translations/${result.id}/regions`, {
            method: "PUT",
            body: { regions: resolvedRegions },
          }).catch(() => undefined);
          if (isStale()) return;
        }

        if (result.id && saveImagesRef.current) {
          try {
            const prepared = await prepareImageForSave(loaded.canvas);
            if (isStale()) return;
            await putLocalBlob(translationImageKey(result.id), prepared.blob);
            if (isStale()) return;
            const saved = await api<{ imageKey: string }>(
              `/api/translations/${result.id}/image`,
              {
                method: "PUT",
                body: {
                  dataBase64: prepared.dataBase64,
                  contentType: prepared.contentType,
                  sha256: prepared.sha256,
                },
              },
            );
            result.imageKey = saved.imageKey;
          } catch {
            if (!isStale()) {
              toastRef.current(
                "翻訳は保存しました。画像の保存を完了できませんでした。",
                "info",
              );
            }
          }
        }

        if (isStale()) return;

        void refreshStatsRef.current();
        setVisibleRegions(resolvedRegions);
        setCompletedResult(result);
      } catch (error) {
        if (isStale()) return;
        setErrorText(errorMessage(error));
        setStage("error");
      }
    };

    void runPipeline();

    return () => {
      cancelled = true;
      controller.abort();
      runIdRef.current += 1;
    };
  }, [file, sourceLang, targetLang, retryKey]);

  const partial: TranslationResult = {
    sourceText: visibleRegions.map(r => r.source).join("\n\n"),
    translatedText: visibleRegions.map(r => r.translation).join("\n\n"),
    sourceLang, targetLang,
    segments: visibleRegions.map(r => ({source:r.source, translation:r.translation})),
    grammarNotes: [], keyPhrases: [],
  };
  return (
    <>
      <ResultPage live={{translation:completedResult ?? partial, regions:visibleRegions, imageFile:file, onCancel}} />
      {!completedResult && stage !== "empty" && stage !== "error" ? (
        // A thin bar instead of a status card: the boxes on the image already
        // show reading and translation progress. Only the one-time model
        // download, which can take a while, gets words.
        <>
          <div className="tv-busy-bar" role="progressbar" aria-label="読み取り・翻訳中" />
          {stage === "preparing" && preloadState.phase === "downloading" ? (
            <div className="tv-progress" role="status" aria-live="polite">
              <span className="tv-progress-dot" />
              <span>
                文字読み取りの準備中（初回のみ・約24 MB: {formatBytes(preloadState.loadedBytes)} /{" "}
                {formatBytes(preloadState.totalBytes)}）
              </span>
            </div>
          ) : null}
        </>
      ) : null}
      {stage === "empty" || stage === "error" ? (
        <div className="ocr-flow-error">
          <div className="ocr-flow-card" role="alert">
            <p>{errorText}</p>
            <div className="ocr-flow-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setRetryKey(value => value + 1)}>
                <RefreshCw size={14} /> 再試行
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
                <ArrowLeft size={14} /> カメラへ戻る
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
