import { expandSingleLineRegions } from "../../shared/ocr-panels";
import { regionsFromOcrPage, mergeOcrPasses, panelNeedsRecognition, foreignTextBoxes } from "../../shared/ocr-layout";
import Tesseract from "tesseract.js";
import { tesseractLang } from "../../shared/languages";

export interface OcrBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrRegion {
  id: string;
  text: string;
  bbox: OcrBBox;
  confidence: number;
}

export interface OcrResult {
  text: string;
  regions: OcrRegion[];
  confidence: number;
  /** Overlapping text areas that still overlapped after three re-reads and were dropped. */
  unresolved?: number;
}

export interface OcrProgress {
  status: string;
  progress: number;
}

type TesseractWorker = Awaited<ReturnType<typeof Tesseract.createWorker>>;
type ProgressHandler = (message: OcrProgress) => void;

/**
 * Structural subset of HTMLCanvasElement. Keeping this module free of direct
 * DOM type references lets it be pulled into the worker tsconfig (which has no
 * DOM lib) by tests, while client callers can still pass a real canvas.
 */
type OcrCanvas = {
  width: number;
  height: number;
};

type TesseractImage = Parameters<TesseractWorker["recognize"]>[0];

interface OcrTask {
  onProgress: ProgressHandler | null;
}

export type OcrBackend = "tesseract" | "paddle";

let currentBackend: OcrBackend = "paddle";

export function getOcrBackend(): OcrBackend {
  return currentBackend;
}

export function setOcrBackend(backend: OcrBackend): void {
  currentBackend = backend;
}

let worker: TesseractWorker | null = null;
let workerLang = "";
let workerGeneration = 0;
let activeTask: OcrTask | null = null;

/**
 * Worker creation/termination is serialized separately from the job queue so a
 * caller can never observe (or create) two workers for overlapping requests.
 */
let workerGate: Promise<unknown> = Promise.resolve();

/**
 * All public OCR operations run in call order. Keeping the tail resolved means
 * a failed job never poisons the queue for the next request.
 */
let jobQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = jobQueue.then(task, task);
  jobQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function withWorkerGate<T>(task: () => Promise<T>): Promise<T> {
  const result = workerGate.then(task, task);
  workerGate = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function emitProgress(message: { status?: unknown; progress?: unknown }): void {
  const handler = activeTask?.onProgress;
  if (!handler) return;
  handler({
    status: String(message.status ?? ""),
    progress: Number(message.progress ?? 0),
  });
}

async function disposeWorkerLocked(): Promise<void> {
  workerGeneration += 1;
  const stale = worker;
  worker = null;
  workerLang = "";
  if (!stale) return;
  try {
    await stale.terminate();
  } catch {
    // Ignore termination errors from a stale worker.
  }
}

function normalizeText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getWorker(lang: string): Promise<TesseractWorker> {
  const code = lang === "en" ? "eng+jpn" : tesseractLang(lang);
  return withWorkerGate(async () => {
    if (worker && workerLang === code) return worker;

    await disposeWorkerLocked();
    const generation = workerGeneration;
    let created: TesseractWorker;
    try {
      created = await Tesseract.createWorker(code, undefined, {
        logger: (message) => {
          // A terminated worker can still deliver a final log message. Do not
          // leak that into the progress callback of whichever task runs next.
          if (generation !== workerGeneration) return;
          emitProgress(message);
        },
        errorHandler: (error) => {
          if (generation !== workerGeneration) return;
          console.warn("Tesseract worker error", error);
        },
      });
    } catch (error) {
      // Invalidate any log callback that may still be queued by the failed
      // initialization, then leave no cached state so the next call retries.
      workerGeneration += 1;
      throw error;
    }

    if (generation !== workerGeneration) {
      try {
        await created.terminate();
      } catch {
        // The worker is already stale; nothing else to clean up.
      }
      throw new Error("OCR worker initialization was superseded");
    }

    worker = created;
    workerLang = code;
    try {
      await created.setParameters({ preserve_interword_spaces: "1", tessedit_pageseg_mode: "11" as Tesseract.PSM });
    } catch {
      // Parameter support varies slightly by Tesseract build.
    }
    return created;
  });
}

export function recognize(
  canvas: OcrCanvas,
  lang: string,
  onProgress?: (message: OcrProgress) => void,
  contrastImage?: OcrCanvas,
  panels: OcrBBox[] = [],
): Promise<OcrResult> {
  return enqueue(async () => {
    const task: OcrTask = { onProgress: onProgress ?? null };
    activeTask = task;
    try {
      if (currentBackend === "paddle" && lang === "en") {
        try {
          const { paddleOcrEngine } = await import("./paddle-ocr");
          emitProgress({ status: "文字を認識中", progress: 0.5 });
          return await paddleOcrEngine.recognize(canvas, panels);
        } catch (paddleError) {
          console.warn("PaddleOCR failed, falling back to Tesseract:", paddleError);
        }
      }

      const activeWorker = await getWorker(lang);
      const result = await activeWorker.recognize(
        canvas as unknown as TesseractImage,
        { rotateAuto: false },
        { blocks: true, text: true },
      );
      const page = result.data as unknown as {
        text?: string;
        confidence?: number;
        blocks?: unknown[];
      };
      const text = normalizeText(page.text ?? "");
      const lexicon = lang === "en" ? new Set((await import("../../shared/english-words.json")).default) : undefined;
      const originalPage = page as Parameters<typeof regionsFromOcrPage>[0];
      const passes = [regionsFromOcrPage(originalPage, lang, lexicon)];
      if (contrastImage) {
        const contrast = await activeWorker.recognize(contrastImage as unknown as TesseractImage, {rotateAuto:false}, {blocks:true,text:true});
        passes.push(regionsFromOcrPage(contrast.data, lang, lexicon));
      }
      const retryPanels = lexicon ? panels.filter(panel=>panelNeedsRecognition(originalPage,panel,lexicon)).slice(0,8) : [];
      if (retryPanels.length) {
        await activeWorker.setParameters({tessedit_pageseg_mode:"6" as Tesseract.PSM});
        try {
          for (const panel of retryPanels) {
            const refined = await activeWorker.recognize(canvas as unknown as TesseractImage, {rotateAuto:false,rectangle:{left:panel.x0,top:panel.y0,width:panel.x1-panel.x0,height:panel.y1-panel.y0}}, {blocks:true,text:true});
            passes.push(regionsFromOcrPage(refined.data,lang,lexicon));
          }
        } finally {
          await activeWorker.setParameters({tessedit_pageseg_mode:"11" as Tesseract.PSM});
        }
      }
      const regions = expandSingleLineRegions(mergeOcrPasses(...passes), panels, lang === "en" ? foreignTextBoxes(originalPage) : []).map((region,index)=>({id:`r${index}`, ...region}));
      return {
        text,
        regions,
        confidence: Number(page.confidence ?? 0),
      };
    } finally {
      if (activeTask === task) activeTask = null;
    }
  });
}

export function recognizeRegion(
  canvas: OcrCanvas,
  rect: { x: number; y: number; width: number; height: number },
  lang: string,
  onProgress?: (message: OcrProgress) => void,
): Promise<string> {
  return enqueue(async () => {
    const task: OcrTask = { onProgress: onProgress ?? null };
    activeTask = task;
    try {
      const activeWorker = await getWorker(lang);
      const result = await activeWorker.recognize(
        canvas as unknown as TesseractImage,
        {
          rectangle: {
            left: Math.round(rect.x),
            top: Math.round(rect.y),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
          },
          rotateAuto: false,
        },
        { text: true },
      );
      const page = result.data as unknown as { text?: string };
      return normalizeText(page.text ?? "");
    } finally {
      if (activeTask === task) activeTask = null;
    }
  });
}

export function terminateOcr(): Promise<void> {
  return enqueue(async () => {
    activeTask = null;
    try {
      const { paddleOcrEngine } = await import("./paddle-ocr");
      await paddleOcrEngine.terminate();
    } catch {
      // ignore
    }
    await withWorkerGate(disposeWorkerLocked);
  });
}

const STATUS_LABELS: Record<string, string> = {
  "loading tesseract core": "OCRエンジンを準備中",
  "initializing tesseract": "OCRエンジンを初期化中",
  "loading language traineddata": "言語データを読み込み中",
  "initializing api": "認識を準備中",
  "recognizing text": "文字を認識中",
};

export function ocrStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? (status ? "OCRを実行中" : "準備中");
}
