// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '@/app/auth/AuthContext';
import { AppLoadingProvider } from '@/app/shared/AppLoadingContext';

// vi.mock はホイストされるため、参照する変数も vi.hoisted で先に作る
const { mockOnAuthStateChanged, mockDoc, mockGetDoc } = vi.hoisted(() => ({
  mockOnAuthStateChanged: vi.fn(),
  mockDoc: vi.fn(),
  mockGetDoc: vi.fn(),
}));

vi.mock('@/app/shared/firebase', () => ({ auth: {}, db: {} }));
vi.mock('firebase/auth', () => ({ onAuthStateChanged: mockOnAuthStateChanged }));
vi.mock('firebase/firestore', () => ({
  doc: mockDoc,
  getDoc: mockGetDoc,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// useAuth の値を画面に出すテスト用コンポーネント
const AuthDisplay = () => {
  const { currentUser, username, loading } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="uid">{currentUser?.uid ?? 'null'}</span>
      <span data-testid="username">
        {username === undefined ? 'undefined' : username === null ? 'null' : username}
      </span>
    </div>
  );
};

const renderAuth = () =>
  render(
    <AppLoadingProvider initialKeys={['auth']}>
      <AuthProvider>
        <AuthDisplay />
      </AuthProvider>
    </AppLoadingProvider>,
  );

describe('AuthContext (結合テスト)', () => {
  it('ユーザーなし → loading=false, username=null', async () => {
    mockOnAuthStateChanged.mockImplementation((_: unknown, cb: (u: null) => void) => {
      cb(null);
      return () => {};
    });

    renderAuth();

    await waitFor(() =>
      expect(screen.getByTestId('loading').textContent).toBe('false'),
    );
    expect(screen.getByTestId('uid').textContent).toBe('null');
    expect(screen.getByTestId('username').textContent).toBe('null');
  });

  it('ユーザーあり・プロフィールあり → username が設定される', async () => {
    mockOnAuthStateChanged.mockImplementation((_: unknown, cb: (u: { uid: string }) => void) => {
      cb({ uid: 'user-123' });
      return () => {};
    });
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ username: 'tanaka' }),
    });

    renderAuth();

    await waitFor(() =>
      expect(screen.getByTestId('username').textContent).toBe('tanaka'),
    );
    expect(screen.getByTestId('uid').textContent).toBe('user-123');
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });

  it('ユーザーあり・プロフィールなし → username=null', async () => {
    mockOnAuthStateChanged.mockImplementation((_: unknown, cb: (u: { uid: string }) => void) => {
      cb({ uid: 'user-456' });
      return () => {};
    });
    mockGetDoc.mockResolvedValue({ exists: () => false });

    renderAuth();

    await waitFor(() =>
      expect(screen.getByTestId('loading').textContent).toBe('false'),
    );
    expect(screen.getByTestId('username').textContent).toBe('null');
  });

  it('Firestore エラー → username=null に fallback する', async () => {
    mockOnAuthStateChanged.mockImplementation((_: unknown, cb: (u: { uid: string }) => void) => {
      cb({ uid: 'user-789' });
      return () => {};
    });
    mockGetDoc.mockRejectedValue(new Error('Firestore unavailable'));

    renderAuth();

    await waitFor(() =>
      expect(screen.getByTestId('loading').textContent).toBe('false'),
    );
    expect(screen.getByTestId('username').textContent).toBe('null');
  });

  it('onAuthStateChanged の unsubscribe がアンマウント時に呼ばれる', () => {
    const unsubscribe = vi.fn();
    mockOnAuthStateChanged.mockImplementation((_: unknown, cb: (u: null) => void) => {
      cb(null);
      return unsubscribe;
    });

    const { unmount } = renderAuth();
    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('ユーザー切り替え時のレースコンディション: 古いコールバックの getDoc 結果が新しいユーザーの username を上書きしない', async () => {
    let capturedCb: ((u: { uid: string } | null) => void) | null = null;
    mockOnAuthStateChanged.mockImplementation((_: unknown, cb: (u: { uid: string } | null) => void) => {
      capturedCb = cb;
      return () => {};
    });

    // user-A の getDoc は遅延して解決する
    let resolveUserA!: (v: unknown) => void;
    const slowPromise = new Promise(res => { resolveUserA = res; });

    mockGetDoc
      .mockReturnValueOnce(slowPromise)  // user-A の呼び出し（遅延）
      .mockResolvedValueOnce({ exists: () => true, data: () => ({ username: 'user-b' }) });

    renderAuth();

    // user-A でログイン → getDoc が開始される（まだ完了しない）
    await act(async () => { capturedCb!({ uid: 'user-A' }); });

    // user-B に切り替わる → user-B の getDoc がすぐに解決
    await act(async () => { capturedCb!({ uid: 'user-B' }); });

    await waitFor(() =>
      expect(screen.getByTestId('username').textContent).toBe('user-b'),
    );

    // 遅れていた user-A の getDoc が今頃解決しても username は変わらない
    await act(async () => {
      resolveUserA({ exists: () => true, data: () => ({ username: 'user-a' }) });
    });

    // user-B の username のまま維持されていること
    expect(screen.getByTestId('username').textContent).toBe('user-b');
  });
});
