# オフラインアクセス対応 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Service Worker に app shell キャッシュを追加し、オフライン時にサイトが開けるようにしつつ、Videocollect のオフライン保存済み動画を一覧・再生できるようにする。

**Architecture:** `vite-plugin-pwa`（injectManifest 戦略）で既存の FCM/BgFetch/通知クリック SW コードと Workbox precaching を `src/sw.ts` 1本に統合する。さらに `offlineStorage.ts` にサムネイルメタデータを保存し、`Videocollect.tsx` でネットワーク不通時に IndexedDB フォールバック表示を行う。

**Tech Stack:** vite-plugin-pwa, workbox-precaching, workbox-routing, firebase/messaging/sw (modular), Vitest (jsdom)

## Global Constraints

- TypeScript strict モード（`noUnusedLocals`, `noUnusedParameters` 有効）
- 日本語でユーザー向けメッセージを記述
- エラーは `console.error` に記録し、握りつぶさない
- テストファイルは `src/__tests__/unit/` 以下に配置

---

## ファイル変更一覧

| ファイル | 変更種別 |
|---|---|
| `package.json` | devDependencies に `vite-plugin-pwa`, `workbox-precaching`, `workbox-routing` を追加 |
| `vite.config.ts` | `VitePWA` プラグインを追加 |
| `tsconfig.app.json` | `src/sw.ts` を `exclude` に追加 |
| `src/sw.ts` | 新規作成（Workbox + FCM + BgFetch + 通知クリック） |
| `public/firebase-messaging-sw.js` | 削除 |
| `src/main.tsx` | SW 登録先を `/sw.js` に変更 |
| `src/app/videocollect/offlineStorage.ts` | `thumbnailLink` フィールドを追加、`listOfflineEntries()` 追加 |
| `src/app/videocollect/downloadQueue.ts` | `DownloadTask` と `startDownload` に `thumbnailLink` 追加 |
| `src/app/videocollect/modals/OfflineSaveModal.tsx` | `thumbnailLink` prop を追加して `startDownload` に渡す |
| `src/app/videocollect/VideoPlayer.tsx` | `OfflineSaveModal` に `thumbnailLink` を渡す |
| `src/app/videocollect/Videocollect.tsx` | `PageState` に `'offline'` 追加、オフラインフォールバック処理 |
| `src/__tests__/unit/videocollect/offlineStorage.test.ts` | `thumbnailLink` と `listOfflineEntries` のテスト追加 |

---

## Task 1: 依存パッケージのインストールと vite.config.ts の設定

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Modify: `tsconfig.app.json`

**Interfaces:**
- Produces: `VitePWA` が `npm run build` 時に `dist/sw.js` を生成する設定

- [ ] **Step 1: パッケージをインストール**

```bash
npm install -D vite-plugin-pwa workbox-precaching workbox-routing
```

Expected output: `added N packages` and no errors.

- [ ] **Step 2: `vite.config.ts` を更新**

```ts
import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,woff2,svg,png,ico}'],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
```

- [ ] **Step 3: `tsconfig.app.json` に `src/sw.ts` を除外追加**

SW ファイルは `webworker` lib を使うため、DOM 型と混在させない。

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"],
  "exclude": ["src/__tests__", "src/sw.ts"]
}
```

- [ ] **Step 4: ビルドが通ることを確認**

```bash
npm run build
```

Expected: `dist/sw.js` が生成されている（`ls dist/sw.js`）。エラーがないこと。

- [ ] **Step 5: コミット**

```bash
git add package.json package-lock.json vite.config.ts tsconfig.app.json
git commit -m "build: vite-plugin-pwa (injectManifest) を追加"
```

---

## Task 2: `src/sw.ts` を作成（Workbox + FCM + BgFetch + 通知クリック）

**Files:**
- Create: `src/sw.ts`
- Delete: `public/firebase-messaging-sw.js`

**Interfaces:**
- Consumes: `VITE_FIREBASE_*` 環境変数（ビルド時に埋め込み）
- Consumes: Workbox `__WB_MANIFEST`（`vite-plugin-pwa` がビルド時に注入）
- Produces: `/sw.js`（配信される統合 SW）

- [ ] **Step 1: `src/sw.ts` を作成**

`public/firebase-messaging-sw.js` の全機能を TypeScript で書き直し、Workbox precaching を追加する。

```ts
/// <reference lib="webworker" />

