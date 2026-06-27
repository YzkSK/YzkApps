import { useState, useEffect, useRef } from 'react';
import { doc, setDoc, deleteDoc } from 'firebase/firestore';
import { getToken, deleteToken } from 'firebase/messaging';
import { db, messaging } from '../shared/firebase';
import { useAuth } from '../auth/AuthContext';
import { useFirestoreData } from '../shared/useFirestoreData';
import { useFirestoreSave } from '../shared/useFirestoreSave';
import { Button } from '@/components/ui/button';
import type { SettingsSectionProps } from '../platform/registry';
import {
  DEFAULT_PERIODS,
  NOTIFY_OPTIONS,
  firestorePaths,
  type Period,
  type Events,
} from './constants';

const NOTIFY_ERROR_CODES = {
  SW_NOT_READY:        'E001',
  TOKEN_FETCH:         'E002',
  TOKEN_SAVE:          'E003',
  TOKEN_DELETE:        'E004',
  TOKEN_DB_DELETE:     'E005',
  NOTIFY_BEFORE_UPDATE: 'E006',
} as const;

type TimetableSettingsData = {
  events: Events;
  periods: Period[];
  notifyBefore: number;
};

const parse = (raw: Record<string, unknown>): TimetableSettingsData => {
  const periods: Period[] = Array.isArray(raw.periods)
    ? (raw.periods as Record<string, unknown>[]).map(p => ({
        label: String(p.label ?? ''),
        start: String(p.start ?? ''),
        end: String(p.end ?? ''),
      }))
    : DEFAULT_PERIODS;
  const notifyBefore = typeof raw.notifyBefore === 'number' ? raw.notifyBefore : 10;
  return { events: {}, periods, notifyBefore };
};

