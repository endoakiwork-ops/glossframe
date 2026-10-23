import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("../src/client/lib/api", () => ({ api: apiMock }));

interface TtsResponse {
  audioBase64: string;
  mimeType: string;
  cached: boolean;
}

type Listener = (event: { type: string }) => void;

interface ListenerEntry {
  listener: Listener;
  once: boolean;
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  static playHandler: ((audio: FakeAudio) => Promise<void>) | null = null;

  src: string;
  currentTime = 0;
  paused = true;
  playCalls = 0;
  pauseCalls = 0;
  private listeners = new Map<string, ListenerEntry[]>();

  play = vi.fn((): Promise<void> => {
    this.playCalls += 1;
    this.paused = false;
    return FakeAudio.playHandler
      ? FakeAudio.playHandler(this)
      : Promise.resolve();
  });

  pause = vi.fn((): void => {
    this.pauseCalls += 1;
    this.paused = true;
  });

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: Listener,
    options?: AddEventListenerOptions | boolean,
  ): void {
    const once = typeof options === "object" && options.once === true;
    const entries = this.listeners.get(type) ?? [];
    entries.push({ listener, once });
    this.listeners.set(type, entries);
  }

  removeEventListener(type: string, listener: Listener): void {
    const entries = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      entries.filter((entry) => entry.listener !== listener),
    );
  }

  emit(type: string): void {
    const entries = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      entries.filter((entry) => !entry.once),
    );
    for (const entry of entries) entry.listener({ type });
  }
}

interface FakeEventTarget {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  dispatch: (type: string) => void;
  listeners: Map<string, Set<Listener>>;
}

function createEventTarget(extra: Record<string, unknown> = {}): FakeEventTarget {
  const listeners = new Map<string, Set<Listener>>();
  return {
    ...extra,
    listeners,
    addEventListener: vi.fn((type: string, listener: Listener) => {
      const entries = listeners.get(type) ?? new Set<Listener>();
      entries.add(listener);
      listeners.set(type, entries);
    }),
    removeEventListener: vi.fn((type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatch: (type: string) => {
      for (const listener of listeners.get(type) ?? []) {
        listener({ type });
      }
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function ttsResponse(text = "audio"): TtsResponse {
  return {
    audioBase64: Buffer.from(text).toString("base64"),
    mimeType: "audio/mpeg",
    cached: false,
  };
}

let playCloudTts: typeof import("../src/client/lib/audio").playCloudTts;
let stopCloudTts: typeof import("../src/client/lib/audio").stopCloudTts;
let prefetchCloudTts: typeof import("../src/client/lib/audio").prefetchCloudTts;
let documentMock: FakeEventTarget & { visibilityState?: string };
let windowMock: FakeEventTarget;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  apiMock.mockReset();
  FakeAudio.instances = [];
  FakeAudio.playHandler = null;

  let urlSequence = 0;
  createObjectURL = vi.fn(() => `blob:mock-${++urlSequence}`);
  revokeObjectURL = vi.fn();

  const RealUrl = globalThis.URL;
  class TestUrl extends RealUrl {}
  Object.assign(TestUrl, { createObjectURL, revokeObjectURL });
  vi.stubGlobal("URL", TestUrl);

  documentMock = createEventTarget({ visibilityState: "visible" });
  windowMock = createEventTarget();
  vi.stubGlobal("document", documentMock);
  vi.stubGlobal("window", windowMock);
  vi.stubGlobal("Audio", FakeAudio);

  const module = await import("../src/client/lib/audio");
  playCloudTts = module.playCloudTts;
  stopCloudTts = module.stopCloudTts;
  prefetchCloudTts = module.prefetchCloudTts;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playCloudTts cache", () => {
  it("reuses a cached object URL when switching back to earlier text", async () => {
    apiMock.mockResolvedValue(ttsResponse());

    await playCloudTts("First");
    await playCloudTts("Second");
    await playCloudTts("First");

    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(FakeAudio.instances.map((audio) => audio.src)).toEqual([
      "blob:mock-1",
      "blob:mock-2",
      "blob:mock-1",
    ]);
  });

  it("bounds the URL cache at 12 entries and revokes each eviction", async () => {
    for (let index = 0; index < 13; index += 1) {
      apiMock.mockResolvedValueOnce(ttsResponse(`audio-${index}`));
      await playCloudTts(`Text ${index}`);
    }

    expect(apiMock).toHaveBeenCalledTimes(13);
    expect(createObjectURL).toHaveBeenCalledTimes(13);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-1");

    // The oldest entry was evicted, so this must fetch instead of reuse it.
    apiMock.mockResolvedValueOnce(ttsResponse("audio-0-again"));
    await playCloudTts("Text 0");

    expect(apiMock).toHaveBeenCalledTimes(14);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenLastCalledWith("blob:mock-2");
  });
});

describe("playCloudTts toggling and races", () => {
  it("stops playback when the same text is clicked again", async () => {
    apiMock.mockResolvedValueOnce(ttsResponse());

    await playCloudTts("Hello");
    const first = FakeAudio.instances[0];
    expect(first.playCalls).toBe(1);

    await playCloudTts("Hello");

    expect(first.pause).toHaveBeenCalledTimes(1);
    expect(first.currentTime).toBe(0);
    expect(FakeAudio.instances).toHaveLength(1);

    // A third click starts it again rather than remaining stopped.
    await playCloudTts("Hello");
    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[1].playCalls).toBe(1);
  });

  it("stops a loading request when the same text is clicked again", async () => {
    const pending = deferred<TtsResponse>();
    apiMock.mockReturnValueOnce(pending.promise);

    const first = playCloudTts("Loading");
    const second = playCloudTts("Loading");
    await second;

    pending.resolve(ttsResponse());
    await first;

    expect(apiMock).toHaveBeenCalledTimes(1);
    // The audio is kept for the next tap, but never played after the stop.
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("does not play a response that arrives after stopCloudTts", async () => {
    const pending = deferred<TtsResponse>();
    apiMock.mockReturnValueOnce(pending.promise);

    const request = playCloudTts("Stopped");
    stopCloudTts();
    pending.resolve(ttsResponse());
    await request;

    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("does not autoplay a superseded request even when responses arrive out of order", async () => {
    const first = deferred<TtsResponse>();
    const second = deferred<TtsResponse>();
    apiMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const firstPlay = playCloudTts("First text");
    const secondPlay = playCloudTts("Second text");

    second.resolve(ttsResponse("second"));
    await secondPlay;

    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].src).toBe("blob:mock-1");

    first.resolve(ttsResponse("first"));
    await firstPlay;

    // The late response is cached for reuse but does not start playing.
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].src).toBe("blob:mock-1");
  });

  it("reuses a prefetch instead of synthesizing again", async () => {
    const pending = deferred<TtsResponse>();
    apiMock.mockReturnValueOnce(pending.promise);

    prefetchCloudTts("Prefetched");
    const play = playCloudTts("Prefetched");
    pending.resolve(ttsResponse());
    await play;

    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].playCalls).toBe(1);
  });

  it("swallows play() rejection caused by stopping during playback start", async () => {
    const playStarted = deferred<void>();
    const playResult = deferred<void>();
    FakeAudio.playHandler = () => {
      playStarted.resolve();
      return playResult.promise;
    };
    apiMock.mockResolvedValueOnce(ttsResponse());

    const request = playCloudTts("Delayed play");
    await playStarted.promise;

    stopCloudTts();
    playResult.reject(new DOMException("Playback aborted", "AbortError"));

    await expect(request).resolves.toBeUndefined();
    expect(FakeAudio.instances[0].pause).toHaveBeenCalledTimes(1);
  });
});