import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { initializeApp } from 'firebase/app';
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw';

declare const self: ServiceWorkerGlobalScope;
declare const __WB_MANIFEST: Array<{ url: string; revision: string | null } | string>;

// ── App Shell キャッシュ ─────────────────────────────────────────────────────
cleanupOutdatedCaches();
precacheAndRoute(__WB_MANIFEST);
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
```

- [ ] **Step 2: `public/firebase-messaging-sw.js` を削除**

```bash
git rm public/firebase-messaging-sw.js
```

- [ ] **Step 3: ビルドが通ることを確認**

```bash
npm run build
```

Expected: エラーなし。`dist/sw.js` が生成されていること。

- [ ] **Step 4: コミット**

```bash
git add src/sw.ts
git commit -m "feat: Workbox + FCM + BgFetch を統合した Service Worker を追加"
```

---

## Task 3: `main.tsx` の SW 登録を更新

**Files:**
- Modify: `src/main.tsx:10-19`

**Interfaces:**
- Consumes: `src/sw.ts` で生成された `/sw.js`
- Produces: アプリ起動時に `/sw.js` が登録される

- [ ] **Step 1: SW 登録コードを書き換え**

`src/main.tsx` の以下の部分を置換する。

Before (lines 10-19):
```ts
if ('serviceWorker' in navigator) {
  const swParams = new URLSearchParams({
    apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId:             import.meta.env.VITE_FIREBASE_APP_ID,
  });
  navigator.serviceWorker.register(`/firebase-messaging-sw.js?${swParams}`).catch(() => {});
}
```

After:
```ts
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
```

- [ ] **Step 2: ビルドが通り lint エラーがないことを確認**

```bash
npm run build && npm run lint
```

Expected: エラーなし。

- [ ] **Step 3: 動作確認（DevTools）**

1. `npm run build && npm run preview`
2. ブラウザで http://localhost:4173 を開く
3. DevTools → Application → Service Workers → `/sw.js` が登録されていることを確認
4. DevTools → Network → Offline にチェックを入れてリロード
5. サイトがオフラインで開けることを確認（Firestore はエラーになるが UI は表示される）

- [ ] **Step 4: コミット**

```bash
git add src/main.tsx
git commit -m "feat: SW 登録先を /sw.js に変更（Firebase config クエリパラメータを廃止）"
```

---

## Task 4: `offlineStorage.ts` に `thumbnailLink` とメタ一覧を追加

**Files:**
- Modify: `src/app/videocollect/offlineStorage.ts`
- Modify: `src/__tests__/unit/videocollect/offlineStorage.test.ts`

**Interfaces:**
- Produces:
  - `saveOfflineVideo(fileId, fileName, blob, thumbnailLink?)` — 第4引数に `thumbnailLink` を追加
  - `OfflineMeta` 型（blob なしメタデータ）
  - `listOfflineEntries(): Promise<OfflineMeta[]>` — blob を含まないエントリ一覧

- [ ] **Step 1: テストを先に書く（TDD）**

`src/__tests__/unit/videocollect/offlineStorage.test.ts` の末尾に追加する。

既存の `saveOfflineVideo / loadOfflineVideo` describe ブロックを以下のように更新し、さらに新しい describe ブロックを追加する。

既存 `saveOfflineVideo / loadOfflineVideo` describe の中に以下テストを追加：
```ts
it('thumbnailLink を保存・復元できる', async () => {
  const blob = new Blob(['test'], { type: 'video/mp4' });
  await saveOfflineVideo('file-thumb', 'thumb.mp4', blob, 'https://example.com/thumb.jpg');
  const entries = await listOfflineEntries();
  const entry = entries.find(e => e.fileId === 'file-thumb');
  expect(entry?.thumbnailLink).toBe('https://example.com/thumb.jpg');
});

