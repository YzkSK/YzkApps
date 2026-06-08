import { Suspense } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import '../shared/app.css';
import { useAuth } from '../auth/AuthContext';
import { useTheme } from '../shared/ThemeContext';
import { usePageTitle } from '../shared/usePageTitle';
import { useToast } from '../shared/useToast';
import { AppLayout } from '../platform/AppLayout';
import { APP_REGISTRY } from '../platform/registry';
import { useInstalledApps } from '../platform/InstalledAppsContext';

export const Settings = () => {
  const { currentUser, username } = useAuth();
  const { darkMode, toggleDarkMode } = useTheme();
  const navigate = useNavigate();
  usePageTitle('設定');
  const { isInstalled } = useInstalledApps();
  const appsWithSettings = APP_REGISTRY.filter(a => isInstalled(a.id) && a.SettingsSection);
  const { toasts, addToast } = useToast();

  return (
    <AppLayout
      pageClassName="app-settings"
      className="app-settings-body"
      title="設定"
      headerActions={
        <button onClick={() => navigate('/dashboard')} className="app-logout-btn">戻る</button>
      }
      toasts={toasts}
    >
      <div className="app-settings-layout">

        {/* ── サイドバー（PC のみ表示） ── */}
        <nav className="app-settings-sidebar">
          <a href="#settings-profile" className="app-settings-nav-item">
            <span>👤</span>プロフィール
          </a>
          <a href="#settings-appearance" className="app-settings-nav-item">
            <span>🎨</span>外観
          </a>
          {appsWithSettings.map(app => (
            <a key={app.id} href={`#settings-${app.id}`} className="app-settings-nav-item">
              <span>{app.icon}</span>{app.label}
            </a>
          ))}
        </nav>

        {/* ── コンテンツエリア ── */}
        <div className="app-settings-content">

          <section id="settings-profile" className="app-settings-section">
            <h3 className="app-settings-section-title">プロフィール</h3>
            <div className="app-settings-profile">
              <div className="app-settings-profile-row">
                <span className="app-settings-profile-label">ユーザー名</span>
                <span className="app-settings-profile-value">{username ?? '未設定'}</span>
              </div>
              <div className="app-settings-profile-row">
                <span className="app-settings-profile-label">メールアドレス</span>
                <span className="app-settings-profile-value">{currentUser?.email}</span>
              </div>
            </div>
            <Link to="/settings/edit" className="app-settings-edit-link">
              ユーザー情報を変更
              <span className="app-settings-edit-arrow">›</span>
            </Link>
          </section>

          <section id="settings-appearance" className="app-settings-section">
            <h3 className="app-settings-section-title">外観</h3>
            <div className="app-settings-row">
              <span className="app-settings-row-label">ダークモード</span>
              <label className="app-switch">
                <input
                  type="checkbox"
                  checked={darkMode}
                  onChange={toggleDarkMode}
                />
                <span className="app-switch-track">
                  <span className="app-switch-thumb" />
                </span>
              </label>
            </div>
          </section>

          {appsWithSettings.map(app => {
            const Section = app.SettingsSection!;
            return (
              <section key={app.id} id={`settings-${app.id}`} className="app-settings-section">
                <h3 className="app-settings-section-title">
                  <span style={{ marginRight: 6 }}>{app.icon}</span>{app.label}
                </h3>
                <Suspense fallback={
                  <p style={{ fontSize: 13, color: 'var(--app-text-secondary)' }}>読み込み中...</p>
                }>
                  <Section addToast={addToast} />
                </Suspense>
              </section>
            );
          })}

        </div>
      </div>
    </AppLayout>
  );
};
