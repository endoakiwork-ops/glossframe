import { api } from "./api";

interface TtsResponse {
  audioBase64: string;
  mimeType: string;
  cached: boolean;
}

const AUDIO_URL_CACHE_LIMIT = 12;

/** Least-recently-used object URL cache, bounded so blob URLs cannot leak forever. */
const audioUrlCache = new Map<string, string>();

let currentAudio: HTMLAudioElement | null = null;
let currentKey: string | null = null;
let pendingKey: string | null = null;

/**
 * Incremented for every play intent and every stop. Async work captures the
 * value it started with and refuses to play if it has since been superseded.
 */
let generation = 0;

let stopListenersAttached = false;

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType || "audio/mpeg" });
}

function takeCachedUrl(key: string): string | undefined {
  const url = audioUrlCache.get(key);
  if (!url) return undefined;
  // Refresh recency: Map preserves insertion order.
  audioUrlCache.delete(key);
  audioUrlCache.set(key, url);
  return url;
}

function cacheAudioUrl(key: string, url: string): string {
  const previous = audioUrlCache.get(key);
  if (previous && previous !== url) {
    audioUrlCache.delete(key);
    URL.revokeObjectURL(previous);
  }

  while (audioUrlCache.size >= AUDIO_URL_CACHE_LIMIT) {
    const oldestKey = audioUrlCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldestUrl = audioUrlCache.get(oldestKey);
    audioUrlCache.delete(oldestKey);
    if (oldestUrl) URL.revokeObjectURL(oldestUrl);
  }

  audioUrlCache.set(key, url);
  return url;
}

function releaseCurrentAudio(): void {
  const audio = currentAudio;
  currentAudio = null;
  currentKey = null;
  if (!audio) return;
  try {
    audio.pause();
    audio.currentTime = 0;
  } catch {
    // Ignore media elements that are already detached or not seekable.
  }
}

function clearCurrentAudio(audio: HTMLAudioElement): void {
  if (currentAudio !== audio) return;
  currentAudio = null;
  currentKey = null;
}

function stopWhenDocumentHidden(): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    stopCloudTts();
  }
}

function attachStopListeners(): void {
  if (stopListenersAttached) return;
  if (typeof document === "undefined" || typeof window === "undefined") return;
  document.addEventListener("visibilitychange", stopWhenDocumentHidden);
  window.addEventListener("pagehide", stopCloudTts);
  stopListenersAttached = true;
}

/**
 * Play text using Cloudflare Workers AI cloud TTS (@cf/myshell-ai/melotts) only.
 * Never falls back to browser window.speechSynthesis.
 *
 * Clicking the same text while it is loading or playing stops it instead.
 */
export async function playCloudTts(text: string, lang = "en"): Promise<void> {
  return playCloudTtsInner(text, lang);
}

/** Requests in flight, so a tap during a prefetch reuses it instead of synthesizing twice. */
const inflight = new Map<string, Promise<string>>();

function fetchAudioUrl(key: string, text: string, lang: string): Promise<string> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const request = api<TtsResponse>("/api/tts", {
    method: "POST",
    body: { text, lang },
    timeoutMs: 45_000,
  })
    .then((res) => cacheAudioUrl(key, URL.createObjectURL(base64ToBlob(res.audioBase64, res.mimeType))))
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

/** Synthesize ahead of time so a later tap plays immediately. Errors are ignored. */
export function prefetchCloudTts(text: string, lang = "en"): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const key = `${lang}:${trimmed}`;
  if (audioUrlCache.has(key)) return;
  fetchAudioUrl(key, trimmed, lang).catch(() => undefined);
}

async function playCloudTtsInner(text: string, lang: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  const key = `${lang}:${trimmed}`;
  attachStopListeners();

  // Toggle stop for the same text, including while its audio is still loading.
  if (currentKey === key || pendingKey === key) {
    stopCloudTts();
    return;
  }

  const requestGeneration = ++generation;
  pendingKey = key;
  releaseCurrentAudio();

  let url = takeCachedUrl(key);

  if (!url) {
    try {
      url = await fetchAudioUrl(key, trimmed, lang);

      // A stop or another play request happened while we were waiting.
      if (requestGeneration !== generation) return;
    } catch (error) {
      if (requestGeneration !== generation) return;
      if (pendingKey === key) pendingKey = null;
      throw error;
    }
  }

  if (requestGeneration !== generation) return;

  pendingKey = null;

  const audio = new Audio(url);
  currentAudio = audio;
  currentKey = key;

  const cleanup = () => clearCurrentAudio(audio);
  audio.addEventListener("ended", cleanup, { once: true });
  audio.addEventListener("error", cleanup, { once: true });

  try {
    await audio.play();
  } catch (error) {
    cleanup();
    // A pause caused by stop/supersede is expected; only report real failures.
    if (requestGeneration !== generation) return;
    throw error;
  }
}

export function stopCloudTts(): void {
  generation += 1;
  pendingKey = null;
  releaseCurrentAudio();
}
