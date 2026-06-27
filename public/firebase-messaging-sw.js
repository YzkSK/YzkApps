importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

const params = new URL(location.href).searchParams;
const projectId = params.get('projectId');

// パラメータなしで直接ロードされた場合は初期化しない
if (projectId) {
  firebase.initializeApp({
    apiKey: params.get('apiKey'),
    authDomain: params.get('authDomain'),
    projectId,
    storageBucket: params.get('storageBucket'),
    messagingSenderId: params.get('messagingSenderId'),
    appId: params.get('appId'),
  });

  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    // webpush.notificationがある場合はブラウザが自動表示するためスキップ（2重防止）
    if (payload.notification) return;
    const title = payload.data?.title ?? '時間割';
    const body = payload.data?.body ?? '';
    self.registration.showNotification(title, { body, data: { url: '/app/timetable' } });
  });
}

// ─── Background Fetch (オフライン動画保存) ─────────────────────────────────

const VC_DB_NAME      = 'vc-offline-v1';
const VC_VIDEOS_STORE = 'videos';
const VC_RAW_DB_NAME  = 'vc-offline-raw-v1';
const VC_RAW_STORE    = 'raws';

function openVcDb() {
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

function openRawDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VC_RAW_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(VC_RAW_STORE, { keyPath: 'fileId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function saveVideoToIdb(fileId, fileName, blob) {
  const db = await openVcDb();
  return new Promise((resolve, reject) => {
    const entry = { fileId, fileName, blob, savedAt: Date.now(), size: blob.size };
    const tx    = db.transaction(VC_VIDEOS_STORE, 'readwrite');
    const req   = tx.objectStore(VC_VIDEOS_STORE).put(entry);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function saveRawToIdb(fileId, fileName, rawBlob, quality) {
  const db = await openRawDb();
  return new Promise((resolve, reject) => {
    const entry = { fileId, fileName, rawBlob, quality, savedAt: Date.now() };
    const tx    = db.transaction(VC_RAW_STORE, 'readwrite');
    const req   = tx.objectStore(VC_RAW_STORE).put(entry);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function getBgMeta(bgFetchId) {
  try {
    const cache = await caches.open('vc-bgfetch-meta');
    const resp  = await cache.match('/' + bgFetchId);
    if (!resp) return null;
    return resp.json();
  } catch {
    return null;
  }
}

async function deleteBgMeta(bgFetchId) {
  try {
    const cache = await caches.open('vc-bgfetch-meta');
    await cache.delete('/' + bgFetchId);
  } catch { /* ignore */ }
}

async function notifyAllClients(message) {
  const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  allClients.forEach(c => c.postMessage(message));
}

self.addEventListener('backgroundfetchsuccess', (event) => {
  const reg = event.registration;
  event.waitUntil((async () => {
    console.info('[SW] backgroundfetchsuccess', { id: reg.id });
    const meta = await getBgMeta(reg.id);
    if (!meta) {
      console.error('[SW] backgroundfetchsuccess: meta not found in cache — cannot notify page', { id: reg.id });
      return;
    }
    try {
      const records  = await reg.matchAll();
      console.info('[SW] backgroundfetchsuccess records', {
        id: reg.id,
        fileId: meta.fileId,
        quality: meta.quality,
        count: records.length,
      });
      if (records.length === 0) throw new Error('no records');
      const response = await records[0].responseReady;
      console.info('[SW] backgroundfetchsuccess response', {
        id: reg.id,
        status: response.status,
        contentType: response.headers.get('Content-Type'),
        contentLength: response.headers.get('Content-Length'),
        contentRange: response.headers.get('Content-Range'),
      });
      const blob     = await response.blob();
      console.info('[SW] backgroundfetchsuccess blob', {
        id: reg.id,
        fileId: meta.fileId,
        quality: meta.quality,
        size: blob.size,
      });
      if (blob.size === 0) throw new Error('empty blob');

      const quality = meta.quality ?? 'original';

      if (quality === 'original') {
        // Final blob — save directly to the offline videos store
        await saveVideoToIdb(meta.fileId, meta.fileName, blob);
        await deleteBgMeta(reg.id);
        try { await reg.updateUI({ title: `${meta.fileName} を保存しました` }); } catch { /* optional */ }
        console.info('[SW] backgroundfetchsuccess saved original', {
          id: reg.id,
          fileId: meta.fileId,
        });
        await notifyAllClients({ type: 'vc-bgfetch-done', fileId: meta.fileId, fileName: meta.fileName });
      } else {
        // Raw blob — save to pending-compression store; app will compress on next open
        await saveRawToIdb(meta.fileId, meta.fileName, blob, quality);
        await deleteBgMeta(reg.id);
        try { await reg.updateUI({ title: `${meta.fileName} ダウンロード完了（圧縮待ち）` }); } catch { /* optional */ }
        console.info('[SW] backgroundfetchsuccess saved raw', {
          id: reg.id,
          fileId: meta.fileId,
          quality,
        });
        await notifyAllClients({ type: 'vc-bgfetch-raw-done', fileId: meta.fileId, fileName: meta.fileName, quality });
      }
    } catch (e) {
      console.error('[SW] backgroundfetchsuccess error', e);
      await deleteBgMeta(reg.id);
      await notifyAllClients({ type: 'vc-bgfetch-fail', fileId: meta.fileId });
    }
  })());
});

self.addEventListener('backgroundfetchfail', (event) => {
  event.waitUntil((async () => {
    console.error('[SW] backgroundfetchfail', { id: event.registration.id });
    const meta = await getBgMeta(event.registration.id);
    if (!meta) {
      console.error('[SW] backgroundfetchfail: meta not found — cannot notify page', { id: event.registration.id });
      return;
    }
    await deleteBgMeta(event.registration.id);
    await notifyAllClients({ type: 'vc-bgfetch-fail', fileId: meta.fileId });
  })());
});

self.addEventListener('backgroundfetchabort', (event) => {
  console.warn('[SW] backgroundfetchabort', { id: event.registration.id });
  event.waitUntil(deleteBgMeta(event.registration.id));
});

// ─── Notification click ────────────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/app/timetable';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