const addMin = (t: string, m: number): string => {
  const [h, mi] = t.split(':').map(Number);
  const total = h * 60 + mi + m;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

export const TimetableSettings = ({ addToast }: SettingsSectionProps) => {
  const { currentUser } = useAuth();
  const currentTokenRef = useRef<string>('');

  const [notifyEnabled, setNotifyEnabled] = useState(() => {
    const saved = localStorage.getItem('notifyEnabled') === 'true';
    const perm = typeof Notification !== 'undefined' ? Notification.permission : 'default';
    return saved && perm === 'granted';
  });
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );
  const [notifyToggling, setNotifyToggling] = useState(false);

  const [editingPeriods, setEditingPeriods] = useState<Period[] | null>(null);
  const [periodsError, setPeriodsError] = useState('');

  const { data, setData, loading } = useFirestoreData({
    currentUser,
    path: currentUser ? firestorePaths.timetableData(currentUser.uid) : '',
    parse,
    loadingKey: 'tt-settings',
    initialData: { events: {}, periods: DEFAULT_PERIODS, notifyBefore: 10 },
  });

  const save = useFirestoreSave<Pick<TimetableSettingsData, 'notifyBefore' | 'periods'>>({
    currentUser,
    path: currentUser ? firestorePaths.timetableData(currentUser.uid) : '',
  });

  // マウント時に一度だけ既存トークンを currentTokenRef に復元する。
  // notifyEnabled は localStorage から復元済みの初期値を参照するため deps 省略は意図的。
  useEffect(() => {
    if (!notifyEnabled || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready
      .then(async sw => {
        try {
          const token = await getToken(messaging, {
            vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
            serviceWorkerRegistration: sw,
          });
          currentTokenRef.current = token;
        } catch { /* トークン取得失敗は無視 */ }
      })
      .catch(console.error);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const requestPermission = async () => {
    if (typeof Notification === 'undefined') {
      addToast('このブラウザは通知非対応です');
      return false;
    }
    const r = await Notification.requestPermission();
    setPermission(r);
    return r === 'granted';
  };

  const savePushToken = async (token: string, notifyBefore: number) => {
    if (!currentUser) return;
    currentTokenRef.current = token;
    const ref = doc(db, firestorePaths.pushTokenDoc(currentUser.uid, token));
    await setDoc(ref, { token, notifyBefore });
  };

  const removePushToken = async () => {
    if (!currentUser || !currentTokenRef.current) return;
    const ref = doc(db, firestorePaths.pushTokenDoc(currentUser.uid, currentTokenRef.current));
    await deleteDoc(ref);
    currentTokenRef.current = '';
  };

  const toggleNotify = async () => {
    setNotifyToggling(true);
    try {
      if (!notifyEnabled) {
        const granted = permission === 'granted' || await requestPermission();
        if (granted) {
          let sw: ServiceWorkerRegistration;
          try {
            sw = await navigator.serviceWorker.ready;
          } catch (e) {
            console.error('SW準備失敗:', e);
            addToast(`通知の設定に失敗しました [${NOTIFY_ERROR_CODES.SW_NOT_READY}]`, 'error');
            return;
          }
          let token: string;
          try {
            token = await getToken(messaging, {
              vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
              serviceWorkerRegistration: sw,
            });
          } catch (e) {
            console.error('FCMトークン取得失敗:', e);
            addToast(`通知の設定に失敗しました [${NOTIFY_ERROR_CODES.TOKEN_FETCH}]`, 'error');
            return;
          }
          try {
            await savePushToken(token, data.notifyBefore);
          } catch (e) {
            console.error('トークン保存失敗:', e);
            addToast(`通知の設定に失敗しました [${NOTIFY_ERROR_CODES.TOKEN_SAVE}]`, 'error');
            return;
          }
          setNotifyEnabled(true);
          localStorage.setItem('notifyEnabled', 'true');
          addToast('通知をオンにしました');
        } else {
          addToast('通知が許可されていません', 'warning');
        }
      } else {
        setNotifyEnabled(false);
        localStorage.setItem('notifyEnabled', 'false');
        try {
          await deleteToken(messaging);
        } catch (e) {
          console.error('FCMトークン削除失敗:', e);
          addToast(`クリーンアップに失敗しました [${NOTIFY_ERROR_CODES.TOKEN_DELETE}]`, 'warning');
        }
        try {
          await removePushToken();
        } catch (e) {
          console.error('Firestoreトークン削除失敗:', e);
          addToast(`クリーンアップに失敗しました [${NOTIFY_ERROR_CODES.TOKEN_DB_DELETE}]`, 'warning');
        }
        addToast('通知をオフにしました');
      }
    } finally {
      setNotifyToggling(false);
    }
  };

  const handleNotifyBefore = async (value: number) => {
    const next = { ...data, notifyBefore: value };
    setData(next);
    save({ notifyBefore: value, periods: data.periods });
    if (notifyEnabled && currentUser && currentTokenRef.current) {
      try {
        const ref = doc(db, firestorePaths.pushTokenDoc(currentUser.uid, currentTokenRef.current));
        await setDoc(ref, { notifyBefore: value }, { merge: true });
      } catch (e) {
        console.error('通知タイミング更新失敗:', e);
        addToast(`通知タイミングの同期に失敗しました [${NOTIFY_ERROR_CODES.NOTIFY_BEFORE_UPDATE}]`, 'warning');
      }
    }
  };

  const startEditPeriods = () => {
    setEditingPeriods(data.periods.map(p => ({ ...p })));
    setPeriodsError('');
  };

  const cancelEditPeriods = () => {
    setEditingPeriods(null);
    setPeriodsError('');
  };

  const updatePeriod = (i: number, patch: Partial<Period>) => {
    if (!editingPeriods) return;
    setEditingPeriods(editingPeriods.map((p, idx) => idx === i ? { ...p, ...patch } : p));
  };

  const addPeriod = () => {
    if (!editingPeriods) return;
    const last = editingPeriods[editingPeriods.length - 1];
    const start = last ? addMin(last.end, 0) : '09:00';
    const end = last ? addMin(last.end, 60) : '10:30';
    setEditingPeriods([...editingPeriods, { label: `${editingPeriods.length + 1}限`, start, end }]);
  };

  const removePeriod = (i: number) => {
    if (!editingPeriods) return;
    setEditingPeriods(editingPeriods.filter((_, idx) => idx !== i));
  };

  const savePeriods = () => {
    if (!editingPeriods) return;
    if (editingPeriods.length === 0) { setPeriodsError('時限を1つ以上追加してください'); return; }
    for (const p of editingPeriods) {
      if (!p.label.trim()) { setPeriodsError('時限名を入力してください'); return; }
      if (!p.start || !p.end) { setPeriodsError('開始・終了時刻を入力してください'); return; }
      if (p.start >= p.end) { setPeriodsError('開始時刻は終了時刻より前にしてください'); return; }
    }
    for (let i = 0; i < editingPeriods.length; i++) {
      for (let j = i + 1; j < editingPeriods.length; j++) {
        const a = editingPeriods[i], b = editingPeriods[j];
        if (a.start < b.end && a.end > b.start) {
          setPeriodsError(`「${a.label}」と「${b.label}」の時間が重複しています`);
          return;
        }
      }
    }
    setPeriodsError('');
    const next = { ...data, periods: editingPeriods };
    setData(next);
    save({ notifyBefore: data.notifyBefore, periods: editingPeriods });
    setEditingPeriods(null);
    addToast('時限設定を保存しました');
  };

  if (loading) return <p style={{ fontSize: 13, color: 'var(--app-text-secondary)' }}>読み込み中...</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* 通知 ON/OFF */}
      <div className="app-settings-row">
        <span className="app-settings-row-label">通知</span>
        <label
          className="app-switch"
          style={{ opacity: notifyToggling ? 0.4 : 1, cursor: notifyToggling ? 'not-allowed' : 'pointer' }}
        >
          <input type="checkbox" checked={notifyEnabled} onChange={notifyToggling ? () => {} : toggleNotify} disabled={notifyToggling} />
          <span className="app-switch-track">
            <span className="app-switch-thumb" />
          </span>
        </label>
      </div>

      {/* 通知タイミング */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--app-text)', marginBottom: 10 }}>
          通知タイミング
        </div>
        <div className="app-settings-btn-group">
          {NOTIFY_OPTIONS.map(o => (
            <button
              key={o.value}
              onClick={() => handleNotifyBefore(o.value)}
              style={{
                padding: '7px 0',
                borderRadius: 8,
                border: '1px solid var(--app-border-input)',
                background: data.notifyBefore === o.value ? 'var(--app-text-primary)' : 'transparent',
                color: data.notifyBefore === o.value ? 'var(--app-bg)' : 'var(--app-text-secondary)',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s',
                width: '100%',
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: 'var(--app-text-secondary)', marginTop: 8 }}>
          授業開始の何分前に通知するかを設定します。
        </p>
      </div>

      {/* 時限設定 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--app-text-secondary)' }}>時限設定</span>
          {!editingPeriods && (
            <Button variant="outline" size="sm" onClick={startEditPeriods}>編集</Button>
          )}
        </div>

        {editingPeriods ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {periodsError && (
              <div style={{ color: '#ef4444', fontSize: 12, fontWeight: 600 }}>{periodsError}</div>
            )}
            {editingPeriods.map((p, i) => (
              <div key={i} style={{ background: 'var(--app-bg-subtle, var(--app-border))', border: '1px solid var(--app-border)', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--app-text-secondary)', fontWeight: 700, minWidth: 20 }}>#{i + 1}</span>
                  <input
                    value={p.label}
                    onChange={e => updatePeriod(i, { label: e.target.value })}
                    placeholder="例: 1限"
                    style={{ flex: 1, background: 'var(--app-bg-card)', border: '1px solid var(--app-border)', borderRadius: 7, padding: '7px 10px', fontSize: 16, fontWeight: 700, outline: 'none', color: 'var(--app-text)' }}
                  />
                  <Button variant="destructive" size="sm" onClick={() => removePeriod(i)}>削除</Button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, color: 'var(--app-text-secondary)' }}>開始</span>
                  <input type="time" value={p.start} onChange={e => updatePeriod(i, { start: e.target.value })}
                    style={{ flex: 1, background: 'var(--app-bg-card)', border: '1px solid var(--app-border)', borderRadius: 7, padding: '7px 8px', fontSize: 16, outline: 'none', color: 'var(--app-text)' }} />
                  <span style={{ fontSize: 11, color: 'var(--app-text-secondary)' }}>〜</span>
                  <span style={{ fontSize: 11, color: 'var(--app-text-secondary)' }}>終了</span>
                  <input type="time" value={p.end} onChange={e => updatePeriod(i, { end: e.target.value })}
                    style={{ flex: 1, background: 'var(--app-bg-card)', border: '1px solid var(--app-border)', borderRadius: 7, padding: '7px 8px', fontSize: 16, outline: 'none', color: 'var(--app-text)' }} />
                </div>
              </div>
            ))}
            <Button variant="outline" className="w-full border-dashed" onClick={addPeriod}>＋ 時限を追加</Button>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <Button variant="outline" className="flex-1" onClick={cancelEditPeriods}>キャンセル</Button>
              <Button variant="default" className="flex-[2]" onClick={savePeriods}>保存</Button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {data.periods.map((p, i) => (
              <div key={i} className="app-settings-profile-row" style={{ fontSize: 13 }}>
                <span className="app-settings-profile-label">{p.label}</span>
                <span style={{ color: 'var(--app-text-secondary)' }}>{p.start} 〜 {p.end}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
