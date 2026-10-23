import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  Check,
  ImagePlus,
  Languages,
  RefreshCw,
} from "lucide-react";
import { languageLabel } from "../../shared/languages";
import { cameraCrop } from "../../shared/srs";
import { canvasToBlob } from "../lib/image";
import { useApp } from "../context/AppContext";
import { LanguagePicker } from "../components/LanguagePicker";
import { OcrPreloadBanner } from "../components/OcrPreloadBanner";
import { OcrFlow } from "./OcrFlow";

type CameraState = "starting" | "live" | "denied" | "unavailable";

function stopMediaStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // ignore track stop errors
    }
  }
}

export function CapturePage() {
  const { settings, updateSettings, toast } = useApp();
  const [file, setFile] = useState<File | null>(null);
  const [picker, setPicker] = useState<"source" | "target" | null>(null);
  const [cameraState, setCameraState] = useState<CameraState>("starting");
  const [cameraMessage, setCameraMessage] = useState("");
  const [capturing, setCapturing] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraEpochRef = useRef(0);
  const mountedRef = useRef(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const stopCamera = useCallback(() => {
    cameraEpochRef.current += 1;
    const activeStream = streamRef.current;
    streamRef.current = null;
    stopMediaStream(activeStream);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const startCamera = useCallback(async () => {
    stopCamera();
    const epoch = cameraEpochRef.current;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      if (mountedRef.current && epoch === cameraEpochRef.current) {
        setCameraState("unavailable");
        setCameraMessage("カメラを利用できません。写真から選ぶこともできます。");
      }
      return;
    }

    if (mountedRef.current && epoch === cameraEpochRef.current) {
      setCameraState("starting");
      setCameraMessage("");
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      if (!mountedRef.current || epoch !== cameraEpochRef.current) {
        stopMediaStream(stream);
        return;
      }

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stopCamera();
        return;
      }

      video.srcObject = stream;
      await video.play().catch(() => undefined);

      if (!mountedRef.current || epoch !== cameraEpochRef.current) {
        stopMediaStream(stream);
        return;
      }

      setCameraState("live");
    } catch (err) {
      if (!mountedRef.current || epoch !== cameraEpochRef.current) {
        return;
      }
      stopCamera();
      const name =
        err instanceof DOMException
          ? err.name
          : (err as { name?: string } | null)?.name ?? "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setCameraState("denied");
        setCameraMessage("カメラの利用を許可してください。写真から選ぶこともできます。");
      } else {
        setCameraState("unavailable");
        setCameraMessage("カメラを利用できません。写真から選ぶこともできます。");
      }
    }
  }, [stopCamera]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopCamera();
    };
  }, [stopCamera]);

  useEffect(() => {
    if (file) {
      stopCamera();
      return;
    }
    void startCamera();
    const onPageHide = () => stopCamera();
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void startCamera();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stopCamera();
      } else if (document.visibilityState === "visible") {
        void startCamera();
      }
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
      stopCamera();
    };
  }, [file, startCamera, stopCamera]);

  const acceptFile = useCallback(
    (next: File) => {
      if (!next.type.startsWith("image/")) {
        toast("画像ファイルを選んでください。", "error");
        return;
      }
      if (next.size > 30 * 1024 * 1024) {
        toast("30MB 以下の画像を選んでください。", "error");
        return;
      }
      stopCamera();
      setFile(next);
    },
    [stopCamera, toast],
  );

  function handleInput(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (selected) acceptFile(selected);
  }

  async function captureFrame() {
    if (cameraState !== "live" || !videoRef.current) {
      fileInput.current?.click();
      return;
    }
    const video = videoRef.current;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
      fileInput.current?.click();
      return;
    }
    setCapturing(true);
    try {
      const viewport = viewportRef.current;
      const boxW = video.clientWidth || viewport?.clientWidth || vw;
      const boxH = video.clientHeight || viewport?.clientHeight || vh;
      const crop = cameraCrop(vw, vh, boxW, boxH);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(crop.width));
      canvas.height = Math.max(1, Math.round(crop.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("カメラ画像の取得に失敗しました。");
      ctx.drawImage(
        video,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
      const capturedFile = new File([blob], `capture-${Date.now()}.jpg`, {
        type: blob.type || "image/jpeg",
      });
      stopCamera();
      setFile(capturedFile);
    } catch {
      toast("撮影できませんでした。写真から選ぶこともできます。", "error");
    } finally {
      if (mountedRef.current) {
        setCapturing(false);
      }
    }
  }

  const sourceLang = settings?.sourceLang ?? "en";
  const targetLang = settings?.targetLang ?? "ja";

  async function swapLanguages() {
    if (!settings) return;
    await updateSettings({
      sourceLang: settings.targetLang,
      targetLang: settings.sourceLang,
    });
  }

  if (file) {
    return <OcrFlow file={file} onCancel={() => setFile(null)} />;
  }

  return (
    <div className="camera-page">
      <section className="camera-stage-card" aria-label="カメラプレビュー">
        <OcrPreloadBanner />
        <div ref={viewportRef} className="camera-viewport">
          <video
            ref={videoRef}
            className="camera-video"
            autoPlay
            muted
            playsInline
            style={{ display: cameraState === "live" ? "block" : "none" }}
          />

          {cameraState !== "live" ? (
            <div className="camera-fallback" role="status" aria-live="polite">
              <div className="camera-fallback-card">
                <p className="camera-fallback-text">
                  {cameraState === "starting"
                    ? "カメラを起動中…"
                    : cameraMessage || "カメラを利用できません。写真から選ぶこともできます。"}
                </p>
                {cameraState !== "starting" ? (
                  <div className="camera-fallback-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => fileInput.current?.click()}
                    >
                      <ImagePlus size={15} /> 写真から選ぶ
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void startCamera()}
                    >
                      <RefreshCw size={14} /> カメラを起動
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm camera-native-btn"
                      onClick={() => cameraInput.current?.click()}
                    >
                      <Camera size={14} /> 標準カメラを起動
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="camera-controls">
          <button
            type="button"
            className="camera-pick-btn"
            onClick={() => fileInput.current?.click()}
            aria-label="写真から選ぶ"
            title="写真から選ぶ"
          >
            <ImagePlus size={21} />
          </button>

          <button
            type="button"
            className="camera-shutter-btn"
            onClick={() => void captureFrame()}
            disabled={capturing}
            aria-label={cameraState === "live" ? "撮影して翻訳" : "写真を選んで翻訳"}
            title={cameraState === "live" ? "撮影して翻訳" : "写真を選んで翻訳"}
          >
            <Check size={24} strokeWidth={2.5} />
          </button>

          <div className="camera-lang-group" role="group" aria-label="翻訳方向">
            <button
              type="button"
              className="camera-lang-pill"
              onClick={() => setPicker("source")}
              aria-label="翻訳元の言語を変更"
            >
              {languageLabel(sourceLang)}
            </button>
            <button
              type="button"
              className="camera-lang-swap"
              onClick={() => void swapLanguages()}
              aria-label="翻訳方向を入れ替える"
              title="言語を入れ替え"
            >
              <Languages size={13} />
            </button>
            <button
              type="button"
              className="camera-lang-pill"
              onClick={() => setPicker("target")}
              aria-label="翻訳先の言語を変更"
            >
              {languageLabel(targetLang)}
            </button>
          </div>
        </div>

        <input
          ref={cameraInput}
          className="sr-only"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleInput}
          aria-label="カメラで撮影"
        />
        <input
          ref={fileInput}
          className="sr-only"
          type="file"
          accept="image/*"
          onChange={handleInput}
          aria-label="画像を選択"
        />
      </section>

      <LanguagePicker
        open={picker !== null}
        title={picker === "target" ? "翻訳先の言語" : "翻訳元の言語"}
        selected={picker === "target" ? targetLang : sourceLang}
        exclude={picker === "target" ? sourceLang : targetLang}
        onSelect={(code) => {
          if (!picker) return;
          void updateSettings(
            picker === "target" ? { targetLang: code } : { sourceLang: code },
          );
        }}
        onClose={() => setPicker(null)}
      />
    </div>
  );
}