describe("playCloudTts cleanup", () => {
  it("clears state after ended so the same text can play again", async () => {
    apiMock.mockResolvedValueOnce(ttsResponse());

    await playCloudTts("Repeat");
    expect(FakeAudio.instances).toHaveLength(1);

    FakeAudio.instances[0].emit("ended");
    await playCloudTts("Repeat");

    expect(FakeAudio.instances).toHaveLength(2);
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("clears state after a media error so the same text can play again", async () => {
    apiMock.mockResolvedValueOnce(ttsResponse());

    await playCloudTts("Broken");
    FakeAudio.instances[0].emit("error");

    await playCloudTts("Broken");

    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[1].playCalls).toBe(1);
  });

  it("propagates play() failures and clears the current audio", async () => {
    apiMock.mockResolvedValueOnce(ttsResponse());
    FakeAudio.playHandler = () => Promise.reject(new Error("blocked by browser"));

    await expect(playCloudTts("Blocked")).rejects.toThrow("blocked by browser");

    FakeAudio.playHandler = null;
    await playCloudTts("Blocked");

    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[1].playCalls).toBe(1);
  });
});

describe("playCloudTts lifecycle stops", () => {
  it("stops playback when the document becomes hidden", async () => {
    apiMock.mockResolvedValueOnce(ttsResponse());
    await playCloudTts("Hidden");

    const audio = FakeAudio.instances[0];
    documentMock.visibilityState = "hidden";
    documentMock.dispatch("visibilitychange");

    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0);
  });

  it("stops playback on pagehide", async () => {
    apiMock.mockResolvedValueOnce(ttsResponse());
    await playCloudTts("Leaving");

    const audio = FakeAudio.instances[0];
    windowMock.dispatch("pagehide");

    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.currentTime).toBe(0);
  });
});