it('thumbnailLink なしで保存した場合は undefined になる', async () => {
  const blob = new Blob(['test2'], { type: 'video/mp4' });
  await saveOfflineVideo('file-no-thumb', 'no-thumb.mp4', blob);
  const entries = await listOfflineEntries();
  const entry = entries.find(e => e.fileId === 'file-no-thumb');
  expect(entry?.thumbnailLink).toBeUndefined();
});
```

新しい `listOfflineEntries` describe を追加：
```ts
describe('listOfflineEntries', () => {
  it('blob を含まないメタデータ一覧を返す', async () => {
    const b1 = new Blob(['a'], { type: 'video/mp4' });
    const b2 = new Blob(['b'], { type: 'video/mp4' });
    await saveOfflineVideo('meta-a', 'a.mp4', b1, 'https://example.com/a.jpg');
    await saveOfflineVideo('meta-b', 'b.mp4', b2);
    const entries = await listOfflineEntries();
    const a = entries.find(e => e.fileId === 'meta-a');
    const b = entries.find(e => e.fileId === 'meta-b');
    expect(a?.fileName).toBe('a.mp4');
    expect(a?.thumbnailLink).toBe('https://example.com/a.jpg');
    expect(b?.fileName).toBe('b.mp4');
    expect(b?.thumbnailLink).toBeUndefined();
    // blob は含まれない
    expect((a as unknown as { blob?: unknown })?.blob).toBeUndefined();
  });
});
```

また、既存のインポート行に `listOfflineEntries` を追加する：
```ts
const {
  saveOfflineVideo,
  loadOfflineVideo,
  deleteOfflineVideo,
  listOfflineSavedIds,
  isOfflineSaved,
  getOfflineStorageUsage,
  getStorageLimitGb,
  setStorageLimitGb,
  checkQuota,
  listOfflineEntries,   // 追加
} = await import('@/app/videocollect/offlineStorage');
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm test -- offlineStorage
```

Expected: `listOfflineEntries is not a function` などのエラーで FAIL。

- [ ] **Step 3: `offlineStorage.ts` を更新**

```ts
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
  thumbnailLink?: string;
};

export type OfflineMeta = {
  fileId: string;
  fileName: string;
  savedAt: number;
  size: number;
  thumbnailLink?: string;
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
  thumbnailLink?: string,
): Promise<void> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const entry: OfflineEntry = { fileId, fileName, blob, savedAt: Date.now(), size: blob.size, thumbnailLink };
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

