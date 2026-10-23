import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Loader2, Minimize2 } from "lucide-react";
import type { TranslationRegion } from "../../shared/translation-regions";

export interface TranslationImageProps {
  src: string;
  regions: TranslationRegion[];
  activeId?: string | null;
  onSelect?: (region: TranslationRegion) => void;
  showOriginal?: boolean;
}

interface SafeBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface NaturalSize {
  width: number;
  height: number;
}

interface FrameSize {
  width: number;
  height: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function safeBounds(region: TranslationRegion): SafeBounds | null {
  if (!region) return null;
  const x = Number(region.x);
  const y = Number(region.y);
  const width = Number(region.width);
  const height = Number(region.height);
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;

  const left = clamp01(x);
  const top = clamp01(y);
  const right = clamp01(x + width);
  const bottom = clamp01(y + height);
  if (right <= left || bottom <= top) return null;

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

interface ZoomTransform {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 1;
const MAX_SCALE = 5;
// Finger travel below this is still a tap, so region buttons keep working.
const TAP_SLOP = 8;

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The image and its OCR boxes share one measured box. The wrapper is sized to
 * the largest rectangle that fits the available space, so `object-fit:
 * contain` never leaves invisible letterboxing between the picture and the
 * translated regions.
 */
export function TranslationImage({
  src,
  regions,
  activeId = null,
  onSelect,
  showOriginal = false,
}: TranslationImageProps) {
  const fitRef = useRef<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState<NaturalSize | null>(null);
  const [frame, setFrame] = useState<FrameSize | null>(null);
  const [failed, setFailed] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<ZoomTransform>({ scale: 1, x: 0, y: 0 });
  const [zoomed, setZoomed] = useState(false);

  /**
   * Pinch and pan are handled here instead of by the browser. Browser zoom
   * also shrinks the visual viewport, which the result screen follows, so the
   * picture would re-fit itself mid-gesture and fight the user's fingers.
   */
  const applyZoom = useCallback(
    (next: ZoomTransform, animate = false) => {
      const fit = fitRef.current;
      const element = frameRef.current;
      if (!fit || !element || !frame) return;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next.scale));
      const maxX = Math.max(0, (frame.width * scale - fit.clientWidth) / 2);
      const maxY = Math.max(0, (frame.height * scale - fit.clientHeight) / 2);
      const value = {
        scale,
        x: Math.min(maxX, Math.max(-maxX, next.x)),
        y: Math.min(maxY, Math.max(-maxY, next.y)),
      };
      zoomRef.current = value;
      element.style.transition = animate ? "transform 180ms ease" : "none";
      element.style.transform =
        value.scale === 1 ? "" : `translate(${value.x}px, ${value.y}px) scale(${value.scale})`;
      setZoomed(value.scale > 1.01);
    },
    [frame],
  );

  // Re-clamp when the stage changes size, e.g. the reading card opens.
  useEffect(() => {
    applyZoom(zoomRef.current);
  }, [applyZoom]);

  useEffect(() => {
    const fit = fitRef.current;
    if (!fit) return;

    const pointers = new Map<number, { x: number; y: number }>();
    let start: {
      zoom: ZoomTransform;
      center: { x: number; y: number };
      distance: number;
      // Offset of the gesture centre in unscaled frame coordinates.
      local: { x: number; y: number };
    } | null = null;
    let moved = false;

    const origin = () => {
      const rect = fit.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };

    const begin = () => {
      const points = [...pointers.values()];
      const center = {
        x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
        y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
      };
      const distance =
        points.length >= 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
      const zoom = zoomRef.current;
      const o = origin();
      start = {
        zoom,
        center,
        distance,
        local: {
          x: (center.x - o.x - zoom.x) / zoom.scale,
          y: (center.y - o.y - zoom.y) / zoom.scale,
        },
      };
    };

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (pointers.size === 0) moved = false;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      begin();
    };

    const onMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId) || !start) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = [...pointers.values()];
      const center = {
        x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
        y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
      };

