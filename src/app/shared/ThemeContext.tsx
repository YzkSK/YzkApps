import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import { useAuth } from '../auth/AuthContext';

type ThemeContextType = {
  darkMode: boolean;
  toggleDarkMode: () => void;
};

const ThemeContext = createContext<ThemeContextType>({ darkMode: false, toggleDarkMode: () => {} });

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const { currentUser } = useAuth();
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('tt-dark-mode') === 'true');

  useEffect(() => {
    if (!currentUser) return;
    getDoc(doc(db, 'users', currentUser.uid, 'profile', 'data')).then(snap => {
      if (snap.exists() && snap.data().darkMode !== undefined) {
        const value = snap.data().darkMode as boolean;
        setDarkMode(value);
        localStorage.setItem('tt-dark-mode', String(value));
        // Apply classes immediately to avoid visual race conditions in tests and startup
        document.documentElement.classList.toggle('app-theme-light', !value);
        document.documentElement.classList.toggle('dark', value);
      }
    }).catch(() => {});
  }, [currentUser]);

  useEffect(() => {
    document.documentElement.classList.toggle('app-theme-light', !darkMode);
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  // iOS PWA のみ: CSS 変数の再評価を強制（Android では display:none が解除されず白画面になるため除外）
  useEffect(() => {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (!isIOS) return;
    const onVisibilityChange = () => {
      if (!document.hidden) {
        const el = document.documentElement;
        el.style.display = 'none';
        void el.offsetHeight;
        el.style.display = '';
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const toggleDarkMode = async () => {
    const next = !darkMode;
    setDarkMode(next);
    localStorage.setItem('tt-dark-mode', String(next));
    if (currentUser) {
      try {
        await setDoc(
          doc(db, 'users', currentUser.uid, 'profile', 'data'),
          { darkMode: next },
          { merge: true },
        );
      } catch (e) {
        // ローカルには反映済みのため rollback なし
        console.error('ThemeContext: darkMode保存失敗', e);
      }
    }
  };

  return (
    <ThemeContext.Provider value={{ darkMode, toggleDarkMode }}>
      {children}
    </ThemeContext.Provider>
  );
};