export async function listOfflineEntries(): Promise<OfflineMeta[]> {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const entries = req.result as OfflineEntry[];
      resolve(entries.map(({ fileId, fileName, savedAt, size, thumbnailLink }) => ({
        fileId, fileName, savedAt, size, thumbnailLink,
      })));
    };
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
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm test -- offlineStorage
```

Expected: 全テスト PASS。

- [ ] **Step 5: コミット**

```bash
git add src/app/videocollect/offlineStorage.ts src/__tests__/unit/videocollect/offlineStorage.test.ts
git commit -m "feat: offlineStorage に thumbnailLink と listOfflineEntries を追加"
```

---

## Task 5: `downloadQueue` / `OfflineSaveModal` / `VideoPlayer` に `thumbnailLink` を伝播

**Files:**
- Modify: `src/app/videocollect/downloadQueue.ts:11-56`
- Modify: `src/app/videocollect/modals/OfflineSaveModal.tsx`
- Modify: `src/app/videocollect/VideoPlayer.tsx`

**Interfaces:**
- Consumes: `saveOfflineVideo(fileId, fileName, blob, thumbnailLink?)` （Task 4 で追加）
- Produces: `startDownload` opts に `thumbnailLink?: string` が追加される

- [ ] **Step 1: `downloadQueue.ts` を更新**

`DownloadTask` 型と `startDownload` の opts に `thumbnailLink` を追加し、`saveOfflineVideo` 呼び出しに渡す。

`downloadQueue.ts` の `DownloadTask` 型を変更：
```ts
export type DownloadTask = {
  fileId: string;
  fileName: string;
  phase: DownloadPhase;
  progress: number;
  errorCode?: string;
  thumbnailLink?: string;
};
```

`startDownload` の opts に追加：
```ts
export function startDownload(opts: {
  fileId: string;
  fileName: string;
  proxyUrl: string;
  accessToken: string;
  fileSizeBytes?: number;
  thumbnailLink?: string;
}): void {
  if (tasks.has(opts.fileId)) return;
  tasks.set(opts.fileId, {
    fileId: opts.fileId,
    fileName: opts.fileName,
    phase: 'fetching',
    progress: 0,
    thumbnailLink: opts.thumbnailLink,
  });
  notify();

  acquireWakeLock().catch(() => {});
  launchDownload(opts);
}
```

`launchDownload` の opts 型も更新：
```ts
function launchDownload(opts: {
  fileId: string;
  fileName: string;
  proxyUrl: string;
  accessToken: string;
  fileSizeBytes?: number;
  thumbnailLink?: string;
}): void {
```

`runInPage` の opts 型も更新：
```ts
async function runInPage(opts: {
  fileId: string;
  fileName: string;
  proxyUrl: string;
  accessToken: string;
  fileSizeBytes?: number;
  signal: AbortSignal;
  thumbnailLink?: string;
}): Promise<void> {
```

`runInPage` 内の `saveOfflineVideo` 呼び出しを更新（2箇所ある）：

1. 並列チャンク完了後（line 204 付近）：
```ts
await saveOfflineVideo(fileId, fileName, blob, opts.thumbnailLink);
```

2. `runInPageStream` にも `thumbnailLink` を渡す。`runInPageStream` の呼び出し：
```ts
await runInPageStream({ fileId, fileName, streamUrl, contentType, signal, thumbnailLink: opts.thumbnailLink });
```

`runInPageStream` の opts 型・実装を更新：
```ts
async function runInPageStream(opts: {
  fileId: string;
  fileName: string;
  streamUrl: string;
  contentType: string;
  signal: AbortSignal;
  thumbnailLink?: string;
}): Promise<void> {
  const { fileId, fileName, streamUrl, contentType, signal, thumbnailLink } = opts;
  // ... 既存コード ...
  // saveOfflineVideo 呼び出し箇所を更新:
  await saveOfflineVideo(fileId, fileName, new Blob(chunks, { type: resp.headers.get('Content-Type') ?? contentType }), thumbnailLink);
```

- [ ] **Step 2: `OfflineSaveModal.tsx` を更新**

`Props` に `thumbnailLink?: string` を追加し、`startDownload` に渡す：

```ts
type Props = {
  fileId: string;
  fileName: string;
  fileSize: string;
  proxyUrl: string;
  accessToken: string;
  thumbnailLink?: string;
  onClose: () => void;
  addToast: (msg: string, type: 'normal' | 'error' | 'warning') => void;
};

export const OfflineSaveModal = ({
  fileId,
  fileName,
  fileSize,
  proxyUrl,
  accessToken,
  thumbnailLink,
  onClose,
  addToast,
}: Props) => {
  // ...
  const handleSave = async () => {
    const quota = await checkQuota(fileSizeBytes).catch(() => 'ok' as const);
    if (quota === 'over-limit') {
      addToast(`保存上限（${limitGb} GB）を超えます。上限を増やすか既存の動画を削除してください。`, 'warning');
      return;
    }
    startDownload({ fileId, fileName, proxyUrl, accessToken, fileSizeBytes, thumbnailLink });
    onClose();
  };
```

- [ ] **Step 3: `VideoPlayer.tsx` を更新**

`OfflineSaveModal` に `thumbnailLink` を渡す。`VideoPlayer.tsx` の `showOfflineSaveModal` レンダリング箇所（末尾付近の `OfflineSaveModal` JSX）を更新：

VideoPlayer.tsx は `DriveFile` を持たないが、`thumbnailLink` は Drive API から取得できる。しかし現状 VideoPlayer は個別ファイルのメタデータ（`fetchDriveFileMetadata`）でサイズのみ取得している。最小変更として：`fetchDriveFileMetadata` の戻り値に `thumbnailLink` があれば保持するステートを追加する。

VideoPlayer.tsx の state 追加：
```ts
const [thumbnailLink, setThumbnailLink] = useState<string | undefined>(undefined);
```

`fetchDriveFileMetadata` の結果で `thumbnailLink` も保持（既存の useEffect 内）：
```ts
useEffect(() => {
  if (!accessToken || !fileId) return;
  fetchDriveFileMetadata(accessToken, fileId)
    .then(file => {
      if (file && file.size) {
        setFileSize(file.size);
      }
      if (file && file.thumbnailLink) {
        setThumbnailLink(file.thumbnailLink);
      }
    })
    .catch(e => console.error('[VideoPlayer] failed to fetch file metadata', e));
}, [accessToken, fileId]);
```

`OfflineSaveModal` JSX に prop 追加：
```tsx
{showOfflineSaveModal && videoNonce && (
  <OfflineSaveModal
    fileId={fileId}
    fileName={fileName}
    fileSize={fileSize}
    proxyUrl={proxyUrl}
    accessToken={videoNonce}
    thumbnailLink={thumbnailLink}
    onClose={() => setShowOfflineSaveModal(false)}
    addToast={addToast}
  />
)}
```

- [ ] **Step 4: ビルドと lint を確認**

```bash
npm run build && npm run lint
```

Expected: エラーなし。

- [ ] **Step 5: コミット**

```bash
git add src/app/videocollect/downloadQueue.ts \
        src/app/videocollect/modals/OfflineSaveModal.tsx \
        src/app/videocollect/VideoPlayer.tsx
git commit -m "feat: オフライン保存時にサムネイルURLもメタデータとして保存"
```

---

## Task 6: Videocollect 一覧にオフラインフォールバックを追加

**Files:**
- Modify: `src/app/videocollect/Videocollect.tsx`

**Interfaces:**
- Consumes: `listOfflineEntries(): Promise<OfflineMeta[]>` （Task 4）
- Consumes: `OfflineMeta` 型（Task 4）
- Consumes: `DriveFile` 型（`src/app/videocollect/constants.ts`）
- Produces: ネットワーク不通時に `status: 'offline'` で保存済み動画を表示

- [ ] **Step 1: インポートと `PageState` を更新**

`Videocollect.tsx` の先頭インポート行を更新：
```ts
import { listOfflineSavedIds, listOfflineEntries } from './offlineStorage';
```

`PageState` union 型に `'offline'` を追加：
```ts
type PageState =
  | { status: 'unauthenticated' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'offline'; files: DriveFile[] }
  | { status: 'empty' }
  | { status: 'loaded'; files: DriveFile[] };
```

- [ ] **Step 2: オフライン共通ヘルパー関数を追加**

`Videocollect.tsx` のコンポーネント外（ファイル上部）にヘルパー関数を追加：

```ts
async function buildOfflineFiles(): Promise<DriveFile[]> {
  const entries = await listOfflineEntries();
  return entries.map(e => ({
    id: e.fileId,
    name: e.fileName,
    mimeType: 'video/mp4',
    size: String(e.size),
    modifiedTime: new Date(e.savedAt).toISOString(),
    thumbnailLink: e.thumbnailLink,
  }));
}
```

- [ ] **Step 3: VcAuth 取得エラー時のオフラインフォールバックを追加**

`Videocollect.tsx` の `useEffect` で `getDoc(vcAuth)` を呼んでいるブロック（`useEffect(() => { if (!currentUser) return; ...`, line 98 付近）の catch を更新する：

元の catch:
```ts
      .catch(e => {
        console.error('VcAuth 読み込みエラー:', e);
        if (!cached) setPageState({ status: 'error' });
      });
```

更新後：
```ts
      .catch(async (e) => {
        console.error('VcAuth 読み込みエラー:', e);
        if (!cached) {
          const offlineFiles = await buildOfflineFiles().catch(() => []);
          if (offlineFiles.length > 0) {
            setPageState({ status: 'offline', files: offlineFiles });
          } else {
            setPageState({ status: 'error' });
          }
        }
      });
```

- [ ] **Step 4: Drive ファイル取得エラー時のオフラインフォールバックを追加**

`fetchFiles` 関数の catch 内を更新する（`addToast` を呼んでいる箇所）：

元の catch:
```ts
    } catch (e) {
      console.error('ファイル取得エラー:', e);
      if (!silent) {
        addToast(`動画一覧の取得に失敗しました [${VC_ERROR_CODES.FILES_FETCH}]`, 'error');
        setPageState({ status: 'error' });
      }
    }
```

更新後：
```ts
    } catch (e) {
      console.error('ファイル取得エラー:', e);
      if (!silent) {
        const offlineFiles = await buildOfflineFiles().catch(() => []);
        if (offlineFiles.length > 0) {
          setPageState({ status: 'offline', files: offlineFiles });
        } else {
          addToast(`動画一覧の取得に失敗しました [${VC_ERROR_CODES.FILES_FETCH}]`, 'error');
          setPageState({ status: 'error' });
        }
      }
    }
```

- [ ] **Step 5: オフラインモードバナーと UI レンダリングを追加**

`Videocollect.tsx` のレンダリング部分で `pageState.status === 'offline'` を処理する。

`status === 'error'` を処理している箇所の近く（通常はレンダリングの条件分岐内）に追加：

`pageState.status === 'loaded'` と同じ UI を使うため、レンダリング内で `offline` と `loaded` を同一扱いにする。現在 `files` を参照している箇所は `pageState.status === 'loaded' || pageState.status === 'offline'` の条件分岐、または `'files' in pageState` で対応する。

具体的には、`pageState.status === 'loaded'` を参照している条件を `pageState.status === 'loaded' || pageState.status === 'offline'` に変更する（または `'files' in pageState`）。

オフラインバナー：`pageState.status === 'offline'` の場合に画面上部（`AppLayout` の内側）に以下を追加する。バナーの挿入位置は `<AppLayout>` の直後かつコンテンツの前：

```tsx
{pageState.status === 'offline' && (
  <div style={{
    background: 'rgba(234, 179, 8, 0.15)',
    borderBottom: '1px solid rgba(234, 179, 8, 0.3)',
    padding: '8px 16px',
    fontSize: 12,
    color: '#eab308',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  }}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.56 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" />
    </svg>
    オフラインモード — 保存済み動画のみ表示しています
  </div>
)}
```

また、`pageState.status === 'offline'` 中は「アップロード」「フォルダ追加」などのネットワーク操作ボタンを非表示にする（`pageState.status !== 'offline'` で条件分岐）。

- [ ] **Step 6: ビルドと lint を確認**

```bash
npm run build && npm run lint
```

Expected: エラーなし。

- [ ] **Step 7: 動作確認**

1. 事前にいくつかの動画をオフライン保存しておく
2. DevTools → Network → Offline でオフライン状態にする
3. Videocollect 一覧を開く → 黄色バナー「オフラインモード」が表示され、保存済み動画のみ表示されることを確認
4. 保存済み動画をタップ → VideoPlayer が開き、動画が再生されることを確認
5. Network → Online に戻してリロード → 通常モードに戻ることを確認

- [ ] **Step 8: コミット**

```bash
git add src/app/videocollect/Videocollect.tsx
git commit -m "feat: Videocollect にオフラインモードフォールバックを追加"
```

---

## 最終確認

- [ ] `npm test` で全テストが通ること
- [ ] `npm run build` でエラーなし
- [ ] `npm run lint` でエラーなし
