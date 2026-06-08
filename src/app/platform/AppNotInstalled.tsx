import { Link } from 'react-router-dom';

export const AppNotInstalled = () => (
  <div style={{
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '60vh',
    gap: 16,
    padding: '32px 24px',
    textAlign: 'center',
  }}>
    <span style={{ fontSize: 48 }}>🛍️</span>
    <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--app-text-primary)', margin: 0 }}>
      このアプリは導入されていません
    </h1>
    <p style={{ fontSize: 14, color: 'var(--app-text-secondary)', margin: 0 }}>
      マーケットプレイスから導入すると利用できます。
    </p>
    <Link
      to="/marketplace"
      style={{
        display: 'inline-block',
        marginTop: 8,
        padding: '10px 20px',
        borderRadius: 8,
        background: 'var(--app-text-primary)',
        color: 'var(--app-bg)',
        fontWeight: 700,
        fontSize: 14,
        textDecoration: 'none',
      }}
    >
      マーケットプレイスへ
    </Link>
  </div>
);
