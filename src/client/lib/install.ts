export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type InstallListener = (event: BeforeInstallPromptEvent | null) => void;

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let initialized = false;
const listeners = new Set<InstallListener>();

export function initInstallPrompt(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    for (const listener of listeners) listener(deferredPrompt);
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    for (const listener of listeners) listener(null);
  });
}

export function getInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

export function clearInstallPrompt(): void {
  deferredPrompt = null;
}

export function onInstallPrompt(listener: InstallListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia("(display-mode: standalone)").matches;
}
