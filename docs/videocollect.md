# Videocollect（動画ビューワー）

## 概要

Google Drive 内の動画ファイルをグリッド表示・再生できる機能。

- パス: `/app/videocollect`（動画一覧）、`/app/videocollect/play`（プレイヤー）
- 要認証: `ProtectedRoute` でラップ
- Google Drive 連携（OAuth 2.0）が必要

---

## Google OAuth 連携フロー

1. ユーザーが `/app/settings` の「外部連携」セクションで「接続する」をクリック
2. `@react-oauth/google` の `useGoogleLogin({ flow: 'auth-code', ux_mode: 'redirect' })` でリダイレクト起動
3. コールバックで認証コードを受け取り Worker の `POST /oauth/exchange` に送信（Firebase IDトークン付き）
4. Worker がIDトークンを検証し、Googleとコードを交換して `accessToken + refreshToken + tokenExpiry` を取得
5. Worker が Firestore `users/{uid}/videocollect/auth` にトークン情報を保存
6. 以降のアクセスで `accessToken` が5分以内に期限切れの場合、Worker の `POST /oauth/refresh` で自動更新

---

## Firestore パス

```
users/{uid}/videocollect/auth   →  VcAuth { accessToken, refreshToken, tokenExpiry }
users/{uid}/videocollect/data   →  VcData { folders: DriveFolder[], tags: Record<fileId, string[]> }
```

- `auth`: 設定画面の接続ボタンで Worker 経由で書き込まれる。フロントから直接書き込まない。
- `data`: `useFirestoreData` + `useFirestoreSave`（800ms デバウンス）で管理。

---

## ファイル構成

```
src/app/videocollect/
  constants.ts          型定義・エラーコード・Drive API 関数・ユーティリティ
  videocollect.css      --vc-* CSS 変数・全スタイル
  Videocollect.tsx      動画一覧ページ（グリッド/リスト切替・タグ/並べ替えフィルター・モーダル管理）
  VideoPlayer.tsx       動画プレイヤーページ
  views/
    VideoGrid.tsx       グリッドレイアウト
    VideoCard.tsx       動画カード（サムネイル・プレビュー・タグ・リネーム/削除ボタン）
    VideoList.tsx       リストレイアウト（横並びサムネイル・メタ情報・アクションボタン）
  modals/
    FolderModal.tsx     フォルダ選択（パンくずリスト・チェックボックス）
    FolderPickerModal.tsx  単一フォルダ選択（パンくずリスト・UploadModal で使用）
    FilterModal.tsx     タグ絞り込み・並べ替え設定
    TagModal.tsx        タグ編集（既存タグ選択・オートコンプリート）
    UploadModal.tsx     動画アップロード（複数ファイル・ドラッグ＆ドロップ・resumable upload）
    RenameModal.tsx     ファイル名変更（Drive PATCH API）
    DeleteModal.tsx     ファイル削除確認（Drive ゴミ箱移動）

workers/drive-proxy/
  src/index.ts          Cloudflare Worker（ストリーミングプロキシ・OAuth・IDトークン検証）
  wrangler.toml
  package.json
```

---

## Cloudflare Worker エンドポイント

| エンドポイント | 用途 |
|---|---|
| `GET /stream/{fileId}?token=` | 動画ストリーミング（Range ヘッダープロキシ）。nonce TTL は 3600 秒（1時間）。エッジキャッシュと isolate 内インメモリキャッシュで高速化 |
| `POST /oauth/exchange` | `{ code, uid, idToken, redirectUri }` → トークン交換・Firestore 保存 |
| `POST /oauth/refresh` | `{ uid, idToken }` → リフレッシュトークンで accessToken 更新 |

Worker の CORS は `ALLOWED_ORIGIN` 環境変数で指定したオリジンのみ許可。

`/oauth/exchange` と `/oauth/refresh` は Firebase IDトークンを検証し、リクエスト内 `uid` と一致する場合のみ処理する。

---

## 環境変数

| 変数 | 説明 | 設定場所 |
|---|---|---|
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth クライアント ID | `.env` / Cloudflare Pages |
| `VITE_DRIVE_PROXY_URL` | drive-proxy Worker の公開 URL | `.env` / Cloudflare Pages |
| `ALLOWED_ORIGIN` | Worker の CORS 許可オリジン | Cloudflare Worker vars |
| `FIREBASE_PROJECT_ID` | Firebase プロジェクト ID | Cloudflare Worker vars |
| `FIREBASE_WEB_API_KEY` | Firebase Web API キー（IDトークン検証用） | Cloudflare Worker vars |
| `GOOGLE_OAUTH_CLIENT_ID` | Worker 側 OAuth クライアント ID | Cloudflare Worker vars |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth クライアントシークレット | Cloudflare Worker secrets |
| `GOOGLE_SERVICE_ACCOUNT` | Firebase サービスアカウント JSON | Cloudflare Worker secrets |

