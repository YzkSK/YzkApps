/// <reference types="@cloudflare/workers-types" />

import { Auth, WorkersKVStoreSingle } from 'firebase-auth-cloudflare-workers';
import {
  type ServiceAccount,
  getAccessToken, firestoreGet, fsValue, parseDoc,
} from '../../shared/google';

export interface Env {
  ALLOWED_ORIGIN: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_WEB_API_KEY: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  GOOGLE_SERVICE_ACCOUNT: string;
  NONCE_KV: KVNamespace;
  PUBLIC_JWK_CACHE_KEY: string;
  PUBLIC_JWK_CACHE_KV: KVNamespace;
}

// ── Firestore REST ────────────────────────────────────────────────────────────

type FsFieldValue =
  | { stringValue: string }
  | { integerValue: string }
  | { booleanValue: boolean }
  | { nullValue: null };

function toFsValue(v: unknown): FsFieldValue {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return { integerValue: String(Math.floor(v)) };
  if (typeof v === 'boolean') return { booleanValue: v };
  return { nullValue: null };
}

// firestoreGet と統一: エラー時は false を返し、例外を throw しない
async function firestoreSet(
  projectId: string,
  token: string,
  path: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const fields: Record<string, FsFieldValue> = {};
  for (const [k, v] of Object.entries(data)) {
    fields[k] = toFsValue(v);
  }
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!resp.ok) {
    console.error(`Firestore write failed: ${resp.status}`);
    return false;
  }
  return true;
}

// ── Firebase ID token 検証 ────────────────────────────────────────────────────

type FirebaseAuthEnv = Pick<Env, 'FIREBASE_PROJECT_ID' | 'PUBLIC_JWK_CACHE_KEY' | 'PUBLIC_JWK_CACHE_KV'>;

export function createFirebaseAuth(env: FirebaseAuthEnv): Auth {
  return Auth.getOrInitialize(
    env.FIREBASE_PROJECT_ID,
    WorkersKVStoreSingle.getOrInitialize(env.PUBLIC_JWK_CACHE_KEY, env.PUBLIC_JWK_CACHE_KV),
  );
}

