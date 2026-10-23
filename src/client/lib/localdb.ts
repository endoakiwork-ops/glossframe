const DB_NAME = "glossframe-local";
const STORE = "blobs";
const memory = new Map<string, Blob>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!("indexedDB" in window)) {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putLocalBlob(key: string, blob: Blob): Promise<void> {
  const db = await openDb();
  if (!db) {
    memory.set(key, blob);
    return;
  }
  try {
    const tx = db.transaction(STORE, "readwrite");
    await requestToPromise(tx.objectStore(STORE).put(blob, key));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    memory.set(key, blob);
  }
}

export async function getLocalBlob(key: string): Promise<Blob | null> {
  const db = await openDb();
  if (!db) return memory.get(key) ?? null;
  try {
    const tx = db.transaction(STORE, "readonly");
    const result = await requestToPromise<Blob | undefined>(tx.objectStore(STORE).get(key));
    return result ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

export async function deleteLocalBlob(key: string): Promise<void> {
  memory.delete(key);
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // IndexedDB is optional; the in-memory cache still works for this session.
  }
}

export async function clearLocalBlobs(): Promise<void> {
  memory.clear();
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Clearing the local cache is best-effort.
  }
}

export function translationImageKey(translationId: string): string {
  return `translation:${translationId}`;
}