---

## 主要な型

```typescript
type DriveFile = {
  id: string; name: string; mimeType: string;
  size: string; modifiedTime: string;
  thumbnailLink?: string;
  videoMediaMetadata?: { durationMillis?: string; width?: number; height?: number };
};

type DriveFolder = { id: string; name: string };

type VcData = {
  folders: DriveFolder[];
  tags: Record<string, string[]>;   // fileId → タグ一覧
};

type VcAuth = {
  accessToken: string;
  refreshToken: string;
  tokenExpiry: number;   // Unix timestamp (ms)
};
```

---

## 動画一覧ページ（Videocollect.tsx）

### 状態

```typescript
type PageState =
  | { status: 'unauthenticated' }  // refreshToken なし → 設定画面へ誘導
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'empty' }
  | { status: 'loaded'; files: DriveFile[] };

type Modal =
  | null
  | { type: 'folder' }
  | { type: 'upload' }
  | { type: 'filter' }
  | { type: 'tag'; file: DriveFile }
  | { type: 'rename'; file: DriveFile }
  | { type: 'delete'; file: DriveFile };
```

### localStorage キー

| キー | 値 | 説明 |
|---|---|---|
| `vc-view-mode` | `'grid'` \| `'list'` | 表示モード（デフォルト: `'grid'`） |
| `vc-autoplay-next` | `'true'` \| `'false'` | 自動再生設定 |
| `vc-playing-id` | fileId 文字列 | 現在再生中の動画 ID（VideoPlayer がマウント時に書き込み） |

### 処理フロー

1. `useFirestoreData` で VcData（フォルダ・タグ）を読み込み
2. `getDoc` で VcAuth を読み込み
3. `currentUser.getIdToken()` で Firebase IDトークンを取得
4. `loadAccessToken(uid, auth, idToken)` で有効なアクセストークンを取得（必要に応じて Worker でリフレッシュ）
5. `fetchAllDriveFiles()` でフォルダフィルターを適用して動画一覧を全件取得
6. タグフィルター・並べ替えはクライアントサイドで適用

### グリッド/リスト切替

ツールバー右にグリッド/リストの切替ボタンを配置。選択した表示モードは `localStorage('vc-view-mode')` で永続化。

- **グリッド（VideoGrid + VideoCard）**: サムネイル主体のカードレイアウト。カードクリックで10秒プレビュー、サムネクリックでプレイヤーへ遷移。
- **リスト（VideoList）**: 横並びサムネイル（108px）＋タイトル・日付・サイズ・タグのリストレイアウト。

### リネーム・削除

- **リネーム**: RenameModal でファイル名を変更。`renameFile(accessToken, fileId, newName)` が Drive PATCH API を呼び出す。成功時に `pageState` をオプティミスティック更新し、トーストを表示。
- **削除**: DeleteModal でゴミ箱移動を確認。`trashFile(accessToken, fileId)` が `{ trashed: true }` で Drive PATCH API を呼び出す。成功時に `pageState` から除外し、タグ情報を Firestore から削除。

### タグフィルター・並べ替え（FilterModal）

- タグ: OR 条件（選択タグのいずれかを持つファイルを表示）
- 並べ替え: 日付（新しい順/古い順）・名前（昇順/降順）・サイズ（大きい順/小さい順）

---

## 動画プレイヤー（VideoPlayer.tsx）

`/app/videocollect/play?id={fileId}&name={fileName}` で起動。

### 機能

- 再生/停止、シークバー（バッファ済み範囲を薄色で表示）
- スキップ秒数設定（設定モーダルで変更可、デフォルト10秒）
- 音量ミュート、再生速度変更（0.5x / 0.75x / 1x / 1.25x / 1.5x / 2x）
- フルスクリーン（標準 Fullscreen API + iOS Safari フォールバック）
- ダウンロード（Worker プロキシ URL で `<a download>` クリック）
- コントロール 3秒後自動非表示（一時停止中は常時表示）
- タグ編集（VideoPlayer 画面からも TagModal を開ける）
- 設定モーダル: フルスクリーン中も表示（container 内に絶対配置）
- 再生中の動画 ID を `localStorage('vc-playing-id')` に保存（動画一覧の「再生中」バッジ表示に使用）

### 自動再生（autoplay next）

