const DB_NAME = 'vc-offline-v1';
const STORE_NAME = 'videos';
const STORAGE_LIMIT_KEY = 'vc-offline-limit-gb';
const DEFAULT_LIMIT_GB = 5;


type OfflineEntry = {
  fileId: string;
  fileName: string;
  blob: Blob;
  savedAt: number;
  size: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;

export function openOfflineDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'fileId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export async function saveOfflineVideo(
  fileId: string,
  fileName: string,
  blob: Blob,
): Promise<void> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const entry: OfflineEntry = { fileId, fileName, blob, savedAt: Date.now(), size: blob.size };
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function loadOfflineVideo(fileId: string): Promise<Blob | null> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(fileId);
    req.onsuccess = () => resolve((req.result as OfflineEntry | undefined)?.blob ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteOfflineVideo(fileId: string): Promise<void> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(fileId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function listOfflineSavedIds(): Promise<string[]> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
}

export async function isOfflineSaved(fileId: string): Promise<boolean> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getKey(fileId);
    req.onsuccess = () => resolve(req.result !== undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function getOfflineStorageUsage(): Promise<{ count: number; totalBytes: number }> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const entries = req.result as OfflineEntry[];
      resolve({
        count: entries.length,
        totalBytes: entries.reduce((sum, e) => sum + e.size, 0),
      });
    };
    req.onerror = () => reject(req.error);
  });
}

export function getStorageLimitGb(): number {
  const v = localStorage.getItem(STORAGE_LIMIT_KEY);
  const n = v !== null ? Number(v) : NaN;
  return isNaN(n) || n < 1 ? DEFAULT_LIMIT_GB : n;
}

export function setStorageLimitGb(gb: number): void {
  localStorage.setItem(STORAGE_LIMIT_KEY, String(Math.max(1, Math.round(gb))));
}

export async function checkQuota(newBytes: number): Promise<'ok' | 'over-limit'> {
  const { totalBytes } = await getOfflineStorageUsage();
  const limitBytes = getStorageLimitGb() * 1024 * 1024 * 1024;
  return totalBytes + newBytes <= limitBytes ? 'ok' : 'over-limit';
}

