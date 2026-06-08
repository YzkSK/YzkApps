# エラーコード一覧

ユーザーに表示するエラーコードは `E` + 3桁数字で統一する。機能単位でグループ化されている。

---

## Timetable — 通知設定 (`src/app/timetable/TimetableSettings.tsx`)

| コード | 定数名 | 説明 |
|---|---|---|
| E001 | `SW_NOT_READY` | Service Worker の準備が完了していない |
| E002 | `TOKEN_FETCH` | FCM トークンの取得に失敗 |
| E003 | `TOKEN_SAVE` | FCM トークンの Firestore 保存に失敗 |
| E004 | `TOKEN_DELETE` | FCM トークンの SW 側削除に失敗 |
| E005 | `TOKEN_DB_DELETE` | FCM トークンの Firestore 削除に失敗 |
| E006 | `NOTIFY_BEFORE_UPDATE` | 通知タイミングの同期に失敗 |

---

## Quiz — AI 解説生成 (`src/app/quiz/constants.ts`)

| コード | 定数名 | 説明 |
|---|---|---|
| E011 | `NO_API_KEY` | Gemini API キーが未設定 |
| E012 | `GENERATE` | AI 解説の生成に失敗 |

---

## VideoCollect — Google Drive 動画ビューワー (`src/app/videocollect/constants.ts`)

| コード | 定数名 | 説明 |
|---|---|---|
| E021 | `AUTH_FAILED` | Google 認証に失敗 |
| E022 | `FILES_FETCH` | ファイル一覧の取得に失敗 |
| E023 | `FOLDERS_FETCH` | フォルダ一覧の取得に失敗 |
| E024 | `TOKEN_REFRESH` | アクセストークンの更新に失敗 |
| E025 | `UPLOAD_FAILED` | ファイルのアップロードに失敗 |
| E026 | `TAG_SAVE` | タグの保存に失敗 |
| E027 | `RENAME` | ファイル名の変更に失敗 |
| E028 | `DELETE` | ファイルの削除に失敗 |
| E029 | `OFFLINE_SAVE` | オフライン保存に失敗 |
| E030 | `OFFLINE_LOAD` | オフラインデータの読み込みに失敗 |
| E031 | `COMPRESS` | 動画の圧縮に失敗 |
| E032 | `NONCE_FETCH` | 動画ストリーミング用 nonce の取得に失敗 |

---

## Transcribe — 文字起こし (`src/app/transcribe/constants.ts`)

| コード | 定数名 | 説明 |
|---|---|---|
| E101 | `NO_API_KEY` | Gemini API キーが未設定 |
| E102 | `INVALID_FILE_TYPE` | サポートされていないファイル形式 |
| E103 | `TOO_LARGE` | ファイルサイズが上限を超えている |
| E104 | `API_ERROR` | Gemini API 呼び出しに失敗 |
| E105 | `BAD_RESPONSE` | API レスポンスの解析に失敗 |

---

## Settings — 設定 (`src/app/transcribe/TranscribeSettings.tsx`)

| コード | 定数名 | 説明 |
|---|---|---|
| E201 | `SAVE_FAILED` | 設定の保存に失敗 |

---

## Cloud Functions — パスワードリセット (`firebase-functions/src/index.ts`)

> Cloud Functions のエラーコードはクライアント側ではなく、サーバー側のエラーメッセージに含まれてフロントエンドに返される。

| コード | 定数名 | 説明 |
|---|---|---|
| E001 | `INVALID_ARG` | メールアドレスが未指定 |
| E002 | `RATE_EXCEEDED` | 5分以内の連続送信でレート制限に到達 |
| E003 | `SEND_FAILED` | メール送信に失敗（Resend API エラー） |

---

## 規約

- ユーザー向けメッセージは `'エラー内容 [Exx]'` の形式で末尾にコードを付与する
- 技術的な詳細は `console.error` に出力し、ユーザーには見せない
- コードは機能単位でグループ化し、各機能ファイルの先頭（または `constants.ts`）にまとめて定義する
- 新機能追加時はこのドキュメントにも追記すること