- 設定モーダルの「自動再生」トグルで ON/OFF 切替。設定は `localStorage('vc-autoplay-next')` で永続化。
- 動画終了時に同タグの動画（優先）またはおすすめ動画から次の動画を選択し、5秒のカウントダウン後に自動遷移。
- プレイヤー右下に次動画のサムネイル・タイトル・カウントダウンバーを表示。キャンセルボタンで中断可能。
- レコメンドカード上にも残り秒数オーバーレイ（`.vc-rec-nextup-overlay`）を表示。
- `const AUTOPLAY_SECONDS = 5`（`videocollect.css` のアニメーション duration と一致させること）

### エラー表示

| 状態 | 表示 |
|---|---|
| Google Drive 処理中 | 「Google Drive が動画を処理中です」メッセージ |
| コーデック非対応（`videoWidth === 0`） | 黄色い警告バナー（H.265、ハードウェアアクセラレーション有効化を案内） |
| その他エラー | 「動画を読み込めませんでした」＋再試行ボタン |

### nonce 期限切れ時の自動復旧

`onError` 発火時、まず `fetchNonce` で新しい nonce を再取得する（旧 nonce の有効期限切れに対応）。取得成功時は現在の再生位置を `nonceRefreshTimeRef` に保存し、`videoNonce` を更新して動画を再ロード。`onCanPlay` 時に保存位置へシークして再生を継続する。nonce 取得も失敗した場合のみ Drive の処理中判定を行い、`setVideoError` でエラー表示する。

### Worker のストリーミング最適化

重ための動画で起きるバッファ枯渇（periodic loading）に対して、`workers/drive-proxy` で以下の 2 段階キャッシュを実装している：

1. **isolate 内インメモリキャッシュ（`nonceMemCache`）**: 同一再生セッション内の連続 Range リクエストで KV ルックアップ（~15ms/回）をスキップ
2. **Cloudflare エッジキャッシュ（`caches.default`）**: 一度取得した Range セグメントを Cloudflare エッジに 1 時間キャッシュ。シーク・リプレイ時に Google Drive へのラウンドトリップが不要になる（~5ms vs ~100ms）

Google Drive からのレスポンスは `body.tee()` でブラウザ配信とキャッシュ書き込みを同時に行い、ストリーミングの遅延を生じさせない。

### キーボードショートカット

| キー | 操作 |
|---|---|
| Space / K | 再生/停止 |
| ← | -5秒 |
| → | +5秒 |
| ↑ | 音量 +10% |
| ↓ | 音量 -10% |
| M | ミュート切り替え |
| F | フルスクリーン切り替え |

### モバイルダブルタップ

- 画面左側でダブルタップ → -N秒（設定モーダルで変更可）
- 画面右側でダブルタップ → +N秒
- 300ms 以内の同一サイドへの2回タップで判定
- 連続ダブルタップで秒数を加算（例: 3回連続 → 30秒）

### フルスクリーン時の安全領域対応

```css
.vc-player-controls-inner {
  padding-bottom: max(16px, env(safe-area-inset-bottom));
  padding-left:   max(16px, env(safe-area-inset-left));
  padding-right:  max(16px, env(safe-area-inset-right));
}
```

---

## VideoCard（views/VideoCard.tsx）

- カードクリック: 10秒間ミュートプレビュー再生（プロキシ経由）
- サムネクリック: プレイヤーページへ遷移
- レイアウト: サムネイル → タイトル → 日付 → タグ
- `isPlaying` が `true` のとき、サムネイル上に「再生中」バッジ（`.vc-now-playing-badge`）を表示
- タグ行右にリネーム・削除・タグ編集の3つのアイコンボタンを表示

## VideoList（views/VideoList.tsx）

- 横並びサムネイル（108px）＋本文（タイトル・日付・サイズ・タグ）＋アクションボタンのリストレイアウト
- サムネクリックでプレイヤーへ遷移
- `isPlaying` が `true` のとき、サムネイル上に「再生中」バッジを表示
- アクションボタン: リネーム・削除・タグ編集

---

## アップロード（UploadModal）

- 複数ファイル同時選択・ドラッグ＆ドロップ対応
- Google Drive Resumable Upload API 使用
- ファイルごとに順番にアップロード（一部失敗しても継続）
- 全体進捗バー（N/M 完了・%）を表示。ファイル別進捗は折りたたみ展開
- 推奨形式: H.264 (MP4)。H.265 は Chrome（ハードウェアアクセラレーション無効時）で再生不可
- 保存先フォルダは `FolderPickerModal` でパンくずナビゲーション付きで選択可能

---

## Drive API

