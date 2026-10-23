import type { OcrBBox, OcrResult } from './ocr';

// Structural browser types keep the shared OCR API usable in Node tests.
interface WorkerPort {
  postMessage(message: unknown, transfer?: unknown[]): void;
  terminate(): void;
  onmessage: ((event: { data: { result?: OcrResult; error?: string; type?: string; success?: boolean } }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
}
const browser = globalThis as unknown as {
  Worker: new (url: URL, options: { type: string }) => WorkerPort;
  createImageBitmap(input: unknown): Promise<{ close(): void }>;
};
const Worker = browser.Worker;

class PaddleOcrEngine {
  private worker: WorkerPort | null = null;
  private pending: ((error: Error) => void) | null = null;
  private initPromise: Promise<void> | null = null;
  private isInitialized = false;

  private getOrCreateWorker(): WorkerPort {
    if (!this.worker) {
      this.isInitialized = false;
      this.worker = new Worker(new URL('./paddle.worker.ts', import.meta.url), { type: 'module' });
    }
    return this.worker;
  }

  async init(): Promise<void> {
    if (this.isInitialized && this.worker) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const worker = this.getOrCreateWorker();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.terminate();
          reject(new Error('OCR engine initialization timed out'));
        }, 120_000);

        const finish = () => {
          clearTimeout(timer);
          this.pending = null;
        };

        this.pending = (error) => {
          finish();
          reject(error);
        };

        worker.onmessage = ({ data }) => {
          if (data.type === 'init_done') {
            finish();
            if (data.error) {
              this.terminate();
              reject(new Error(data.error));
            } else {
              this.isInitialized = true;
              resolve();
            }
          }
        };

        worker.onerror = (event) => {
          finish();
          this.terminate();
          reject(new Error(event.message || 'Worker initialization failed'));
        };

        try {
          worker.postMessage({ type: 'init' });
        } catch (error) {
          finish();
          reject(error);
        }
      });
    })().finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  async recognize(input: { width: number; height: number }, panels: OcrBBox[] = []): Promise<OcrResult> {
    const bitmap = await browser.createImageBitmap(input);
    try {
      const worker = this.getOrCreateWorker();
      return await new Promise<OcrResult>((resolve, reject) => {
        const timer = setTimeout(() => { void this.terminate(); }, 120_000);
        const finish = () => { clearTimeout(timer); this.pending = null; };
        this.pending = (error) => { finish(); reject(error); };
        worker.onmessage = ({ data }) => {
          if (data.type === 'init_done') return;
          finish();
          if (data.result) {
            this.isInitialized = true;
            resolve(data.result);
          } else {
            this.terminate();
            reject(new Error(data.error ?? 'OCR failed'));
          }
        };
        worker.onerror = (event) => {
          finish();
          this.terminate();
          reject(new Error(event.message || 'OCR worker error'));
        };
        try {
          worker.postMessage({ type: 'recognize', bitmap, panels }, [bitmap]);
        } catch (error) {
          finish();
          reject(error);
        }
      });
    } finally {
      try {
        bitmap?.close();
      } catch {
        // ignore
      }
    }
  }

  async terminate(): Promise<void> {
    const currentWorker = this.worker;
    this.worker = null;
    this.isInitialized = false;
    this.initPromise = null;
    if (currentWorker) {
      try {
        currentWorker.terminate();
      } catch {
        // ignore
      }
    }
    this.pending?.(new Error('OCR worker stopped or timed out'));
  }

  isReady(): boolean {
    return this.isInitialized && this.worker !== null;
  }
}

export const paddleOcrEngine = new PaddleOcrEngine();
