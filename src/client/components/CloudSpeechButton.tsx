import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Square, Volume2 } from "lucide-react";
import { ApiError, errorMessage } from "../lib/api";

const SPEECH_LANG = "en";

interface CloudSpeechButtonProps {
  text: string;
  lang?: string;
}

async function responseError(response: Response): Promise<Error> {
  let code = "HTTP_ERROR";
  let message = `音声を作成できませんでした (${response.status})`;
  try {
    const payload = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    if (payload.error?.code) code = payload.error.code;
    if (payload.error?.message) message = payload.error.message;
  } catch {
    // Keep the status-based fallback when the body is not JSON.
  }
  return new ApiError(response.status, code, message);
}

/**
 * Read an English sentence aloud with Workers AI (MeloTTS).
 *
 * This intentionally does not fall back to the Web Speech API: playback must
 * come from the authenticated /api/speech route so usage and caching stay on
 * the server.
 */
export function CloudSpeechButton({ text, lang }: CloudSpeechButtonProps) {
  const language = lang ?? SPEECH_LANG;
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  const releaseAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setPlaying(false);
  }, []);

  const stop = useCallback(() => {
    // Invalidates any fetch or play() continuation that is still in flight.
    requestIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    releaseAudio();
    setLoading(false);
  }, [releaseAudio]);

  // A new sentence (or a language change) must stop the previous audio.
  useEffect(() => {
    stop();
    setError("");
  }, [text, language, stop]);

  // Leaving the page or hiding the tab must not keep audio playing.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden || document.visibilityState === "hidden") stop();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [stop]);

  // Unmount cleanup: abort fetch, stop audio, and revoke the object URL.
  useEffect(() => stop, [stop]);

  const handleClick = useCallback(async () => {
    // Prevent a second request while the first one is still loading.
    if (loading) return;

    // A second click while audio exists stops playback.
    if (audioRef.current) {
      stop();
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      setError("読み上げる英文がありません。");
      return;
    }

    setError("");
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    try {
      const response = await fetch("/api/speech", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed, lang: SPEECH_LANG }),
        signal: controller.signal,
      });
      if (!response.ok) throw await responseError(response);

      const blob = await response.blob();
      if (controller.signal.aborted || requestIdRef.current !== requestId) return;
      if (!blob.size) throw new Error("音声データが空でした。もう一度お試しください。");

      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = new Audio();
      audio.preload = "auto";
      audio.src = url;
      audioRef.current = audio;
      audio.onended = () => {
        if (requestIdRef.current === requestId) releaseAudio();
      };

      // play() is only called from this click handler, never on mount.
      try {
        await audio.play();
      } catch {
        if (requestIdRef.current === requestId) {
          releaseAudio();
          setError(
            "音声を再生できませんでした。画面を操作してから、もう一度お試しください。",
          );
        }
        return;
      }

      if (controller.signal.aborted || requestIdRef.current !== requestId) return;
      setPlaying(true);
    } catch (caught) {
      if (controller.signal.aborted || requestIdRef.current !== requestId) return;
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(errorMessage(caught));
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    }
  }, [loading, text, stop, releaseAudio]);

  if (language !== SPEECH_LANG) return null;

  const label = loading ? "音声を準備中…" : playing ? "停止" : "英文を聞く";

  return (
    <div className="stack-sm" style={{ gap: 6 }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => void handleClick()}
        disabled={loading || !text.trim()}
        aria-pressed={playing}
        aria-label={loading ? "音声を準備中" : playing ? "読み上げを停止" : "英文を読み上げる"}
        title={label}
      >
        {loading ? (
          <Loader2 size={14} className="spin" />
        ) : playing ? (
          <Square size={14} />
        ) : (
          <Volume2 size={14} />
        )}
        {label}
      </button>
      <div aria-live="polite" aria-atomic="true" role="status">
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