      if (points.length >= 2 && start.distance > 0) {
        moved = true;
        const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (start.zoom.scale * distance) / start.distance));
        const o = origin();
        applyZoom({
          scale,
          x: center.x - o.x - scale * start.local.x,
          y: center.y - o.y - scale * start.local.y,
        });
        return;
      }

      if (zoomRef.current.scale <= 1.01) return;
      const dx = center.x - start.center.x;
      const dy = center.y - start.center.y;
      if (!moved && Math.hypot(dx, dy) < TAP_SLOP) return;
      moved = true;
      applyZoom({ scale: start.zoom.scale, x: start.zoom.x + dx, y: start.zoom.y + dy });
    };

    const onUp = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return;
      if (pointers.size > 0) begin();
      else start = null;
      if (pointers.size === 0 && zoomRef.current.scale < 1.05) {
        applyZoom({ scale: 1, x: 0, y: 0 }, true);
      }
    };

    // A pan or pinch that ends on a region must not also open it.
    const onClickCapture = (event: MouseEvent) => {
      if (!moved) return;
      event.preventDefault();
      event.stopPropagation();
      moved = false;
    };

    const onWheel = (event: WheelEvent) => {
      // Trackpad pinch arrives as ctrl+wheel on desktop browsers.
      if (!event.ctrlKey) return;
      event.preventDefault();
      const zoom = zoomRef.current;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, zoom.scale * Math.exp(-event.deltaY / 200)));
      const o = origin();
      const localX = (event.clientX - o.x - zoom.x) / zoom.scale;
      const localY = (event.clientY - o.y - zoom.y) / zoom.scale;
      applyZoom({ scale, x: event.clientX - o.x - scale * localX, y: event.clientY - o.y - scale * localY });
    };

    // iOS Safari still starts its own page zoom unless gesture events are cancelled.
    const onGesture = (event: Event) => event.preventDefault();

    fit.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    fit.addEventListener("click", onClickCapture, true);
    fit.addEventListener("wheel", onWheel, { passive: false });
    fit.addEventListener("gesturestart", onGesture);
    fit.addEventListener("gesturechange", onGesture);
    return () => {
      fit.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      fit.removeEventListener("click", onClickCapture, true);
      fit.removeEventListener("wheel", onWheel);
      fit.removeEventListener("gesturestart", onGesture);
      fit.removeEventListener("gesturechange", onGesture);
    };
  }, [applyZoom]);


  useEffect(() => {
    if (!natural || natural.width <= 0 || natural.height <= 0) return;
    const element = fitRef.current;
    if (!element) return;

    let animationFrame = 0;

    const measure = () => {
      const availableWidth = element.clientWidth;
      const availableHeight = element.clientHeight;
      if (availableWidth <= 0 || availableHeight <= 0) return;
      const ratio = natural.width / natural.height;
      const width = Math.min(availableWidth, availableHeight * ratio);
      const height = width / ratio;
      setFrame((previous) => {
        if (
          previous &&
          Math.abs(previous.width - width) < 0.5 &&
          Math.abs(previous.height - height) < 0.5
        ) {
          return previous;
        }
        return { width, height };
      });
    };

    const schedule = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(measure);
    };

    measure();

    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    observer?.observe(element);
    window.addEventListener("resize", schedule);

    return () => {
      cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [natural]);

  useLayoutEffect(() => {
    const root = fitRef.current;
    if (!root || !frame || showOriginal) return;
    for (const button of root.querySelectorAll<HTMLButtonElement>(".tv-region")) {
      const label = button.querySelector<HTMLElement>(".tv-region-label");
      if (!label) continue;
      const style = getComputedStyle(button);
      const width = button.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = button.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      let low = 1;
      let high = Math.min(18, frame.width * 0.045);
      // Use real font metrics and wrapping, including Japanese glyphs. The
      // rectangle never grows into adjacent text or the illustration below it.
      for (let step=0;step<12;step+=1) {
        const size = (low+high)/2;
        label.style.fontSize = `${size}px`;
        if (label.scrollWidth <= width + 0.5 && label.scrollHeight <= height + 0.5) low=size;
        else high=size;
      }
      label.style.fontSize = `${Math.floor(low*10)/10}px`;
    }
  }, [regions, frame, showOriginal]);

  if (typeof src !== "string" || !src.trim()) return null;

  const list = Array.isArray(regions) ? regions : [];

  return (
    <div className="tv-image-fit" ref={fitRef}>
      {!frame && !failed ? (
        <div className="tv-image-loading" role="status">
          <Loader2 size={20} className="spin" aria-hidden="true" />
          <span className="sr-only">画像を読み込んでいます</span>
        </div>
      ) : null}

      {failed ? (
        <p className="tv-image-error" role="alert">
          画像を表示できませんでした。
        </p>
      ) : null}

      {zoomed ? (
        <button
          type="button"
          className="tv-zoom-reset"
          onClick={() => applyZoom({ scale: 1, x: 0, y: 0 }, true)}
          aria-label="拡大を元に戻す"
        >
          <Minimize2 size={15} aria-hidden="true" />
          等倍
        </button>
      ) : null}

      <div
        ref={frameRef}
        className="tv-image-frame"
        data-ready={frame ? "true" : "false"}
        style={
          frame
            ? { width: `${frame.width}px`, height: `${frame.height}px` }
            : ({ visibility: "hidden" } satisfies CSSProperties)
        }
      >
        <img
          className="tv-image"
          src={src}
          alt="翻訳した画像"
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
              setNatural({ width: image.naturalWidth, height: image.naturalHeight });
            }
          }}
          onError={() => setFailed(true)}
        />

        <div className="tv-region-layer" hidden={showOriginal}>
          {list.map((region) => {
            if (!region) return null;
            const bounds = safeBounds(region);
            if (!bounds) return null;

            const source = textValue(region.source);
            const translation = textValue(region.translation);
            const active = activeId != null && region.id === activeId;
            const label = showOriginal || !translation ? source : translation;
            const fullText = translation
              ? `原文: ${source}\n訳: ${translation}`
              : `原文: ${source}`;
            const compact = bounds.width < 0.22 || bounds.height < 0.075;

            return (
              <button
                key={region.id}
                type="button"
                className="tv-region"
                data-phase={region.phase ?? "final"}
                data-active={active ? "true" : "false"}
                data-original={showOriginal ? "true" : "false"}
                data-compact={compact ? "true" : "false"}
                style={{
                  left: `${bounds.left * 100}%`,
                  top: `${bounds.top * 100}%`,
                  width: `${bounds.width * 100}%`,
                  height: `${bounds.height * 100}%`,
                }}
                title={fullText}
                aria-label={fullText}
                aria-pressed={onSelect ? active : undefined}
                disabled={!onSelect || region.phase === "ocr" || region.phase === "draft"}
                onClick={onSelect ? () => onSelect(region) : undefined}
              >
                {label ? (
                  <span className="tv-region-label">{label}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
