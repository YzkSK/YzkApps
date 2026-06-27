import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../shared/firebase';
import { useSetLoading } from '../shared/AppLoadingContext';

type AuthContextType = {
  currentUser: User | null;
  /** undefined = 未ロード、null = ロード済みだがユーザー名未設定、string = 設定済み */
  username: string | null | undefined;
  loading: boolean;
};

const AuthContext = createContext<AuthContextType>({ currentUser: null, username: undefined, loading: true });

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [username, setUsername] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const setGlobalLoading = useSetLoading();

  useEffect(() => {
    // ユーザー切り替え時に古い getDoc の結果が新しいユーザーを上書きしないよう
    // callbackId で最新のコールバックのみ state を更新する
    let latestCallbackId = 0;

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      const callbackId = ++latestCallbackId;
      setCurrentUser(user);

      (async () => {
        try {
          if (user) {
            const snap = await getDoc(doc(db, 'users', user.uid, 'profile', 'data'));
            if (callbackId !== latestCallbackId) return;
            const val = snap.exists() ? (snap.data().username as string ?? null) : null;
            localStorage.setItem(`auth-username-${user.uid}`, JSON.stringify(val));
            setUsername(val);
          } else {
            if (callbackId !== latestCallbackId) return;
            setUsername(null);
          }
        } catch (e) {
          if (callbackId !== latestCallbackId) return;
          console.error('AuthContext: プロフィール取得失敗', e);
          if (user) {
            const cached = localStorage.getItem(`auth-username-${user.uid}`);
            setUsername(cached !== null ? (JSON.parse(cached) as string | null) : null);
          } else {
            setUsername(null);
          }
        } finally {
          if (callbackId === latestCallbackId) {
            setLoading(false);
            setGlobalLoading('auth', false);
          }
        }
      })();
    });
    return unsubscribe;
  }, [setGlobalLoading]);

  return (
    <AuthContext.Provider value={{ currentUser, username, loading }}>
      {children}
    </AuthContext.Provider>
  );
};