/** Firebase ID トークンを署名検証し、有効なら uid を返す */
async function verifyIdToken(
  idToken: string,
  env: FirebaseAuthEnv,
): Promise<string | null> {
  try {
    const auth = createFirebaseAuth(env);
    const token = await auth.verifyIdToken(idToken, false);
    return token.uid;
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchesOrigin(requestOrigin: string, allowed: string): boolean {
  if (allowed.startsWith('https://*.')) {
    const suffix = allowed.slice('https://*'.length); // e.g. '.my-portfolio.pages.dev'
    return requestOrigin.startsWith('https://') && requestOrigin.endsWith(suffix);
  }
  return requestOrigin === allowed;
}

// Origin がない場合（curl など）は空オブジェクトを返す。
// ホワイトリスト外の Origin は allowedOrigins[0] をフォールバックとして返す（既存動作を維持）。
function corsHeaders(requestOrigin: string | null, allowedOrigins: string[]): Record<string, string> {
  if (!requestOrigin) return {};
  const matched = allowedOrigins.find(a => matchesOrigin(requestOrigin, a));
  const origin = matched ? requestOrigin : allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  };
}

function json(cors: Record<string, string>, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function jsonError(cors: Record<string, string>, msg: string, status: number): Response {
  return json(cors, { error: msg }, status);
}

// ── Handlers ──────────────────────────────────────────────────────────────────

// nonce → { uid, accessToken } のマッピングを NONCE_KV に保存する TTL（秒）
const NONCE_TTL_SECONDS = 300;

/**
 * POST /nonce: idToken を検証し、短命 nonce を発行する。
 * フロントエンドはこの nonce を /stream/{fileId}?token=nonce に使用する。
 * nonce は NONCE_KV に 300 秒間保存される（ログにアクセストークンが残らないようにするため）。
 */
async function handleNonce(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  let uid: string, idToken: string, accessToken: string;
  try {
    const body = await request.json() as { uid?: string; idToken?: string; accessToken?: string };
    uid = body.uid ?? '';
    idToken = body.idToken ?? '';
    accessToken = body.accessToken ?? '';
  } catch {
    return jsonError(cors, 'Invalid JSON', 400);
  }
  if (!uid || !idToken || !accessToken) return jsonError(cors, 'Missing required fields', 400);

  const verifiedUid = await verifyIdToken(idToken, env);
  if (!verifiedUid || verifiedUid !== uid) return jsonError(cors, 'Unauthorized', 401);

  // UUID v4 を nonce として生成
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  nonceBytes[6] = (nonceBytes[6] & 0x0f) | 0x40;
  nonceBytes[8] = (nonceBytes[8] & 0x3f) | 0x80;
  const hex = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const nonce = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

  await env.NONCE_KV.put(nonce, JSON.stringify({ uid, accessToken }), {
    expirationTtl: NONCE_TTL_SECONDS,
  });

  return json(cors, { nonce });
}

async function handleStream(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  fileId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const nonce = url.searchParams.get('token');
  if (!nonce) return jsonError(cors, 'Unauthorized', 401);

  // NONCE_KV から nonce を検証してアクセストークンを取得
  const nonceData = await env.NONCE_KV.get(nonce);
  if (!nonceData) return jsonError(cors, 'Unauthorized', 401);

  let accessToken: string;
  try {
    const parsed = JSON.parse(nonceData) as { uid?: string; accessToken?: string };
    if (!parsed.accessToken) return jsonError(cors, 'Unauthorized', 401);
    accessToken = parsed.accessToken;
  } catch {
    return jsonError(cors, 'Unauthorized', 401);
  }

  const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&acknowledgeAbuse=true&supportsAllDrives=true`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'video/*,application/octet-stream',
  };
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  const resp = await fetch(driveUrl, { headers });

  // Drive がトランスコード処理中の場合、HTML のエラーページが返ってくる
  const contentType = resp.headers.get('Content-Type') ?? '';
  if (contentType.includes('text/html')) {
    return jsonError(cors, 'processing', 503);
  }

  const respHeaders: Record<string, string> = { ...cors };
  for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
    const v = resp.headers.get(h);
    if (v) respHeaders[h] = v;
  }
  if (!respHeaders['Content-Type']) respHeaders['Content-Type'] = 'video/mp4';
  respHeaders['Cache-Control'] = 'private, max-age=3600';

  return new Response(resp.body, { status: resp.status, headers: respHeaders });
}

async function handleExchange(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  let code: string, uid: string, redirectUri: string, idToken: string;
  try {
    const body = await request.json() as { code?: string; uid?: string; redirectUri?: string; idToken?: string };
    code = body.code ?? '';
    uid = body.uid ?? '';
    redirectUri = body.redirectUri ?? 'postmessage';
    idToken = body.idToken ?? '';
  } catch {
    return jsonError(cors, 'Invalid JSON', 400);
  }
  if (!code || !uid || !idToken) return jsonError(cors, 'Missing required fields', 400);

  const verifiedUid = await verifyIdToken(idToken, env);
  if (!verifiedUid || verifiedUid !== uid) return jsonError(cors, 'Unauthorized', 401);

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.text();
    console.error('Token exchange failed:', err);
    return jsonError(cors, 'Token exchange failed', 500);
  }

  const tokens = await tokenResp.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (!tokens.refresh_token) {
    return jsonError(cors, 'No refresh token returned', 500);
  }

  const sa: ServiceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const firebaseToken = await getAccessToken(sa, ['https://www.googleapis.com/auth/datastore']);
  const ok = await firestoreSet(env.FIREBASE_PROJECT_ID, firebaseToken, `users/${uid}/videocollect/auth`, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiry: Date.now() + tokens.expires_in * 1000,
  });
  if (!ok) return jsonError(cors, 'Internal Server Error', 500);

  return json(cors, { success: true });
}

async function handleRefresh(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  let uid: string, idToken: string;
  try {
    const body = await request.json() as { uid?: string; idToken?: string };
    uid = body.uid ?? '';
    idToken = body.idToken ?? '';
  } catch {
    return jsonError(cors, 'Invalid JSON', 400);
  }
  if (!uid || !idToken) return jsonError(cors, 'Missing required fields', 400);

  const verifiedUid = await verifyIdToken(idToken, env);
  if (!verifiedUid || verifiedUid !== uid) return jsonError(cors, 'Unauthorized', 401);

  const sa: ServiceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const firebaseToken = await getAccessToken(sa, ['https://www.googleapis.com/auth/datastore']);
  const authDoc = await firestoreGet(env.FIREBASE_PROJECT_ID, firebaseToken, `users/${uid}/videocollect/auth`);
  if (!authDoc) return jsonError(cors, 'Not connected', 401);

  const parsed = parseDoc(authDoc);
  const refreshToken = parsed.refreshToken as string | undefined;
  if (!refreshToken) return jsonError(cors, 'No refresh token', 401);

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenResp.ok) {
    console.error('Token refresh failed:', await tokenResp.text());
    return jsonError(cors, 'Refresh failed', 500);
  }

  const tokens = await tokenResp.json() as {
    access_token: string;
    expires_in: number;
  };
  const tokenExpiry = Date.now() + tokens.expires_in * 1000;

  const ok = await firestoreSet(env.FIREBASE_PROJECT_ID, firebaseToken, `users/${uid}/videocollect/auth`, {
    accessToken: tokens.access_token,
    refreshToken,
    tokenExpiry,
  });
  if (!ok) return jsonError(cors, 'Internal Server Error', 500);

  return json(cors, { accessToken: tokens.access_token, tokenExpiry });
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowedOrigins = env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
    const cors = corsHeaders(request.headers.get('Origin'), allowedOrigins);

    try {
      const url = new URL(request.url);

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
      }

      const streamMatch = url.pathname.match(/^\/stream\/([^/]+)$/);
      if (streamMatch && request.method === 'GET') {
        return handleStream(request, env, cors, streamMatch[1]);
      }

      if (url.pathname === '/nonce' && request.method === 'POST') {
        return handleNonce(request, env, cors);
      }

      if (url.pathname === '/oauth/exchange' && request.method === 'POST') {
        return handleExchange(request, env, cors);
      }

      if (url.pathname === '/oauth/refresh' && request.method === 'POST') {
        return handleRefresh(request, env, cors);
      }

      return new Response('Not Found', { status: 404, headers: cors });
    } catch (e) {
      console.error('Worker error:', e);
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  },
};
