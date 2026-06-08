import { signOut } from 'firebase/auth';
import { useNavigate, Link } from 'react-router-dom';
import { User } from 'lucide-react';
import { auth } from '../shared/firebase';
import { usePageTitle } from '../shared/usePageTitle';
import { useInstalledApps } from '../platform/InstalledAppsContext';
import { AppLayout } from '../platform/AppLayout';
import { Button } from '@/components/ui/button';

export const Dashboard = () => {
  const navigate = useNavigate();
  usePageTitle('ホーム');
  const { dashboardApps } = useInstalledApps();

  const handleLogout = async () => {
    await signOut(auth);
    navigate('/login');
  };

  return (
    <AppLayout
      pageClassName="app-dashboard"
      title="ホーム"
      headerActions={
        <div className="app-user-info">
          <Link to="/settings" className="app-avatar-btn" aria-label="設定">
            <User size={18} />
          </Link>
          <Button variant="outline" onClick={handleLogout}>ログアウト</Button>
        </div>
      }
    >
      {dashboardApps.length === 0 ? (
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--app-text-secondary)', fontSize: 14 }}>
          <p style={{ marginBottom: 12 }}>導入済みのアプリがありません。</p>
          <Link to="/marketplace" style={{ color: 'var(--app-text-primary)', fontWeight: 700 }}>
            アプリ一覧から追加する →
          </Link>
        </div>
      ) : (
        <div className="app-grid">
          {dashboardApps.map(app => (
            <Link key={app.id} to={`/${app.route.path}`} className="app-card">
              <div className="app-card-label">{app.label}</div>
              <div className="app-card-desc">{app.description}</div>
            </Link>
          ))}
          <Link to="/marketplace" className="app-card app-card--add">
            <div className="app-card-add-icon">＋</div>
            <div className="app-card-label">アプリを追加</div>
          </Link>
        </div>
      )}
    </AppLayout>
  );
};
