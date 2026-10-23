export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  let data: ArrayBuffer | Uint8Array;
  if (typeof input === "string") data = new TextEncoder().encode(input);
  else data = input;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

export function countChars(text: string): number {
  return [...text].length;
}

/** A rough token estimate used only for display, never for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
