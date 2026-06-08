import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { Forbidden } from '../shared/NotFound';
import { useInstalledApps } from '../platform/InstalledAppsContext';
import { AppNotInstalled } from '../platform/AppNotInstalled';

type Props = {
  children: ReactNode;
  /** APP_REGISTRY の id。省略時はインストールチェックをスキップ（Shell ページ用） */
  appId?: string;
};

export const ProtectedRoute = ({ children, appId }: Props) => {
  const { currentUser, username, loading } = useAuth();
  const { isInstalled, loading: appsLoading } = useInstalledApps();

  if (loading || appsLoading) return null;
  if (!currentUser) return <Forbidden />;

  // App ルートで未導入の場合は AppNotInstalled を表示（ロード完了後のみ判定）
  if (appId !== undefined && !isInstalled(appId)) {
    return <AppNotInstalled />;
  }

  return (
    <>
      {username === null && (
        <div className="app-username-banner">
          ユーザー名が設定されていません。
          <Link to="/settings" className="app-username-banner-link">設定ページ</Link>
          から登録してください。
        </div>
      )}
      {children}
    </>
  );
};
