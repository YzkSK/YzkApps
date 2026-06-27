import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../shared/firebase';
import { useAuth } from '../auth/AuthContext';
import { useSetLoading } from '../shared/AppLoadingContext';
import { useToast } from '../shared/useToast';
import '../shared/app.css';
import {
  APP_REGISTRY,
  SHELL_REGISTRY,
  migrateInstalledApps,
  type AppMeta,
  type ShellMeta,
} from './registry';

const ERROR_CODES = {
  INSTALL_SAVE:       'E031',
  UNINSTALL_CLEANUP:  'E032',
  UNINSTALL_SAVE:     'E033',
} as const;

type MenuSections = {
  top: ShellMeta[];
  apps: AppMeta[];
  bottom: ShellMeta[];
};

type InstalledAppsContextValue = {
  installedIds: Set<string>;
  loading: boolean;
  install: (id: string) => Promise<void>;
  uninstall: (id: string, opts: { deleteData: boolean }) => Promise<void>;
  isInstalled: (id: string) => boolean;
  dashboardApps: AppMeta[];
  menuSections: MenuSections;
};

const InstalledAppsContext = createContext<InstalledAppsContextValue | null>(null);

export const useInstalledApps = () => {
  const ctx = useContext(InstalledAppsContext);
  if (!ctx) throw new Error('useInstalledApps must be used within InstalledAppsProvider');
  return ctx;
};

export const InstalledAppsProvider = ({ children }: { children: ReactNode }) => {
  const { currentUser } = useAuth();
  const setLoading = useSetLoading();
  const { toasts, addToast } = useToast();
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set());
  const [loading, setLocalLoading] = useState(true);

  useEffect(() => {
    if (!currentUser) {
      setInstalledIds(new Set());
      setLocalLoading(false);
      setLoading('installedApps', false);
      return;
    }

    let isMounted = true;
    const uid = currentUser.uid;
    setLoading('installedApps', true);
    setLocalLoading(true);

    (async () => {
      try {
        const snap = await getDoc(doc(db, `users/${uid}/profile/data`));
        const raw = snap.exists() ? snap.data() : null;

        let installed: string[];
        if (raw && Array.isArray(raw.installedApps)) {
          installed = (raw.installedApps as unknown[]).filter((x): x is string => typeof x === 'string');
        } else {
          installed = await migrateInstalledApps(uid);
        }

        localStorage.setItem(`installed-apps-${uid}`, JSON.stringify(installed));
        if (isMounted) setInstalledIds(new Set(installed));
      } catch (e) {
        console.error('[InstalledAppsContext] failed to load installedApps', e);
        if (isMounted) {
          const cached = localStorage.getItem(`installed-apps-${uid}`);
          if (cached) {
            try { setInstalledIds(new Set(JSON.parse(cached) as string[])); } catch { /* ignore */ }
          }
        }
      } finally {
        if (isMounted) {
          setLoading('installedApps', false);
          setLocalLoading(false);
        }
      }
    })();

    return () => { isMounted = false; };
  }, [currentUser, setLoading]);

  const saveInstalledIds = async (uid: string, ids: Set<string>) => {
    await setDoc(
      doc(db, `users/${uid}/profile/data`),
      { installedApps: [...ids] },
      { merge: true }
    );
  };

  const install = async (id: string) => {
    if (!currentUser) return;
    const prev = installedIds;
    const next = new Set(installedIds);
    next.add(id);
    setInstalledIds(next);
    try {
      await saveInstalledIds(currentUser.uid, next);
      localStorage.setItem(`installed-apps-${currentUser.uid}`, JSON.stringify([...next]));
    } catch (e) {
      console.error('[InstalledAppsContext] failed to save install', e);
      setInstalledIds(prev);
      addToast(`導入の保存に失敗しました [${ERROR_CODES.INSTALL_SAVE}]`, 'error');
    }
  };

  const uninstall = async (id: string, opts: { deleteData: boolean }) => {
    if (!currentUser) return;
    const app = APP_REGISTRY.find(a => a.id === id);

    // onUninstall が失敗してもアンインストール自体は続行（データ削除は部分的に成功している可能性）
    if (app?.onUninstall) {
      try {
        await app.onUninstall({ deleteData: opts.deleteData, uid: currentUser.uid });
      } catch (e) {
        console.error('[InstalledAppsContext] onUninstall failed', e);
        addToast(`クリーンアップに失敗しました [${ERROR_CODES.UNINSTALL_CLEANUP}]`, 'warning');
      }
    }

    const next = new Set(installedIds);
    next.delete(id);
    setInstalledIds(next);

    // Firestore 保存失敗時も UI はアンインストール済みのまま維持
    // （onUninstall でデータが削除済みの可能性があるためロールバックしない）
    try {
      await saveInstalledIds(currentUser.uid, next);
      localStorage.setItem(`installed-apps-${currentUser.uid}`, JSON.stringify([...next]));
    } catch (e) {
      console.error('[InstalledAppsContext] failed to save uninstall', e);
      addToast(`アンインストールの保存に失敗しました [${ERROR_CODES.UNINSTALL_SAVE}]`, 'error');
    }
  };

  const isInstalled = (id: string) => installedIds.has(id);
  const dashboardApps = APP_REGISTRY.filter(a => installedIds.has(a.id));
  const menuSections: MenuSections = {
    top: SHELL_REGISTRY.filter(s => s.menuPosition === 'top'),
    apps: APP_REGISTRY.filter(a => installedIds.has(a.id)),
    bottom: SHELL_REGISTRY.filter(s => s.menuPosition === 'bottom'),
  };

  return (
    <InstalledAppsContext.Provider
      value={{ installedIds, loading, install, uninstall, isInstalled, dashboardApps, menuSections }}
    >
      {children}
      {toasts.length > 0 && (
        <div className="app-toast-container">
          {toasts.map(t => (
            <div key={t.id} className={`app-toast app-toast--${t.type}`}>{t.msg}</div>
          ))}
        </div>
      )}
    </InstalledAppsContext.Provider>
  );
};
