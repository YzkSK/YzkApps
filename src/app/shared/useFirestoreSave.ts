import { useRef, useCallback, useEffect } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db } from './firebase';

type Options = {
  currentUser: User | null;
  path: string;
  debounceMs?: number;
  onSuccess?: () => void;
};

/**
 * Firestore にデータをデバウンス保存するフック。
 * 保存失敗は補助的処理のためサイレントに無視する（console.error は出力する）。
 * アンマウント後は onSuccess を呼ばない（setState を含む可能性があるため）。
 * データ損失防止のため、アンマウント後でも setDoc 自体は実行される。
 */
export function useFirestoreSave<T>(opts: Options): (data: T) => void {
  const { currentUser, path, debounceMs = 800 } = opts;
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // onSuccess は毎レンダーで参照が変わりうるため ref 経由で保持
  const onSuccessRef = useRef(opts.onSuccess);
  onSuccessRef.current = opts.onSuccess;
  // アンマウント後の onSuccess 呼び出しを防ぐためのフラグ
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  return useCallback((data: T) => {
    if (!currentUser) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        const docRef = doc(db, path);
        await setDoc(docRef, data as object, { merge: true });
        if (mountedRef.current) {
          onSuccessRef.current?.();
        }
      } catch (e) {
        console.error('Firestore保存失敗:', e);
        /* 保存失敗はサイレントに無視（次回操作時に再試行される） */
      }
    }, debounceMs);
  }, [currentUser, path, debounceMs]);
}
