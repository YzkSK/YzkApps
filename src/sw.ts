/// <reference lib="webworker" />

import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { initializeApp } from 'firebase/app';
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw';

declare const self: ServiceWorkerGlobalScope;

// ── App Shell キャッシュ ─────────────────────────────────────────────────────
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST ?? []);
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

// ── Firebase Cloud Messaging ─────────────────────────────────────────────────
const firebaseApp = initializeApp({
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY as string,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID as string,
});

const messaging = getMessaging(firebaseApp);

onBackgroundMessage(messaging, (payload) => {
  // webpush.notification がある場合はブラウザが自動表示するためスキップ（2重防止）
  if (payload.notification) return;
  const title = payload.data?.['title'] ?? '時間割';
  const body  = payload.data?.['body']  ?? '';
  self.registration.showNotification(title, { body, data: { url: '/app/timetable' } });
});

// ── BgFetch IDB ヘルパー（後方互換用：BgFetch 経由で保存された動画を処理） ──
const VC_DB_NAME      = 'vc-offline-v1';
const VC_VIDEOS_STORE = 'videos';
const VC_RAW_DB_NAME  = 'vc-offline-raw-v1';
const VC_RAW_STORE    = 'raws';

function openVcDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VC_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(VC_VIDEOS_STORE)) {
        req.result.createObjectStore(VC_VIDEOS_STORE, { keyPath: 'fileId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function openRawDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VC_RAW_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(VC_RAW_STORE, { keyPath: 'fileId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function saveVideoToIdb(fileId: string, fileName: string, blob: Blob): Promise<void> {
  const db = await openVcDb();
  return new Promise((resolve, reject) => {
    const entry = { fileId, fileName, blob, savedAt: Date.now(), size: blob.size };
    const tx    = db.transaction(VC_VIDEOS_STORE, 'readwrite');
    const req   = tx.objectStore(VC_VIDEOS_STORE).put(entry);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function saveRawToIdb(fileId: string, fileName: string, rawBlob: Blob, quality: string): Promise<void> {
  const db = await openRawDb();
  return new Promise((resolve, reject) => {
    const entry = { fileId, fileName, rawBlob, quality, savedAt: Date.now() };
    const tx    = db.transaction(VC_RAW_STORE, 'readwrite');
    const req   = tx.objectStore(VC_RAW_STORE).put(entry);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

type BgFetchMeta = { fileId: string; fileName: string; quality?: string };

async function getBgMeta(bgFetchId: string): Promise<BgFetchMeta | null> {
  try {
    const cache = await caches.open('vc-bgfetch-meta');
    const resp  = await cache.match('/' + bgFetchId);
    if (!resp) return null;
    return resp.json() as Promise<BgFetchMeta>;
  } catch {
    return null;
  }
}

async function deleteBgMeta(bgFetchId: string): Promise<void> {
  try {
    const cache = await caches.open('vc-bgfetch-meta');
    await cache.delete('/' + bgFetchId);
  } catch { /* 無視 */ }
}

async function notifyAllClients(message: unknown): Promise<void> {
  const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  allClients.forEach(c => c.postMessage(message));
}

// ── Background Fetch 型宣言（標準ライブラリ未収録のため手動定義） ────────────
interface BgFetchRecord {
  readonly responseReady: Promise<Response>;
}
interface BgFetchRegistration extends EventTarget {
  readonly id: string;
  matchAll(): Promise<BgFetchRecord[]>;
  updateUI(options: { title: string }): Promise<void>;
}
interface BgFetchEvent extends ExtendableEvent {
  readonly registration: BgFetchRegistration;
}

// ── Background Fetch ハンドラ ───────────────────────────────────────────────
self.addEventListener('backgroundfetchsuccess', (event) => {
  const e   = event as unknown as BgFetchEvent;
  const reg = e.registration;
  e.waitUntil((async () => {
    console.info('[SW] backgroundfetchsuccess', { id: reg.id });
    const meta = await getBgMeta(reg.id);
    if (!meta) {
      console.error('[SW] backgroundfetchsuccess: meta not found', { id: reg.id });
      return;
    }
    try {
      const records  = await reg.matchAll();
      if (records.length === 0) throw new Error('no records');
      const response = await records[0].responseReady;
      const blob     = await response.blob();
      if (blob.size === 0) throw new Error('empty blob');

      const quality = meta.quality ?? 'original';
      if (quality === 'original') {
        await saveVideoToIdb(meta.fileId, meta.fileName, blob);
        await deleteBgMeta(reg.id);
        try { await reg.updateUI({ title: `${meta.fileName} を保存しました` }); } catch { /* optional */ }
        await notifyAllClients({ type: 'vc-bgfetch-done', fileId: meta.fileId, fileName: meta.fileName });
      } else {
        await saveRawToIdb(meta.fileId, meta.fileName, blob, quality);
        await deleteBgMeta(reg.id);
        try { await reg.updateUI({ title: `${meta.fileName} ダウンロード完了（圧縮待ち）` }); } catch { /* optional */ }
        await notifyAllClients({ type: 'vc-bgfetch-raw-done', fileId: meta.fileId, fileName: meta.fileName, quality });
      }
    } catch (err) {
      console.error('[SW] backgroundfetchsuccess error', err);
      await deleteBgMeta(reg.id);
      await notifyAllClients({ type: 'vc-bgfetch-fail', fileId: meta.fileId });
    }
  })());
});

self.addEventListener('backgroundfetchfail', (event) => {
  const e = event as unknown as BgFetchEvent;
  e.waitUntil((async () => {
    console.error('[SW] backgroundfetchfail', { id: e.registration.id });
    const meta = await getBgMeta(e.registration.id);
    if (!meta) {
      console.error('[SW] backgroundfetchfail: meta not found', { id: e.registration.id });
      return;
    }
    await deleteBgMeta(e.registration.id);
    await notifyAllClients({ type: 'vc-bgfetch-fail', fileId: meta.fileId });
  })());
});

self.addEventListener('backgroundfetchabort', (event) => {
  const e = event as unknown as BgFetchEvent;
  console.warn('[SW] backgroundfetchabort', { id: e.registration.id });
  e.waitUntil(deleteBgMeta(e.registration.id));
});

// ── 通知クリック ─────────────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | null)?.url ?? '/app/timetable';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(url) && 'focus' in client) return (client as WindowClient).focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
