// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFirestoreSave } from '@/app/shared/useFirestoreSave';

const { mockDoc, mockSetDoc } = vi.hoisted(() => ({
  mockDoc: vi.fn(),
  mockSetDoc: vi.fn(),
}));

vi.mock('@/app/shared/firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  doc: mockDoc,
  setDoc: mockSetDoc,
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const makeUser = (uid = 'uid123') => ({ uid } as { uid: string } as never);

describe('useFirestoreSave (結合テスト)', () => {
  it('currentUser が null の場合は setDoc を呼ばない', async () => {
    const { result } = renderHook(() =>
      useFirestoreSave({ currentUser: null, path: 'users/uid/quiz/data' }),
    );

    act(() => result.current({ value: 'test' }));
    await act(() => vi.runAllTimersAsync());
    expect(mockSetDoc).not.toHaveBeenCalled();
  });

  it('debounceMs 経過後に setDoc が呼ばれる', async () => {
    mockDoc.mockReturnValue('docRef');
    mockSetDoc.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useFirestoreSave({
        currentUser: makeUser(),
        path: 'users/uid/quiz/data',
        debounceMs: 500,
      }),
    );

    act(() => result.current({ value: 'test' }));
    expect(mockSetDoc).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(mockSetDoc).toHaveBeenCalledWith('docRef', { value: 'test' }, { merge: true });
  });

  it('debounce 中に連続呼び出しすると最後の呼び出しのみ保存される', async () => {
    mockDoc.mockReturnValue('docRef');
    mockSetDoc.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useFirestoreSave({
        currentUser: makeUser(),
        path: 'users/uid/quiz/data',
        debounceMs: 800,
      }),
    );

    act(() => result.current({ value: 'first' }));
    act(() => vi.advanceTimersByTime(400));
    act(() => result.current({ value: 'second' }));
    act(() => vi.advanceTimersByTime(400));
    act(() => result.current({ value: 'third' }));

    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(mockSetDoc).toHaveBeenCalledTimes(1);
    expect(mockSetDoc).toHaveBeenCalledWith('docRef', { value: 'third' }, { merge: true });
  });

  it('保存成功後に onSuccess が呼ばれる', async () => {
    mockDoc.mockReturnValue('docRef');
    mockSetDoc.mockResolvedValue(undefined);
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      useFirestoreSave({
        currentUser: makeUser(),
        path: 'users/uid/quiz/data',
        onSuccess,
      }),
    );

    act(() => result.current({ value: 'ok' }));
    await act(() => vi.runAllTimersAsync());
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('アンマウント後に onSuccess は呼ばれない', async () => {
    mockDoc.mockReturnValue('docRef');
    let resolveSetDoc!: () => void;
    mockSetDoc.mockReturnValue(new Promise<void>(res => { resolveSetDoc = res; }));
    const onSuccess = vi.fn();

    const { result, unmount } = renderHook(() =>
      useFirestoreSave({
        currentUser: makeUser(),
        path: 'users/uid/quiz/data',
        onSuccess,
      }),
    );

    act(() => result.current({ value: 'test' }));
    await act(() => vi.runAllTimersAsync());

    // setDoc が完了する前にアンマウント
    unmount();

    // setDoc を解決する
    await act(async () => { resolveSetDoc(); });

    // アンマウント済みなので onSuccess は呼ばれない
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('setDoc が失敗しても onSuccess は呼ばれない（console.error のみ）', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDoc.mockReturnValue('docRef');
    mockSetDoc.mockRejectedValue(new Error('save error'));
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      useFirestoreSave({
        currentUser: makeUser(),
        path: 'users/uid/quiz/data',
        onSuccess,
      }),
    );

    act(() => result.current({ value: 'fail' }));
    await act(() => vi.runAllTimersAsync());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
