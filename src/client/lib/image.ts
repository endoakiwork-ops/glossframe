import { findOcrPanels, ocrImageScale } from "../../shared/ocr-panels";
import { thresholdOcrPixels } from "../../shared/ocr-layout";
import { sha256Hex } from "../../shared/text";

export interface CanvasImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

const MAX_SAVE_EDGE = 1600;

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

async function decodeBitmap(file: Blob): Promise<{ source: CanvasImageBitmap; width: number; height: number }> {
  if ("createImageBitmap" in window) {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // Safari and older browsers may not support the options object.
    }
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // Fall back to an <img> element.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("画像を読み込めませんでした。"));
      el.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

type CanvasImageBitmap = ImageBitmap | HTMLImageElement;

export async function loadImageFile(file: Blob): Promise<CanvasImage> {
  const { source, width, height } = await decodeBitmap(file);
  if (!width || !height) throw new Error("画像のサイズを取得できませんでした。");
  const scale = ocrImageScale(width,height);
  const canvas = makeCanvas(width * scale, height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像を処理できませんでした。");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  if ("close" in source && typeof source.close === "function") source.close();
  return { canvas, width: canvas.width, height: canvas.height };
}

export function rotateCanvas(source: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized === 0) {
    const copy = makeCanvas(source.width, source.height);
    copy.getContext("2d")?.drawImage(source, 0, 0);
    return copy;
  }
  const quarter = normalized === 90 || normalized === 270;
  const canvas = makeCanvas(quarter ? source.height : source.width, quarter ? source.width : source.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return source;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((normalized * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function cropCanvas(source: HTMLCanvasElement, rect: CropRect): HTMLCanvasElement {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const width = Math.max(1, Math.min(source.width - x, Math.round(rect.width)));
  const height = Math.max(1, Math.min(source.height - y, Math.round(rect.height)));
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return source;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, x, y, width, height, 0, 0, width, height);
  return canvas;
}

export function scaleCanvas(source: HTMLCanvasElement, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  if (scale >= 1) return source;
  const canvas = makeCanvas(source.width * scale, source.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return source;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/webp",
  quality = 0.82,
): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (blob) return blob;
  const fallback = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality),
  );
  if (!fallback) throw new Error("画像を変換できませんでした。");
  return fallback;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("画像を読み込めませんでした。"));
    reader.readAsDataURL(blob);
  });
}

export interface PreparedImage {
  blob: Blob;
  dataBase64: string;
  sha256: string;
  contentType: "image/webp" | "image/jpeg" | "image/png";
  width: number;
  height: number;
}

export async function prepareImageForSave(canvas: HTMLCanvasElement): Promise<PreparedImage> {
  const scaled = scaleCanvas(canvas, MAX_SAVE_EDGE);
  let blob = await canvasToBlob(scaled, "image/webp", 0.8);
  if (blob.type !== "image/webp") {
    blob = await canvasToBlob(scaled, "image/jpeg", 0.82);
  }
  const dataBase64 = await blobToBase64(blob);
  const sha256 = await sha256Hex(await blob.arrayBuffer());
  const contentType =
    blob.type === "image/png" ? "image/png" : blob.type === "image/jpeg" ? "image/jpeg" : "image/webp";
  return {
    blob,
    dataBase64,
    sha256,
    contentType,
    width: scaled.width,
    height: scaled.height,
  };
}

export function canvasObjectUrl(canvas: HTMLCanvasElement): Promise<string> {
  return canvasToBlob(canvas, "image/jpeg", 0.86).then((blob) => URL.createObjectURL(blob));
}

export function prepareOcrContrast(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = makeCanvas(source.width,source.height);
  const context = canvas.getContext("2d", {willReadFrequently:true});
  if (!context) throw new Error("画像を処理できませんでした。");
  context.drawImage(source,0,0);
  const pixels = context.getImageData(0,0,canvas.width,canvas.height);
  thresholdOcrPixels(pixels.data);
  context.putImageData(pixels,0,0);
  return canvas;
}

export function prepareOcrPanels(source: HTMLCanvasElement) {
  const context=source.getContext("2d",{willReadFrequently:true});
  if(!context)return [];
  return findOcrPanels(context.getImageData(0,0,source.width,source.height).data,source.width,source.height);
}