- ファイル・フォルダ一覧: クライアントから直接 `https://www.googleapis.com/drive/v3/files` を呼び出し（CORS 問題なし）
- ページネーション: `pageSize=1000` + `nextPageToken` で全件取得
- 動画ストリーミング: CORS 制限のため Worker プロキシ経由（Range ヘッダー転送）
  - `acknowledgeAbuse=true&supportsAllDrives=true` を付与
  - レスポンスが `text/html`（Drive 処理中ページ）の場合は 503 を返す

---

## オフラインストレージ

動画をブラウザのローカルストレージ（IndexedDB）に圧縮して保存し、オフラインで視聴できる機能。

### ファイル

| ファイル | 説明 |
|---|---|
| `src/app/videocollect/offlineStorage.ts` | IndexedDB CRUD（保存・取得・削除・一覧・使用量） |
| `src/app/videocollect/videoCompressorUtils.ts` | スケーリング計算ユーティリティ（純粋関数） |
| `src/app/videocollect/videoCompressor.ts` | WebCodecs Worker の生成・管理、`isWebCodecsSupported()`、Quality 型定義 |
| `src/app/videocollect/videoCompressorWorker.ts` | Web Worker — mp4box demux → VideoDecoder/Encoder → AudioDecoder/Encoder → mp4-muxer |
| `src/app/videocollect/modals/OfflineSaveModal.tsx` | 品質選択・進捗表示モーダル（非対応ブラウザ警告付き） |

### IndexedDB スキーマ

- DB 名: `vc-offline-v1`、ストア: `videos`（keyPath: `fileId`）
- エントリ: `{ fileId: string, fileName: string, blob: Blob, savedAt: number, size: number }`

### 圧縮品質プリセット

| ラベル | 解像度上限 | 映像ビットレート | 音声ビットレート | 推定サイズ比 |
|---|---|---|---|---|
| 高画質 | 元の解像度 | 4 Mbps | 128 kbps | 約 70% |
| 中画質 | 720p (1280×720) | 2 Mbps | 96 kbps | 約 40% |
| 低画質 | 480p (854×480) | 800 kbps | 64 kbps | 約 20% |

WebCodecs API（`VideoEncoder` / `AudioDecoder` 等）を使用してブラウザのハードウェアエンコーダーで処理する。
`@ffmpeg/ffmpeg` (ffmpeg.wasm) は削除済み。

**サポート要件:** iOS Safari 16.4+、Chrome 94+。非対応ブラウザではモーダルで警告を表示し original のみ許可。

### 保存上限設定

- `localStorage('vc-offline-limit-gb')` で保存上限を GB 単位で管理（デフォルト: 5 GB）
- VideoPlayer 設定モーダルのスライダー（1〜100 GB）で変更可能

### 保存フロー

1. VideoPlayer でオフライン保存ボタンをクリック
2. `OfflineSaveModal` で品質を選択（非対応ブラウザでは original のみ）
3. プロキシ URL から動画 blob を fetch（進捗表示）
4. WebCodecs API（Web Worker 内）で圧縮（進捗表示）
5. IndexedDB に保存 → トースト通知

### オフライン再生フロー

- VideoPlayer マウント時に `isOfflineSaved(fileId)` を確認
- 保存済みの場合: `URL.createObjectURL(blob)` を `videoSrc` として使用（ネットワーク不要）
- 動画一覧（Videocollect）でサムネイル右上に「オフライン」バッジを表示

---

## エラーコード

| コード | 定数 | 説明 |
|---|---|---|
| E021 | AUTH_FAILED | Google Drive 連携失敗 |
| E022 | FILES_FETCH | 動画一覧取得失敗 |
| E023 | FOLDERS_FETCH | フォルダ一覧取得失敗 |
| E024 | TOKEN_REFRESH | アクセストークン更新失敗 |
| E025 | UPLOAD_FAILED | アップロード失敗 |
| E026 | TAG_SAVE | タグ保存失敗（予約） |
| E027 | RENAME | ファイル名変更失敗 |
| E028 | DELETE | ファイル削除失敗 |
| E029 | OFFLINE_SAVE | オフライン保存失敗 |
| E030 | OFFLINE_LOAD | オフライン読み込み失敗（予約） |
| E031 | COMPRESS | 動画圧縮失敗 |

---

## Google Cloud Console 設定（必須）

1. Google Drive API を有効化
2. OAuth 2.0 クライアント ID（ウェブアプリ）を作成
3. 承認済みの JavaScript 生成元に開発 URL と本番 URL を追加
4. 承認済みのリダイレクト URI に `/app/settings` の完全 URL を追加
5. クライアント ID を `VITE_GOOGLE_CLIENT_ID` と Worker vars に設定
6. クライアントシークレットを Worker secrets (`GOOGLE_OAUTH_CLIENT_SECRET`) に設定
