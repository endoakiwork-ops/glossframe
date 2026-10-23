import { afterEach, describe, expect, it, vi } from "vitest";

const { createWorkerMock } = vi.hoisted(() => ({ createWorkerMock: vi.fn() }));

vi.mock("tesseract.js", () => ({
  default: { createWorker: createWorkerMock },
}));

import {
  setOcrBackend,
  recognize,
  recognizeRegion,
  terminateOcr,
  type OcrResult,
} from "../src/client/lib/ocr";

setOcrBackend("tesseract");

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface LoggerMessage {
  status: string;
  progress: number;
}

interface FakeWorkerOptions {
  logger?: (message: LoggerMessage) => void;
  errorHandler?: (error: unknown) => void;
}

interface FakeWorker {
  lang: string;
  options: FakeWorkerOptions;
  recognize: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  setParameters: ReturnType<typeof vi.fn>;
  pending: Array<Deferred<{ data: unknown }>>;
}

/**
 * Installs a Tesseract double. Each recognize call returns a promise that the
 * test resolves explicitly, so ordering and progress routing can be observed.
 */
function installWorkers() {
  const workers: FakeWorker[] = [];
  const events: string[] = [];

  createWorkerMock.mockImplementation(
    async (lang: string, _oem: unknown, options: FakeWorkerOptions) => {
      const worker: FakeWorker = {
        lang,
        options,
        recognize: vi.fn(() => {
          const pending = deferred<{ data: unknown }>();
          worker.pending.push(pending);
          events.push(`recognize:${lang}`);
          return pending.promise;
        }),
        terminate: vi.fn(async () => {
          events.push(`terminate:${lang}`);
        }),
        setParameters: vi.fn(async () => {
          events.push(`params:${lang}`);
        }),
        pending: [],
      };
      workers.push(worker);
      events.push(`create:${lang}`);
      return worker;
    },
  );

  return { workers, events };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function result(text: string, confidence = 90): { data: unknown } {
  return { data: { text, confidence, blocks: [] } };
}

const canvas = { width: 200, height: 100 } as Parameters<typeof recognize>[0];

afterEach(async () => {
  await terminateOcr();
  createWorkerMock.mockReset();
  vi.restoreAllMocks();
});

describe("OCR serialization", () => {
  it("runs concurrent recognitions in call order and routes progress to the active call", async () => {
    const { workers } = installWorkers();
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();

    const first = recognize(canvas, "en", firstProgress);
    const second = recognize(canvas, "en", secondProgress);
    await settle();

    expect(createWorkerMock).toHaveBeenCalledTimes(1);
    expect(workers[0].recognize).toHaveBeenCalledTimes(1);

    workers[0].options.logger?.({ status: "recognizing text", progress: 0.4 });
    expect(firstProgress).toHaveBeenCalledWith({ status: "recognizing text", progress: 0.4 });
    expect(secondProgress).not.toHaveBeenCalled();

    workers[0].pending[0].resolve(result("first"));
    await expect(first).resolves.toMatchObject({ text: "first" });
    await settle();

    expect(workers[0].recognize).toHaveBeenCalledTimes(2);
    expect(firstProgress).toHaveBeenCalledTimes(1);
    expect(secondProgress).not.toHaveBeenCalled();

    workers[0].options.logger?.({ status: "recognizing text", progress: 0.8 });
    expect(secondProgress).toHaveBeenCalledWith({ status: "recognizing text", progress: 0.8 });
    expect(firstProgress).toHaveBeenCalledTimes(1);

    workers[0].pending[1].resolve(result("second"));
    await expect(second).resolves.toMatchObject({ text: "second" });
  });

  it("keeps region recognition queued behind a full recognition", async () => {
    const { workers } = installWorkers();
    const fullProgress = vi.fn();
    const regionProgress = vi.fn();

    const full = recognize(canvas, "en", fullProgress);
    const region = recognizeRegion(canvas, { x: 1.4, y: 2.6, width: 0, height: 10 }, "en", regionProgress);
    await settle();

    expect(workers[0].recognize).toHaveBeenCalledTimes(1);
    expect(regionProgress).not.toHaveBeenCalled();

    workers[0].options.logger?.({ status: "recognizing text", progress: 0.25 });
    expect(fullProgress).toHaveBeenCalledWith({ status: "recognizing text", progress: 0.25 });
    expect(regionProgress).not.toHaveBeenCalled();

    workers[0].pending[0].resolve(result("full page"));
    await full;
    await settle();

    expect(workers[0].recognize).toHaveBeenCalledTimes(2);
    expect(workers[0].recognize).toHaveBeenLastCalledWith(
      canvas,
      { rectangle: { left: 1, top: 3, width: 1, height: 10 }, rotateAuto: false },
      { text: true },
    );

    workers[0].options.logger?.({ status: "recognizing text", progress: 0.9 });
    expect(regionProgress).toHaveBeenCalledWith({ status: "recognizing text", progress: 0.9 });
    expect(fullProgress).toHaveBeenCalledTimes(1);

    workers[0].pending[1].resolve(result("region text"));
    await expect(region).resolves.toBe("region text");
  });

  it("terminates the old worker before creating one for a different language", async () => {
    const { workers, events } = installWorkers();

    const first = recognize(canvas, "en");
    const second = recognize(canvas, "ja");
    await settle();

    expect(workers).toHaveLength(1);
    expect(workers[0].recognize).toHaveBeenCalledTimes(1);

    workers[0].pending[0].resolve(result("english"));
    await first;
    await settle();

    expect(workers).toHaveLength(2);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(events.indexOf("terminate:eng+jpn")).toBeGreaterThan(events.indexOf("recognize:eng+jpn"));
    expect(events.indexOf("create:jpn")).toBeGreaterThan(events.indexOf("terminate:eng+jpn"));
    expect(workers[1].recognize).toHaveBeenCalledTimes(1);

    workers[1].pending[0].resolve(result("japanese"));
    await expect(second).resolves.toMatchObject({ text: "japanese" });
  });

  it("serializes termination behind in-flight work and recreates the worker afterwards", async () => {
    const { workers, events } = installWorkers();
    const afterProgress = vi.fn();

    const first = recognize(canvas, "en");
    await settle();
    const termination = terminateOcr();
    const after = recognize(canvas, "en", afterProgress);
    await settle();

    expect(workers[0].terminate).not.toHaveBeenCalled();

    workers[0].pending[0].resolve(result("before terminate"));
    await first;
    await termination;

    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    await settle();

    expect(workers).toHaveLength(2);
    expect(events.indexOf("create:eng+jpn")).toBeLessThan(events.indexOf("terminate:eng+jpn"));
    expect(events.lastIndexOf("create:eng+jpn")).toBeGreaterThan(events.indexOf("terminate:eng+jpn"));

    // A log still arriving from the terminated worker must not be delivered to
    // the call that is now using the replacement worker.
    workers[0].options.logger?.({ status: "recognizing text", progress: 0.3 });
    expect(afterProgress).not.toHaveBeenCalled();

    workers[1].options.logger?.({ status: "recognizing text", progress: 0.6 });
    expect(afterProgress).toHaveBeenCalledWith({ status: "recognizing text", progress: 0.6 });

    workers[1].pending[0].resolve(result("after terminate"));
    await expect(after).resolves.toMatchObject({ text: "after terminate" });
  });
});

describe("OCR failure recovery", () => {
  it("retries initialization after createWorker fails", async () => {
    const { workers } = installWorkers();
    createWorkerMock.mockRejectedValueOnce(new Error("language data unavailable"));

    await expect(recognize(canvas, "en")).rejects.toThrow("language data unavailable");
    expect(createWorkerMock).toHaveBeenCalledTimes(1);

    const progress = vi.fn();
    const retry = recognize(canvas, "en", progress);
    await settle();

    expect(createWorkerMock).toHaveBeenCalledTimes(2);
    expect(workers).toHaveLength(1);

    workers[0].options.logger?.({ status: "loading language traineddata", progress: 0.5 });
    expect(progress).toHaveBeenCalledWith({ status: "loading language traineddata", progress: 0.5 });

    workers[0].pending[0].resolve(result("retried"));
    await expect(retry).resolves.toMatchObject({ text: "retried" });
  });

  it("recovers the queue after a recognition error and does not leak progress to the next call", async () => {
    const { workers } = installWorkers();
    const failedProgress = vi.fn();
    const nextProgress = vi.fn();

    const failed = recognize(canvas, "en", failedProgress);
    const next = recognize(canvas, "en", nextProgress);
    await settle();

    expect(workers[0].recognize).toHaveBeenCalledTimes(1);

    workers[0].pending[0].reject(new Error("recognition exploded"));
    await expect(failed).rejects.toThrow("recognition exploded");
    await settle();

    expect(createWorkerMock).toHaveBeenCalledTimes(1);
    expect(workers[0].recognize).toHaveBeenCalledTimes(2);

    workers[0].options.logger?.({ status: "recognizing text", progress: 0.7 });
    expect(nextProgress).toHaveBeenCalledWith({ status: "recognizing text", progress: 0.7 });
    expect(failedProgress).not.toHaveBeenCalled();

    workers[0].pending[1].resolve(result("next"));
    await expect(next).resolves.toMatchObject({ text: "next" });
  });

  it("does not leave a rejected job at the head of the queue", async () => {
    const { workers } = installWorkers();
    const failedProgress = vi.fn();
    const nextProgress = vi.fn();

    const failed = recognize(canvas, "en", failedProgress);
    await settle();
    workers[0].pending[0].reject(new Error("first job failed"));
    await expect(failed).rejects.toThrow("first job failed");

    const next = recognize(canvas, "en", nextProgress);
    await settle();

    expect(workers[0].recognize).toHaveBeenCalledTimes(2);
    workers[0].options.logger?.({ status: "recognizing text", progress: 0.6 });
    expect(nextProgress).toHaveBeenCalledWith({ status: "recognizing text", progress: 0.6 });
    expect(failedProgress).not.toHaveBeenCalled();

    workers[0].pending[1].resolve(result("recovered"));
    const value: OcrResult = await next;
    expect(value.text).toBe("recovered");
  });
});

describe("positioned text quality", () => {
  it("uses sparse text layout and excludes low-confidence drawing regions", async () => {
    const {workers} = installWorkers();
    const pending = recognize(canvas, "en");
    await settle();
    expect(workers[0].setParameters).toHaveBeenCalledWith(expect.objectContaining({tessedit_pageseg_mode:"11"}));
    workers[0].pending[0].resolve({data:{text:"noise Hello.",blocks:[{paragraphs:[
      {text:"/T ar 4 Cr",confidence:22,bbox:{x0:0,y0:0,x1:200,y1:100}},
      {text:"Hello.",confidence:92,bbox:{x0:20,y0:20,x1:80,y1:40}},
    ]}]}});
    expect((await pending).regions).toEqual([{id:"r0",text:"Hello.",confidence:92,bbox:{x0:20,y0:20,x1:80,y1:40}}]);
  });
  it("does not cover the image with unpositioned text", async () => {
    const {workers} = installWorkers();
    const pending = recognize(canvas, "en");
    await settle();
    workers[0].pending[0].resolve(result("text without geometry"));
    expect((await pending).regions).toEqual([]);
  });
});
