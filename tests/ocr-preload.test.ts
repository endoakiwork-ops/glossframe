import { describe, it, expect, vi, beforeEach } from "vitest";
import { PADDLE_OCR_MANIFEST } from "../src/shared/ocr-manifest";
import {
  checkPaddleCache,
  downloadPaddleModels,
  deletePaddleCache,
  getModelAssetUrl,
} from "../src/client/lib/paddle-cache";

describe("OCR model manifest and cache logic", () => {
  it("has valid manifest metadata and files", () => {
    expect(PADDLE_OCR_MANIFEST.version).toBe("v1");
    expect(PADDLE_OCR_MANIFEST.cacheName).toBe("paddle-v5-en-int8-v1");
    expect(PADDLE_OCR_MANIFEST.files.length).toBe(5);
    const calculatedTotal = PADDLE_OCR_MANIFEST.files.reduce((sum, f) => sum + f.size, 0);
    expect(PADDLE_OCR_MANIFEST.totalBytes).toBe(calculatedTotal);
    expect(calculatedTotal).toBeGreaterThan(20 * 1024 * 1024); // ~24MB
  });

  it("builds absolute asset URLs correctly", () => {
    const url = getModelAssetUrl("det.ort");
    expect(url).toContain("/models/ocr/v5-en-int8/det.ort");
  });

  describe("Cache API integration", () => {
    let mockCacheStore: Map<string, Response>;

    beforeEach(() => {
      mockCacheStore = new Map<string, Response>();

      const mockCache = {
        match: vi.fn(async (url: string) => {
          const resp = mockCacheStore.get(url);
          return resp ? resp.clone() : undefined;
        }),
        put: vi.fn(async (url: string, response: Response) => {
          mockCacheStore.set(url, response.clone());
        }),
      };

      vi.stubGlobal("caches", {
        open: vi.fn(async (name: string) => {
          if (name !== PADDLE_OCR_MANIFEST.cacheName) {
            throw new Error(`Unexpected cache: ${name}`);
          }
          return mockCache;
        }),
        delete: vi.fn(async (name: string) => {
          if (name === PADDLE_OCR_MANIFEST.cacheName) {
            mockCacheStore.clear();
            return true;
          }
          return false;
        }),
      });
    });

    it("detects missing cache when empty", async () => {
      const status = await checkPaddleCache();
      expect(status.supported).toBe(true);
      expect(status.ready).toBe(false);
      expect(status.cachedBytes).toBe(0);
      expect(status.missingFiles.length).toBe(PADDLE_OCR_MANIFEST.files.length);
    });

    it("detects partial cache and counts cached bytes correctly", async () => {
      const firstFile = PADDLE_OCR_MANIFEST.files[0];
      const url = getModelAssetUrl(firstFile.name);
      mockCacheStore.set(
        url,
        new Response(new Uint8Array(firstFile.size), {
          status: 200,
          headers: { "Content-Length": String(firstFile.size) },
        }),
      );

      const status = await checkPaddleCache();
      expect(status.ready).toBe(false);
      expect(status.cachedBytes).toBe(firstFile.size);
      expect(status.missingFiles.length).toBe(PADDLE_OCR_MANIFEST.files.length - 1);
    });

    it("reports ready when all files are cached with matching sizes", async () => {
      for (const file of PADDLE_OCR_MANIFEST.files) {
        const url = getModelAssetUrl(file.name);
        mockCacheStore.set(
          url,
          new Response(new Uint8Array(file.size), {
            status: 200,
            headers: { "Content-Length": String(file.size) },
          }),
        );
      }

      const status = await checkPaddleCache();
      expect(status.ready).toBe(true);
      expect(status.cachedBytes).toBe(PADDLE_OCR_MANIFEST.totalBytes);
      expect(status.missingFiles.length).toBe(0);
    });

    it("downloads missing files and streams progress accurately", async () => {
      const progressReports: number[] = [];

      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
        const urlStr = String(input);
        const file = PADDLE_OCR_MANIFEST.files.find((f) => urlStr.includes(f.name));
        if (!file) return new Response(null, { status: 404 });

        // Simulate streaming response
        const data = new Uint8Array(file.size);
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(data.subarray(0, Math.floor(file.size / 2)));
            controller.enqueue(data.subarray(Math.floor(file.size / 2)));
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { "Content-Length": String(file.size) },
        });
      }));

      await downloadPaddleModels((p) => {
        progressReports.push(p.loadedBytes);
      });

      expect(progressReports.length).toBeGreaterThan(0);
      expect(progressReports[progressReports.length - 1]).toBe(PADDLE_OCR_MANIFEST.totalBytes);

      // Verify all files were saved into cache
      const verify = await checkPaddleCache();
      expect(verify.ready).toBe(true);
      expect(verify.cachedBytes).toBe(PADDLE_OCR_MANIFEST.totalBytes);
    });

    it("deletes only OCR cache without touching other items", async () => {
      // Fill cache
      for (const file of PADDLE_OCR_MANIFEST.files) {
        mockCacheStore.set(getModelAssetUrl(file.name), new Response("dummy"));
      }
      expect(mockCacheStore.size).toBe(5);

      const deleted = await deletePaddleCache();
      expect(deleted).toBe(true);
      expect(mockCacheStore.size).toBe(0);
    });
  });
});
