/// <reference types="@cloudflare/workers-types" />

import {
  type ServiceAccount,
  getAccessToken, firestoreGet, fsValue, parseDoc,
  base64url, encodeObj, pemToArrayBuffer,
} from '../../shared/google';

export { base64url, encodeObj, pemToArrayBuffer, fsValue, parseDoc };

export interface Env {
  GOOGLE_SERVICE_ACCOUNT: string; // Service account JSON (Cloudflare Secret)
  FIREBASE_PROJECT_ID: string;
}

interface TimetableEvent {
  periodIndex?: number;
  pi?: number;       // 旧フィールド名（後方互換）
  name: string;
  room: string;
}

interface Period {
  label: string;
  start: string;
  end: string;
}

// ── Firestore REST ────────────────────────────────────────

// push サブコレクション内の全トークンドキュメントを collectionGroup で取得
async function firestoreQueryPushTokens(
  projectId: string,
  token: string,
): Promise<Record<string, unknown>[]> {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'push', allDescendants: true }],
      },
    }),
  });
  if (!resp.ok) return [];
  const results = await resp.json() as { document?: Record<string, unknown> }[];
  return results.flatMap(r => r.document ? [r.document] : []);
}

async function firestoreDelete(
  projectId: string,
  token: string,
  path: string,
): Promise<void> {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
}

// ── FCM 送信 ──────────────────────────────────────────────

async function sendFcm(
  projectId: string,
  token: string,
  fcmToken: string,
  title: string,
  body: string,
): Promise<'ok' | 'invalid-token' | 'error'> {
  const resp = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token: fcmToken,
          data: { title, body },
          webpush: {
            headers: {
              Urgency: 'high',
              TTL: '3600',
            },
            notification: {
              title,
              body,
            },
            fcm_options: {
              link: '/app/timetable',
            },
          },
          apns: {
            payload: {
              aps: {
                alert: { title, body },
                badge: 1,
              },
            },
          },
        },
      }),
    },
  );

  if (resp.ok) return 'ok';
  const err = await resp.text();
  // 404 = トークン無効、登録解除済み
  if (resp.status === 404) return 'invalid-token';
  console.error(`FCM送信失敗 [${resp.status}]:`, err);
  return 'error';
}

// ── 時刻ユーティリティ ────────────────────────────────────

export function timeToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function todayKey(): string {
  const now = new Date();
  // JST (UTC+9)
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function nowMinJst(): number {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.getUTCHours() * 60 + jst.getUTCMinutes();
}

// ── メイン ────────────────────────────────────────────────

export default {
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      const sa: ServiceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
      const accessToken = await getAccessToken(sa, [
        'https://www.googleapis.com/auth/firebase.messaging',
        'https://www.googleapis.com/auth/datastore',
      ]);
      const projectId = env.FIREBASE_PROJECT_ID;

      const dateKey = todayKey();
      const nowMin = nowMinJst();

      // push サブコレクションを collectionGroup で直接取得
      const pushDocs = await firestoreQueryPushTokens(projectId, accessToken);

      // uid ごとにトークンをまとめる
      const byUid = new Map<string, { fcmToken: string; notifyBefore: number; docPath: string }[]>();
      for (const pushDoc of pushDocs) {
        const name = pushDoc.name as string;
        const segments = name.split('/');
        const usersIdx = segments.indexOf('users');
        if (usersIdx === -1 || usersIdx + 1 >= segments.length) {
          console.warn('notification-cron: 不正なドキュメントパス:', name);
          continue;
        }
        const uid = segments[usersIdx + 1];
        if (!uid) continue;

        const push = parseDoc(pushDoc);
        const fcmToken = push.token as string;
        const notifyBefore = (push.notifyBefore as number) ?? 10;
        // Firestore ドキュメントのフルパスから projects/.../documents/ 以降を取得
        const docPath = name.replace(/^.*\/documents\//, '');

        const tokens = byUid.get(uid) ?? [];
        tokens.push({ fcmToken, notifyBefore, docPath });
        byUid.set(uid, tokens);
      }

      await Promise.all(
        Array.from(byUid.entries()).map(async ([uid, tokens]) => {
          // 時間割データをユーザーごとに1回だけ取得
          const timetableDoc = await firestoreGet(projectId, accessToken, `users/${uid}/timetable/data`);
          if (!timetableDoc) return;
          const timetable = parseDoc(timetableDoc);
          const events = (timetable.events as Record<string, TimetableEvent[]>) ?? {};
          const periods = (timetable.periods as Period[]) ?? [];

          const todayEvents = events[dateKey] ?? [];

          await Promise.all(
            tokens.map(async ({ fcmToken, notifyBefore, docPath }) => {
              for (const ev of todayEvents) {
                const periodIdx = ev.periodIndex ?? ev.pi;
                const period = periodIdx !== undefined ? periods[periodIdx] : undefined;
                if (!period) continue;

                const notifyAt = timeToMin(period.start) - notifyBefore;
                if (nowMin === notifyAt) {
                  const body = `${period.label} ${ev.name}${ev.room ? `（${ev.room}）` : ''} ${period.start}〜`;
                  const result = await sendFcm(projectId, accessToken, fcmToken, `${notifyBefore}分後に授業があります`, body);
                  if (result === 'invalid-token') {
                    // 無効なトークンはFirestoreから削除
                    await firestoreDelete(projectId, accessToken, docPath);
                  }
                }
              }
            }),
          );
        }),
      );
    } catch (e) {
      console.error('notification-cron: scheduled 処理中に予期しないエラーが発生しました:', e);
    }
  },
};
