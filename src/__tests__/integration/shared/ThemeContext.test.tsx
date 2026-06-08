// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from '@/app/shared/ThemeContext';
import { useAuth } from '@/app/auth/AuthContext';

const { mockDoc, mockGetDoc, mockSetDoc } = vi.hoisted(() => ({
  mockDoc: vi.fn(),
  mockGetDoc: vi.fn(),
  mockSetDoc: vi.fn(),
}));

vi.mock('@/app/shared/firebase', () => ({ db: {} }));
vi.mock('@/app/auth/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('firebase/firestore', () => ({
  doc: mockDoc,
  getDoc: mockGetDoc,
  setDoc: mockSetDoc,
}));

const mockUseAuth = vi.mocked(useAuth);

const ThemeDisplay = () => {
  const { darkMode, toggleDarkMode } = useTheme();
  return (
    <div>
      <span data-testid="darkMode">{String(darkMode)}</span>
      <button onClick={() => void toggleDarkMode()}>toggle</button>
    </div>
  );
};

const renderTheme = () =>
  render(
    <ThemeProvider>
      <ThemeDisplay />
    </ThemeProvider>,
  );

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ThemeContext (結合テスト)', () => {
  it('localStorage に値なし → darkMode=false、app-theme-light クラスが付く', () => {
    mockUseAuth.mockReturnValue({ currentUser: null, username: null, loading: false });
    renderTheme();

    expect(screen.getByTestId('darkMode').textContent).toBe('false');
    expect(document.documentElement.classList.contains('app-theme-light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('localStorage が "true" → darkMode=true、dark クラスが付く', () => {
    localStorage.setItem('tt-dark-mode', 'true');
    mockUseAuth.mockReturnValue({ currentUser: null, username: null, loading: false });
    renderTheme();

    expect(screen.getByTestId('darkMode').textContent).toBe('true');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('app-theme-light')).toBe(false);
  });

  it('toggleDarkMode → darkMode が反転し localStorage・HTML クラスに反映される', async () => {
    mockUseAuth.mockReturnValue({ currentUser: null, username: null, loading: false });
    mockSetDoc.mockResolvedValue(undefined);
    renderTheme();

    expect(screen.getByTestId('darkMode').textContent).toBe('false');

    await act(async () => {
      screen.getByRole('button').click();
    });

    expect(screen.getByTestId('darkMode').textContent).toBe('true');
    expect(localStorage.getItem('tt-dark-mode')).toBe('true');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('app-theme-light')).toBe(false);
  });

  it('toggleDarkMode を 2 回 → 元の状態に戻る', async () => {
    mockUseAuth.mockReturnValue({ currentUser: null, username: null, loading: false });
    mockSetDoc.mockResolvedValue(undefined);
    renderTheme();

    await act(async () => { screen.getByRole('button').click(); });
    await act(async () => { screen.getByRole('button').click(); });

    expect(screen.getByTestId('darkMode').textContent).toBe('false');
    expect(localStorage.getItem('tt-dark-mode')).toBe('false');
    expect(document.documentElement.classList.contains('app-theme-light')).toBe(true);
  });

  it('ユーザーログイン時に Firestore からテーマを読み込む', async () => {
    mockUseAuth.mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      currentUser: { uid: 'u1' } as any,
      username: 'user',
      loading: false,
    });
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ darkMode: true }),
    });

    renderTheme();

    await waitFor(() =>
      expect(screen.getByTestId('darkMode').textContent).toBe('true'),
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('tt-dark-mode')).toBe('true');
  });

  it('Firestore に darkMode が未設定 → localStorage の値を維持する', async () => {
    localStorage.setItem('tt-dark-mode', 'true');
    mockUseAuth.mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      currentUser: { uid: 'u1' } as any,
      username: 'user',
      loading: false,
    });
    mockGetDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ username: 'user' }),
    });

    renderTheme();

    await waitFor(() => expect(mockGetDoc).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('darkMode').textContent).toBe('true');
  });

  it('ユーザーあり・toggleDarkMode → setDoc が呼ばれる', async () => {
    mockUseAuth.mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      currentUser: { uid: 'u1' } as any,
      username: 'user',
      loading: false,
    });
    mockGetDoc.mockResolvedValue({ exists: () => false });
    mockSetDoc.mockResolvedValue(undefined);

    renderTheme();

    await act(async () => {
      screen.getByRole('button').click();
    });

    expect(mockSetDoc).toHaveBeenCalledTimes(1);
  });

  it('ユーザーなし・toggleDarkMode → setDoc は呼ばれない', async () => {
    mockUseAuth.mockReturnValue({ currentUser: null, username: null, loading: false });
    mockSetDoc.mockResolvedValue(undefined);

    renderTheme();

    await act(async () => {
      screen.getByRole('button').click();
    });

    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  it('setDoc が失敗しても darkMode は切り替わる（console.error のみ）', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockUseAuth.mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      currentUser: { uid: 'u1' } as any,
      username: 'user',
      loading: false,
    });
    mockGetDoc.mockResolvedValue({ exists: () => false });
    mockSetDoc.mockRejectedValue(new Error('Firestore error'));

    renderTheme();

    await act(async () => {
      screen.getByRole('button').click();
    });

    // setDoc エラーでも UI は変化している
    expect(screen.getByTestId('darkMode').textContent).toBe('true');
    expect(localStorage.getItem('tt-dark-mode')).toBe('true');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
