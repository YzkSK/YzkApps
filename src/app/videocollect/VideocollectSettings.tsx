import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { useGoogleLogin } from '@react-oauth/google';
import { useAuth } from '../auth/AuthContext';
import { db } from '../shared/firebase';
import { type VcAuth, firestorePaths, DRIVE_SCOPES, VC_ERROR_CODES, formatSize } from './constants';
import { getStorageLimitGb, setStorageLimitGb, getOfflineStorageUsage } from './offlineStorage';
import type { SettingsSectionProps } from '../platform/registry';

// VITE_OAUTH_REDIRECT_BASE が設定されていればそのドメイン（固定）を使い、
// Google Cloud Console に登録した URI と一致させる。未設定なら現在の origin を使う。
const OAUTH_BASE = (import.meta.env.VITE_OAUTH_REDIRECT_BASE as string | undefined)?.replace(/\/$/, '') ?? window.location.origin;
const REDIRECT_URI = `${OAUTH_BASE}/settings`;

type ConnectedAccount = {
  email: string;
  name?: string;
};

async function fetchGoogleUserInfo(accessToken: string): Promise<ConnectedAccount | null> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as { email?: string; name?: string };
    return data.email ? { email: data.email, name: data.name } : null;
  } catch (e) {
    console.error('[VideocollectSettings] fetchGoogleUserInfo failed', e);
    return null;
  }
}

export const VideocollectSettings = ({ addToast }: SettingsSectionProps) => {
  const { currentUser } = useAuth();
  const location = useLocation();
  const [connected, setConnected] = useState<ConnectedAccount | null>(null);
  const [storageLimitGb, setStorageLimitGbState] = useState(() => getStorageLimitGb());
  const [storageUsage, setStorageUsage] = useState<{ count: number; totalBytes: number } | null>(null);

  useEffect(() => {
    getOfflineStorageUsage().then(setStorageUsage).catch(console.error);
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    getDoc(doc(db, firestorePaths.vcAuth(currentUser.uid)))
      .then(snap => {
        if (!snap.exists()) return;
        const data = snap.data() as VcAuth;
        if (!data.refreshToken) return;
        if (data.connectedEmail) {
          setConnected({ email: data.connectedEmail, name: data.connectedName });
        } else if (data.accessToken) {
          // 既存ユーザー: email 未保存の場合は accessToken で取得
          fetchGoogleUserInfo(data.accessToken).then(info => {
            if (info) setConnected(info);
          });
        } else {
          setConnected({ email: '接続済み' });
        }
      })
      .catch(console.error);
  }, [currentUser]);

  // OAuth リダイレクト後のコールバック処理
  useEffect(() => {
    if (!currentUser) return;
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (!code) return;

    window.history.replaceState({}, '', window.location.pathname);

    const exchange = async () => {
      try {
        const idToken = await currentUser.getIdToken();
        const proxyUrl = import.meta.env.VITE_DRIVE_PROXY_URL as string;
        const res = await fetch(`${proxyUrl}/oauth/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, uid: currentUser.uid, redirectUri: REDIRECT_URI, idToken }),
        });
        if (!res.ok) throw new Error(`exchange failed: ${res.status}`);

        // 再接続時は古いフォルダフィルターをクリア
        await setDoc(doc(db, firestorePaths.vcData(currentUser.uid)), { folders: [] }, { merge: true });

        // 連携アカウント情報を取得して保存
        const authSnap = await getDoc(doc(db, firestorePaths.vcAuth(currentUser.uid)));
        const authData = authSnap.exists() ? authSnap.data() as VcAuth : null;
        const userInfo = authData?.accessToken
          ? await fetchGoogleUserInfo(authData.accessToken)
          : null;

        if (userInfo) {
          await setDoc(
            doc(db, firestorePaths.vcAuth(currentUser.uid)),
            { connectedEmail: userInfo.email, connectedName: userInfo.name ?? '' },
            { merge: true }
          );
          setConnected(userInfo);
        } else {
          setConnected({ email: '接続済み' });
        }

        addToast('Google Drive に接続しました');
      } catch (e) {
        console.error('Drive 連携エラー:', e);
        addToast(`Drive 連携に失敗しました [${VC_ERROR_CODES.AUTH_FAILED}]`, 'error');
      }
    };
    exchange();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  const login = useGoogleLogin({
    flow: 'auth-code',
    scope: DRIVE_SCOPES,
    ux_mode: 'redirect',
    redirect_uri: REDIRECT_URI,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="app-settings-row">
        <span className="app-settings-row-label">Google Drive</span>
        <button onClick={() => login()} className="app-settings-link-btn">
          {connected ? '再接続' : '接続する'}
        </button>
      </div>

      {connected && (
        <div style={{ fontSize: 13, color: 'var(--app-text-secondary)' }}>
          連携中: {connected.email}
        </div>
      )}

      <div className="app-settings-row" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
        <span className="app-settings-row-label">オフライン保存上限</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
          <input
            type="range"
            min={1}
            max={100}
            step={1}
            value={storageLimitGb}
            onChange={e => {
              const v = Number(e.target.value);
              setStorageLimitGbState(v);
              setStorageLimitGb(v);
            }}
            style={{ flex: 1, accentColor: 'var(--app-accent, #3b82f6)' }}
          />
          <span style={{ fontSize: 13, minWidth: 44, textAlign: 'right' }}>
            {storageLimitGb} GB
          </span>
        </div>
        {storageUsage !== null && (
          <p style={{ fontSize: 12, color: 'var(--app-text-secondary)', margin: 0 }}>
            使用中: {formatSize(String(storageUsage.totalBytes))} / {storageLimitGb} GB（{storageUsage.count} 件）
          </p>
        )}
      </div>
    </div>
  );
};
