import { useState, useEffect, useRef } from 'react';
import { useToast } from '../shared/useToast';
import { doc, getDoc } from 'firebase/firestore';
import { getToken, onMessage } from 'firebase/messaging';
import { auth, db, messaging } from '../shared/firebase';
import { useAuth } from '../auth/AuthContext';
import { useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import '../shared/app.css';
import './timetable.css';
import {
  DEFAULT_PERIODS, DAY_LABELS,
  MS_PER_MINUTE, TOAST_DURATION_MS,
  toKey, addDays, startOfWeek, timeToMin, isEventModal, firestorePaths,
  type TimetableEvent, type Period, type Events, type Modal, type Form,
} from './constants';
import { useFirestoreData } from '../shared/useFirestoreData';
import { useFirestoreSave } from '../shared/useFirestoreSave';
import { MonthView } from './views/MonthView';
import { WeekView } from './views/WeekView';
import { DayView } from './views/DayView';
import { EventModal } from './modals/EventModal';
import { usePageTitle } from '../shared/usePageTitle';
import { AppLayout } from '../platform/AppLayout';
import { Button } from '@/components/ui/button';

export const Timetable = () => {
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  usePageTitle('時間割');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = toKey(today);

  const [view, setView] = useState<'month' | 'week' | 'day'>('week');
  const [cursor, setCursor] = useState(new Date(today));
  const [modal, setModal] = useState<Modal>(null);
  const [form, setForm] = useState<Form>({ name: '', room: '', note: '', colorIdx: 0 });
  const [formError, setFormError] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [notifyEnabled] = useState(() => {
    const saved = localStorage.getItem('notifyEnabled') === 'true';
    const perm = typeof Notification !== 'undefined' ? Notification.permission : 'default';
    return saved && perm === 'granted';
  });
  const [permission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );
  const { toasts, addToast } = useToast(TOAST_DURATION_MS);
  const [nextNotify, setNextNotify] = useState<{
    label: string; name: string; start: string; notifyAt: string; pushReady: boolean;
  } | null>(null);
  const scheduledRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const currentTokenRef = useRef<string>('');

  // ── Firestore 保存（デバウンス） ────────────────────────
  type TimetableData = { events: Events; periods: Period[]; notifyBefore: number };
  const saveToFirestore = useFirestoreSave<TimetableData>({
    currentUser,
    path: firestorePaths.timetableData(currentUser?.uid ?? ''),
  });
  const { data: ttData, setData: setTtData, loading, dbError } = useFirestoreData<TimetableData>({
    currentUser,
    path: firestorePaths.timetableData(currentUser?.uid ?? ''),
    parse: (raw) => {
      const parsedEvents: Events = {};
      if (raw.events && typeof raw.events === 'object') {
        for (const [key, evs] of Object.entries(raw.events as Record<string, unknown>)) {
          parsedEvents[key] = (evs as Record<string, unknown>[]).map(ev => ({
            periodIndex: (ev.periodIndex ?? ev.pi) as number,
            eventId: (ev.eventId ?? ev._idx) as number,
            name: ev.name as string,
            room: (ev.room ?? '') as string,
            note: (ev.note ?? '') as string,
            colorIdx: (ev.colorIdx ?? 0) as number,
          }));
        }
      }
      const periodsRaw = raw.periods;
      const parsedPeriods: Period[] =
        Array.isArray(periodsRaw) && periodsRaw.length > 0 ? (periodsRaw as Period[]) : DEFAULT_PERIODS;
      const notifyBeforeVal = typeof raw.notifyBefore === 'number' ? raw.notifyBefore : 10;
      return { events: parsedEvents, periods: parsedPeriods, notifyBefore: notifyBeforeVal };
    },
    loadingKey: 'timetable',
    initialData: { events: {}, periods: DEFAULT_PERIODS, notifyBefore: 10 },
  });
  const events = ttData.events;
  const periods = ttData.periods;
  const notifyBefore = ttData.notifyBefore;
  const setEvents = (updater: Events | ((prev: Events) => Events)) => {
    setTtData(prev => ({
      ...prev,
      events: typeof updater === 'function' ? updater(prev.events) : updater,
    }));
  };

  // ── Service Worker 登録 ─────────────────────────────────
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const params = new URLSearchParams({
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    });
    navigator.serviceWorker.register(`/firebase-messaging-sw.js?${params}`).then(async (sw) => {
      if (notifyEnabled) {
        try {
          const token = await getToken(messaging, {
            vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
            serviceWorkerRegistration: sw,
          });
          currentTokenRef.current = token;
        } catch { /* トークン取得失敗は無視 */ }
      }
    }).catch(console.error);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── フォアグラウンド通知受信（通知設定は Settings の TimetableSettings で管理） ──

  useEffect(() => {
    const unsub = onMessage(messaging, (payload) => {
      const title = payload.data?.title ?? payload.notification?.title ?? '時間割';
      const body = payload.data?.body ?? payload.notification?.body ?? '';
      if (permission === 'granted') {
        navigator.serviceWorker.ready.then(reg => {
          reg.showNotification(title, { body });
        }).catch((e) => { console.error('フォアグラウンド通知表示失敗:', e); /* フォアグラウンド通知表示失敗は無視（通知機能に影響しない） */ });
      }
    });
    return unsub;
  }, [permission]);

  // ── 次の通知予定を計算（SWのpush subscriptionで配信可否も確認） ──
  useEffect(() => {
    if (!notifyEnabled || permission !== 'granted') {
      setNextNotify(null);
      return;
    }
    const compute = async () => {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const key = toKey(now);
      const sorted = [...(events[key] ?? [])].sort((a, b) => {
        const pA = periods[a.periodIndex];
        const pB = periods[b.periodIndex];
        return (pA ? timeToMin(pA.start) : 0) - (pB ? timeToMin(pB.start) : 0);
      });

      // 次に通知されるイベントを探す
      let found: typeof nextNotify = null;
      for (const ev of sorted) {
        const p = periods[ev.periodIndex];
        if (!p) continue;
        const notifyAtMin = timeToMin(p.start) - notifyBefore;
        if (notifyAtMin > nowMin) {
          const hh = String(Math.floor(notifyAtMin / 60)).padStart(2, '0');
          const mm = String(notifyAtMin % 60).padStart(2, '0');

          // 表示されたイベントに対してSWがプッシュ通知を送れるか確認
          let pushReady = false;
          try {
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.getSubscription();
            if (sub !== null && currentUser && currentTokenRef.current) {
              const snap = await getDoc(doc(db, firestorePaths.pushTokenDoc(currentUser.uid, currentTokenRef.current)));
              pushReady = snap.exists();
            }
          } catch { /* SW未対応環境 */ }

          found = { label: p.label, name: ev.name, start: p.start, notifyAt: `${hh}:${mm}`, pushReady };
          break;
        }
      }
      setNextNotify(found);
    };
    compute();
    const id = setInterval(compute, 60_000);
    return () => clearInterval(id);
  }, [notifyEnabled, permission, events, periods, notifyBefore, currentUser]);

  useEffect(() => {
    Object.values(scheduledRef.current).forEach(clearTimeout);
    scheduledRef.current = {};
    if (!notifyEnabled || permission !== 'granted') return;
    const todayEvents = events[todayKey] || [];
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    todayEvents.forEach((ev, idx) => {
      const p = periods[ev.periodIndex];
      if (!p) return;
      const diffMs = (timeToMin(p.start) - notifyBefore - nowMin) * MS_PER_MINUTE - now.getSeconds() * 1000;
      if (diffMs <= 0) return;
      scheduledRef.current[`today-${idx}`] = setTimeout(() => {
        addToast(`🔔 ${p.label}「${ev.name}」まであと${notifyBefore}分`);
      }, diffMs);
    });
    return () => {
      Object.values(scheduledRef.current).forEach(clearTimeout);
      scheduledRef.current = {};
    };
  }, [notifyEnabled, notifyBefore, events, periods, permission]);

  // ── イベント操作 ─────────────────────────────────────────
  const openAdd = (dateKey: string, periodIndex: number) => {
    setIsEditing(false);
    setFormError('');
    setForm({ name: '', room: '', note: '', colorIdx: 0 });
    setModal({ type: 'event', dateKey, periodIndex });
  };

  const openEdit = (dateKey: string, periodIndex: number, eventId: number) => {
    const ev = (events[dateKey] || []).find(e => e.periodIndex === periodIndex && e.eventId === eventId);
    if (!ev) return;
    setIsEditing(true);
    setFormError('');
    setForm({ name: ev.name, room: ev.room || '', note: ev.note || '', colorIdx: ev.colorIdx ?? 0 });
    setModal({ type: 'event', dateKey, periodIndex, eventId });
  };

  const saveEvent = () => {
    if (!form.name.trim()) { setFormError('科目名を入力してください'); return; }
    setFormError('');
    if (!isEventModal(modal)) return;
    const { dateKey, periodIndex, eventId } = modal;
    setEvents(prev => {
      const base = prev[dateKey] || [];
      const filtered = isEditing
        ? base.filter(e => !(e.periodIndex === periodIndex && e.eventId === eventId))
        : base.filter(e => e.periodIndex !== periodIndex);
      const newEv: TimetableEvent = {
        periodIndex, name: form.name.trim(), room: form.room.trim(),
        note: form.note.trim(), colorIdx: form.colorIdx, eventId: Date.now() + Math.random(),
      };
      const next = { ...prev, [dateKey]: [...filtered, newEv].sort((a, b) => a.periodIndex - b.periodIndex) };
      saveToFirestore({ events: next, periods, notifyBefore });
      return next;
    });
    setModal(null);
  };

  const deleteEvent = () => {
    if (!isEventModal(modal)) return;
    const { dateKey, periodIndex, eventId } = modal;
    setEvents(prev => {
      const next = {
        ...prev,
        [dateKey]: (prev[dateKey] || []).filter(e => !(e.periodIndex === periodIndex && e.eventId === eventId)),
      };
      saveToFirestore({ events: next, periods, notifyBefore });
      return next;
    });
    setModal(null);
  };

  // ── ナビゲーション ───────────────────────────────────────
  const moveCursor = (dir: number) => {
    const d = new Date(cursor);
    if (view === 'month') d.setMonth(d.getMonth() + dir);
    else if (view === 'week') d.setDate(d.getDate() + dir * 7);
    else d.setDate(d.getDate() + dir);
    setCursor(d);
  };

  const getTitle = () => {
    if (view === 'month') return `${cursor.getFullYear()}年 ${cursor.getMonth() + 1}月`;
    if (view === 'week') {
      const ws = startOfWeek(cursor);
      const we = addDays(ws, 6);
      return `${ws.getMonth() + 1}/${ws.getDate()} 〜 ${we.getMonth() + 1}/${we.getDate()}`;
    }
    return `${cursor.getMonth() + 1}月${cursor.getDate()}日（${DAY_LABELS[cursor.getDay()]}）`;
  };

  if (loading) return null;

  return (
    <AppLayout
      pageClassName="tt-page"
      className="tt-main"
      title="時間割"
      headerActions={
        <Button variant="outline" className="tt-header-logout" onClick={async () => { await signOut(auth); navigate('/login'); }}>ログアウト</Button>
      }
      dbError={dbError}
      toasts={toasts}
    >
      <div className="tt-inner">
        {/* 次の通知予定 */}
        {notifyEnabled && nextNotify && (
          <div className="tt-next-notify">
            <div className="tt-next-notify-row">
              <span className="tt-next-notify-bell">🔔</span>
              <span className="tt-next-notify-body">
                次の予定: {nextNotify.label}「{nextNotify.name}」{nextNotify.start}〜
              </span>
              <span className="tt-next-notify-time">{nextNotify.notifyAt}に通知</span>
            </div>
            {!nextNotify.pushReady && (
              <div className="tt-push-warn">⚠️ プッシュ未登録</div>
            )}
          </div>
        )}

        {/* ビュー切り替えタブ */}
        <div className="tt-view-tabs">
          {([['month', '月'], ['week', '週'], ['day', '日']] as const).map(([v, l]) => (
            <button key={v} onClick={() => setView(v)}
              className={`tt-view-tab${view === v ? ' tt-view-tab--active' : ''}`}>
              {l}
            </button>
          ))}
        </div>

        {/* ナビゲーション */}
        <div className="tt-nav">
          <button onClick={() => moveCursor(-1)} className="tt-nav-btn">&lt;</button>
          <span className="tt-nav-title">{getTitle()}</span>
          <button onClick={() => moveCursor(1)} className="tt-nav-btn">&gt;</button>
          <Button variant="outline" onClick={() => setCursor(new Date(today))} style={{ marginLeft: 4 }}>今日</Button>
        </div>

        {/* ビュー本体 */}
        {view === 'month' && (
          <MonthView cursor={cursor} events={events} periods={periods} todayKey={todayKey}
            onDayClick={date => { setCursor(new Date(date)); setView('day'); }} />
        )}
        {view === 'week' && (
          <WeekView cursor={cursor} events={events} periods={periods} todayKey={todayKey}
            onDayClick={date => { setCursor(new Date(date)); setView('day'); }}
            onAdd={openAdd} onEdit={openEdit} />
        )}
        {view === 'day' && (
          <DayView cursor={cursor} events={events} periods={periods} todayKey={todayKey}
            onAdd={openAdd} onEdit={openEdit} />
        )}
      </div>

      {/* イベントモーダル */}
      {isEventModal(modal) && (
        <EventModal
          modal={modal}
          periods={periods}
          form={form}
          formError={formError}
          isEditing={isEditing}
          onFormChange={setForm}
          onFormErrorChange={setFormError}
          onSave={saveEvent}
          onDelete={deleteEvent}
          onClose={() => setModal(null)}
        />
      )}

      <style>{`@keyframes fadeUp { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }`}</style>
    </AppLayout>
  );
};
