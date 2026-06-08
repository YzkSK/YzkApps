import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useInstalledApps } from '../platform/InstalledAppsContext';

const DIVIDER = (
  <hr style={{ border: 'none', borderTop: '1px solid var(--app-border)', margin: '6px 10px' }} />
);

const menuItemStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '11px 14px',
  borderRadius: 10,
  textDecoration: 'none',
  fontSize: 14,
  fontWeight: active ? 800 : 600,
  color: active ? 'var(--app-text-primary)' : 'var(--app-text-secondary)',
  background: active ? 'var(--app-border)' : 'transparent',
  transition: 'background 0.15s',
});

export const AppMenu = () => {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const { menuSections } = useInstalledApps();

  const isActive = (path: string) =>
    pathname === `/${path}` ||
    (path !== 'dashboard' && pathname.startsWith(`/${path}`));

  const renderLink = (id: string, path: string, icon: string, label: string) => {
    const active = isActive(path);
    return (
      <Link
        key={id}
        to={`/${path}`}
        onClick={() => setOpen(false)}
        style={menuItemStyle(active)}
      >
        <span style={{ fontSize: 16 }}>{icon}</span>
        {label}
      </Link>
    );
  };

  const hasApps = menuSections.apps.length > 0;

  return (
    <>
      {/* ハンバーガーボタン */}
      <button
        onClick={() => setOpen(true)}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '6px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          flexShrink: 0,
        }}
        aria-label="メニューを開く"
      >
        <span style={{ display: 'block', width: 20, height: 2, background: 'var(--app-text)', borderRadius: 2 }} />
        <span style={{ display: 'block', width: 20, height: 2, background: 'var(--app-text)', borderRadius: 2 }} />
        <span style={{ display: 'block', width: 20, height: 2, background: 'var(--app-text)', borderRadius: 2 }} />
      </button>

      {/* オーバーレイ */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 400,
            background: 'rgba(0,0,0,0.45)',
          }}
        />
      )}

      {/* ドロワー */}
      <div style={{
        position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 401,
        width: 220,
        background: 'var(--app-bg-card)',
        borderRight: '1px solid var(--app-border)',
        transform: open ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 0.22s ease',
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 56,
      }}>
        {/* 閉じるボタン */}
        <button
          onClick={() => setOpen(false)}
          style={{
            position: 'absolute', top: 14, right: 14,
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 20, color: 'var(--app-text-secondary)', lineHeight: 1,
            padding: 4,
          }}
          aria-label="閉じる"
        >✕</button>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 10px' }}>
          {/* Shell (top): ホーム */}
          {menuSections.top.map(s => renderLink(s.id, s.route.path, s.icon, s.label))}

          {/* インストール済みアプリ */}
          {hasApps && DIVIDER}
          {menuSections.apps.map(a => renderLink(a.id, a.route.path, a.icon, a.label))}

          {/* Shell (bottom): アプリ一覧・設定 */}
          {DIVIDER}
          {menuSections.bottom.map(s => renderLink(s.id, s.route.path, s.icon, s.label))}
        </nav>
      </div>
    </>
  );
};
