# オフラインアクセス対応 設計ドキュメント

## 概要

現状、Service Worker はプッシュ通知・Background Fetch 担当の `firebase-messaging-sw.js` 1本のみで、app shell のキャッシュがない。そのためサイト自体がオフラインで開けず、IndexedDB に保存済みの Videocollect 動画を再生できない。

本設計では以下を実装する：
1. **App Shell キャッシュ**：`vite-plugin-pwa` + `injectManifest` で SW を1本に統合し、HTML/JS/CSS をキャッシュ
2. **Videocollect オフライン一覧**：ネットワーク不通時でも IndexedDB 保存済み動画を一覧表示・再生できるフォールバック

---

## Part 1: App Shell キャッシュ（SW 統合）

### 戦略

`vite-plugin-pwa` の `injectManifest` 戦略を採用。

- ソース SW ファイル（`src/sw.ts`）を書き、Vite がビルド時にコンテンツハッシュ付きファイルリスト（`__WB_MANIFEST`）を注入する
- 生成された `sw.js` が `/sw.js` として配信され、`main.tsx` で登録される
- `public/firebase-messaging-sw.js` は削除

### `src/sw.ts` の構成

```
src/sw.ts
├── Workbox precaching
│   ├── cleanupOutdatedCaches()
│   └── precacheAndRoute(self.__WB_MANIFEST)
├── Navigation fallback
│   └── registerRoute(NavigationRoute, createHandlerBoundToURL('/index.html'))
├── FCM onBackgroundMessage（firebase/messaging/sw の modular SDK）
│   ├── initializeApp() ← import.meta.env.VITE_* でビルド時埋め込み
│   └── onBackgroundMessage()
├── backgroundfetchsuccess / fail / abort ハンドラ
│   └── 既存 firebase-messaging-sw.js のコードをそのまま移植
└── notificationclick ハンドラ
    └── 既存コードをそのまま移植
```

### `vite.config.ts` の変更

```ts
import { VitePWA } from 'vite-plugin-pwa'

VitePWA({
  strategies: 'injectManifest',
  srcDir: 'src',
  filename: 'sw.ts',
  injectManifest: {
    globPatterns: ['**/*.{js,css,html,woff2,svg,png}'],
  },
  manifest: false,  // manifest.json は public/ のものをそのまま使う
})
```

### `main.tsx` の変更

```ts
// Before
navigator.serviceWorker.register(`/firebase-messaging-sw.js?${swParams}`)

// After
navigator.serviceWorker.register('/sw.js')
```

Firebase config はもはやクエリパラメータで渡す必要はなく、`sw.ts` 内で `import.meta.env.VITE_*` から直接参照するため削除。

### キャッシュ戦略

| リソース | 戦略 |
|---|---|
| JS / CSS / フォント | Precache（インストール時にキャッシュ、バージョン管理自動） |
| `index.html` | Precache + Navigation fallback |
| Google Drive / Firebase API | キャッシュしない（オンライン時のみ） |

### Navigation Fallback の範囲

SPA のすべてのルート（`/app/*`, `/videocollect/*` など）をオフライン時はキャッシュ済みの `index.html` で応答する。

---

## Part 2: Videocollect オフライン一覧

### 現状の問題

`Videocollect.tsx` はファイル一覧を Google Drive API から取得する。オフライン時は取得失敗 → `pageState = 'error'` になり、IndexedDB に保存済みの動画が表示されない。

### 対策

#### 2-1. `offlineStorage.ts`：メタデータも保存

`OfflineEntry` に `thumbnailLink?: string` を追加し、`saveOfflineVideo` のシグネチャを拡張。

```ts
type OfflineEntry = {
  fileId: string;
  fileName: string;
  blob: Blob;
  savedAt: number;
  size: number;
  thumbnailLink?: string;  // 追加
};

export async function saveOfflineVideo(
  fileId: string,
  fileName: string,
  blob: Blob,
  thumbnailLink?: string,  // 追加
): Promise<void>
```

#### 2-2. オフライン保存時にサムネイルも保存

`OfflineSaveModal.tsx`（または保存処理）で `DriveFile.thumbnailLink` を `saveOfflineVideo` に渡す。

`downloadQueue.ts` でのダウンロード完了時にも同様に `thumbnailLink` を渡す（`task` に `thumbnailLink` を追加）。

#### 2-3. `offlineStorage.ts`：オフラインエントリ一覧取得

```ts
export type OfflineMeta = {
  fileId: string;
  fileName: string;
  savedAt: number;
  size: number;
  thumbnailLink?: string;
};

export async function listOfflineEntries(): Promise<OfflineMeta[]>
```

blob は含めない（大きいので一覧取得時は不要）。

#### 2-4. `Videocollect.tsx`：オフラインフォールバック

Drive API / Firestore の取得に失敗した場合（`catch` ブロック内）、`offlineIds.size > 0` なら IndexedDB からメタを取得してオフラインモードに切り替える。

```ts
type PageState =
  | { status: 'unauthenticated' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'offline'; files: DriveFile[] }  // 追加
  | { status: 'empty' }
  | { status: 'loaded'; files: DriveFile[] };
```

- `status: 'offline'` の場合、既存のファイル一覧 UI（VideoGrid / VideoList）をそのまま使用
- 画面上部に「オフラインモード - 保存済み動画のみ表示」バナーを表示
- オフラインモードでは「ファイル追加」「削除」「タグ編集」ボタンを非表示（または disabled）

#### 2-5. VideoPlayer のオフライン動作（変更なし）

VideoPlayer は `offlineBlobUrl` が存在する場合に Firestore/Drive の失敗を無視する実装がすでに存在する。App Shell がキャッシュされればそのまま動作する。

---

## ファイル変更一覧

| ファイル | 変更内容 |
|---|---|
| `package.json` | `vite-plugin-pwa`, `workbox-*` を devDependencies に追加 |
| `vite.config.ts` | `VitePWA` プラグインを追加 |
| `src/sw.ts` | 新規作成（Workbox + FCM + BgFetch + 通知クリック） |
| `public/firebase-messaging-sw.js` | 削除 |
| `src/main.tsx` | SW 登録先を `/sw.js` に変更、Firebase config クエリパラメータを削除 |
| `src/app/videocollect/offlineStorage.ts` | `OfflineEntry` に `thumbnailLink` 追加、`listOfflineEntries()` 追加 |
| `src/app/videocollect/downloadQueue.ts` | タスクに `thumbnailLink` を追加 |
| `src/app/videocollect/modals/OfflineSaveModal.tsx` | `saveOfflineVideo` に `thumbnailLink` を渡す |
| `src/app/videocollect/Videocollect.tsx` | `PageState` に `'offline'` を追加、オフラインフォールバック処理を追加 |

---

## テスト方針

- DevTools → Network → Offline でオフライン状態にして各ページを開く
- `/videocollect/play?id=xxx&name=yyy` でオフライン保存済み動画の再生を確認
- Videocollect 一覧ページでオフライン保存済み動画が「オフラインモード」で表示されることを確認
- SW 更新時（ビルド後）に新しいキャッシュが適用されることを確認
