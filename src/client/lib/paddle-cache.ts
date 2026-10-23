import { PADDLE_OCR_MANIFEST, type OcrModelFile } from "../../shared/ocr-manifest";

export interface PaddleCacheStatus {
  supported: boolean;
  ready: boolean;
  cachedBytes: number;
  totalBytes: number;
  missingFiles: OcrModelFile[];
}

export interface PaddleDownloadProgress {
  loadedBytes: number;
  totalBytes: number;
  currentFile: string;
  fileIndex: number;
  totalFiles: number;
}

interface BrowserCache {
  match(request: string | Request): Promise<Response | undefined>;
  put(request: string | Request, response: Response): Promise<void>;
}

interface BrowserCacheStorage {
  open(name: string): Promise<BrowserCache>;
  delete(name: string): Promise<boolean>;
}

function getCacheStorage(): BrowserCacheStorage | undefined {
  const g = globalThis as unknown as { caches?: BrowserCacheStorage };
  return typeof g.caches !== "undefined" && typeof g.caches.open === "function" ? g.caches : undefined;
}

export function getModelAssetUrl(filename: string): string {
  const g = globalThis as unknown as { location?: { origin: string } };
  const origin = g.location?.origin || "http://localhost";
  return new URL(filename, new URL(PADDLE_OCR_MANIFEST.basePath, origin)).href;
}

export async function checkPaddleCache(): Promise<PaddleCacheStatus> {
  const totalBytes = PADDLE_OCR_MANIFEST.totalBytes;
  const storage = getCacheStorage();
  if (!storage) {
    return {
      supported: false,
      ready: false,
      cachedBytes: 0,
      totalBytes,
      missingFiles: [...PADDLE_OCR_MANIFEST.files],
    };
  }

  try {
    const cache = await storage.open(PADDLE_OCR_MANIFEST.cacheName);
    let cachedBytes = 0;
    const missingFiles: OcrModelFile[] = [];

    for (const file of PADDLE_OCR_MANIFEST.files) {
      const url = getModelAssetUrl(file.name);
      const match = await cache.match(url);
      if (!match || !match.ok) {
        missingFiles.push(file);
        continue;
      }
      const cl = match.headers.get("content-length");
      if (cl) {
        const size = parseInt(cl, 10);
        if (Number.isFinite(size) && size === file.size) {
          cachedBytes += size;
          continue;
        }
      }
      // Content-Length missing or mismatched: check blob size
      try {
        const blob = await match.clone().blob();
        if (blob.size === file.size || (blob.size > 0 && Math.abs(blob.size - file.size) < 1024)) {
          cachedBytes += file.size;
        } else {
          missingFiles.push(file);
        }
      } catch {
        missingFiles.push(file);
      }
    }

    const ready = missingFiles.length === 0;
    return {
      supported: true,
      ready,
      cachedBytes: ready ? totalBytes : cachedBytes,
      totalBytes,
      missingFiles,
    };
  } catch (error) {
    console.warn("Failed to check PaddleOCR cache", error);
    return {
      supported: true,
      ready: false,
      cachedBytes: 0,
      totalBytes,
      missingFiles: [...PADDLE_OCR_MANIFEST.files],
    };
  }
}

export async function downloadPaddleModels(
  onProgress?: (progress: PaddleDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const totalBytes = PADDLE_OCR_MANIFEST.totalBytes;
  const status = await checkPaddleCache();
  if (status.ready) {
    onProgress?.({
      loadedBytes: totalBytes,
      totalBytes,
      currentFile: "",
      fileIndex: PADDLE_OCR_MANIFEST.files.length,
      totalFiles: PADDLE_OCR_MANIFEST.files.length,
    });
    return;
  }

  const storage = getCacheStorage();
  let cache: BrowserCache | null = null;
  if (storage) {
    try {
      cache = await storage.open(PADDLE_OCR_MANIFEST.cacheName);
    } catch {
      cache = null;
    }
  }

  let totalLoaded = status.cachedBytes;
  const filesToFetch = status.missingFiles;

  for (let i = 0; i < filesToFetch.length; i++) {
    if (signal?.aborted) throw new Error("モデルの取得が中断されました。");
    const file = filesToFetch[i];
    const url = getModelAssetUrl(file.name);

    onProgress?.({
      loadedBytes: totalLoaded,
      totalBytes,
      currentFile: file.name,
      fileIndex: PADDLE_OCR_MANIFEST.files.length - filesToFetch.length + i,
      totalFiles: PADDLE_OCR_MANIFEST.files.length,
    });

    const response = await fetch(url, {
      signal,
      headers: { "Cache-Control": "no-cache" },
    });

    if (!response.ok) {
      throw new Error(`モデルファイルの取得に失敗しました: ${file.name} (${response.status})`);
    }

    const reader = response.body?.getReader();
    const chunks: unknown[] = [];
    let fileLoaded = 0;

    if (reader) {
      while (true) {
        if (signal?.aborted) {
          reader.cancel();
          throw new Error("モデルの取得が中断されました。");
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          fileLoaded += value.byteLength;
          onProgress?.({
            loadedBytes: Math.min(totalBytes, totalLoaded + fileLoaded),
            totalBytes,
            currentFile: file.name,
            fileIndex: PADDLE_OCR_MANIFEST.files.length - filesToFetch.length + i,
            totalFiles: PADDLE_OCR_MANIFEST.files.length,
          });
        }
      }
    } else {
      const buffer = await response.arrayBuffer();
      chunks.push(buffer);
      fileLoaded = buffer.byteLength;
    }

    totalLoaded += fileLoaded;
    const blob = new Blob(chunks as any, {
      type: file.name.endsWith(".wasm")
        ? "application/wasm"
        : file.name.endsWith(".mjs")
          ? "text/javascript"
          : "application/octet-stream",
    });

    if (cache) {
      const responseToCache = new Response(blob, {
        status: 200,
        headers: {
          "Content-Type": blob.type,
          "Content-Length": String(blob.size),
          "X-Paddle-Version": PADDLE_OCR_MANIFEST.version,
        },
      });
      await cache.put(url, responseToCache);
    }
  }

  // Final verification
  const verify = await checkPaddleCache();
  if (verify.supported && !verify.ready) {
    throw new Error(
      `モデルキャッシュの保存に失敗しました（欠損: ${verify.missingFiles.map((f) => f.name).join(", ")}）`,
    );
  }
}

export async function deletePaddleCache(): Promise<boolean> {
  const storage = getCacheStorage();
  if (!storage) return false;
  try {
    return await storage.delete(PADDLE_OCR_MANIFEST.cacheName);
  } catch {
    return false;
  }
}

export async function getPaddleCacheSize(): Promise<number> {
  const status = await checkPaddleCache();
  return status.cachedBytes;
}
