import { signOut } from 'firebase/auth';
import { useNavigate, Link } from 'react-router-dom';
import { User } from 'lucide-react';
import '../shared/app.css';
import { auth } from '../shared/firebase';
import { AppFooter } from '../shared/AppFooter';
import { usePageTitle } from '../shared/usePageTitle';
import { Button } from '@/components/ui/button';


const APPS = [
  { to: '/timetable',    label: '時間割', description: '授業・時間割の管理' },
  { to: '/quiz',         label: '問題集', description: '問題登録・ランダム出題' },
  { to: '/videocollect', label: '動画',   description: 'Google Drive 動画の管理・再生' },
];

export const Dashboard = () => {
  const navigate = useNavigate();
  usePageTitle('ホーム');

  const handleLogout = async () => {
    await signOut(auth);
    navigate('/login');
  };

  return (
    <div className="app-dashboard">
      <header className="app-header">
        <h1>ホーム</h1>
        <div className="app-user-info">
          <Link to="/settings" className="app-avatar-btn" aria-label="設定">
            <User size={18} />
          </Link>
          <Button variant="outline" onClick={handleLogout}>ログアウト</Button>
        </div>
      </header>
      <main className="app-main">
        <div className="app-grid">
          {APPS.map(app => (
            <Link key={app.to} to={app.to} className="app-card">
              <div className="app-card-label">{app.label}</div>
              <div className="app-card-desc">{app.description}</div>
            </Link>
          ))}
        </div>
      </main>
      <AppFooter />
    </div>
  );
};
