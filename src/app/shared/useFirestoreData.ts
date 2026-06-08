import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db } from './firebase';
import { useSetLoading } from './AppLoadingContext';

type Options<T> = {
  currentUser: User | null;
  path: string;
  parse: (raw: Record<string, unknown>) => T;
  loadingKey: string;
  initialData: T;
  onAfterLoad?: (data: T) => void;
};

export type FirestoreDataResult<T> = {
  data: T;
  setData: Dispatch<SetStateAction<T>>;
  loading: boolean;
  dbError: boolean;
  setDbError: Dispatch<SetStateAction<boolean>>;
};

/**
 * Firestore からデータを読み込み、ローディング・エラー状態を管理するフック。
 * useLayoutEffect でグローバルローディングキーを管理し、
 * currentUser が確定したときに getDoc を実行する。
 */
export function useFirestoreData<T>(opts: Options<T>): FirestoreDataResult<T> {
  const { currentUser, path, parse, loadingKey, initialData } = opts;
  const setGlobalLoading = useSetLoading();
  const [data, setData] = useState<T>(initialData);
  const [loading, setLoading] = useState(true);
  const [dbError, setDbError] = useState(false);

  // onAfterLoad は毎レンダーで参照が変わりうるため ref 経由で保持する
  const onAfterLoadRef = useRef(opts.onAfterLoad);
  onAfterLoadRef.current = opts.onAfterLoad;

  useLayoutEffect(() => {
    setGlobalLoading(loadingKey, true);
    return () => setGlobalLoading(loadingKey, false);
  }, [setGlobalLoading, loadingKey]);

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    (async () => {
      try {
        const docRef = doc(db, path);
        const snap = await getDoc(docRef);
        if (cancelled) return;
        if (snap.exists()) {
          const parsed = parse(snap.data() as Record<string, unknown>);
          setData(parsed);
          onAfterLoadRef.current?.(parsed);
        }
      } catch (e) {
        if (cancelled) return;
        console.error(`Firestore読み込みエラー [${loadingKey}]:`, e);
        setDbError(true);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setGlobalLoading(loadingKey, false);
        }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  return { data, setData, loading, dbError, setDbError };
}
