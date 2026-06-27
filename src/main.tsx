import { StrictMode, lazy, Suspense, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { clearCachesAndReload } from './app/shared/ErrorBoundary';

// モジュール読み込みエラー（MIME type / chunk not found）を React 外で検知してキャッシュクリア
// sessionStorage でガードして無限リロードを防ぐ
// アプリ起動時に SW を登録（BgFetch / FCM 両方に必要）
// Timetable を開く前でも BgFetch が使えるようにするため main.tsx で行う
if ('serviceWorker' in navigator) {
  const swParams = new URLSearchParams({
    apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId:             import.meta.env.VITE_FIREBASE_APP_ID,
  });
  navigator.serviceWorker.register(`/firebase-messaging-sw.js?${swParams}`).catch(() => {});
}

window.addEventListener('error', (e) => {
  const isMimeError = e.message?.includes('MIME type');
  const isModuleError = e.message?.includes('Failed to load module script') || e.message?.includes('dynamically imported module');
  if (!isMimeError && !isModuleError) return;
  if (sessionStorage.getItem('chunk-reload')) return;
  sessionStorage.setItem('chunk-reload', '1');
  clearCachesAndReload();
}, true);

import { createBrowserRouter, RouterProvider, Route, Routes } from 'react-router-dom';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { AuthProvider } from './app/auth/AuthContext';
import { ProtectedRoute } from './app/auth/ProtectedRoute';
import { AppIndex } from './app/shell/AppIndex';
import { AppLoadingProvider } from './app/shared/AppLoadingContext';
import { ThemeProvider } from './app/shared/ThemeContext';
import { ErrorBoundary } from './app/shared/ErrorBoundary';
import { NotFound } from './app/shared/NotFound';
import { InstalledAppsProvider } from './app/platform/InstalledAppsContext';
import { SHELL_REGISTRY, APP_REGISTRY } from './app/platform/registry';

// 認証ルート（Shell 以外）はモジュールレベルで lazy 生成
const Login         = lazy(() => import('./app/auth/Login').then(m => ({ default: m.Login })));
const ResetPassword = lazy(() => import('./app/auth/ResetPassword').then(m => ({ default: m.ResetPassword })));

// Shell ルートを registry から生成（モジュールレベルで lazy() を呼ぶ）
const SHELL_ROUTES = SHELL_REGISTRY.flatMap(shell =>
  [shell.route, ...(shell.extraRoutes ?? [])].map(r => ({
    path: r.path,
    Component: lazy(r.getComponent),
    protected: r.protected,
  }))
);

// App ルートを registry から生成
const APP_ROUTES = APP_REGISTRY.flatMap(app =>
  [app.route, ...(app.extraRoutes ?? [])].map(r => ({
    path: r.path,
    Component: lazy(r.getComponent),
    protected: r.protected,
    appId: app.id,
  }))
);

// アプリページ表示中は #root の margin-top をリセット
const AppWrapper = ({ children }: { children: React.ReactNode }) => {
  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;
    const original = root.style.marginTop;
    root.style.marginTop = '0';
    return () => { root.style.marginTop = original; };
  }, []);
  return <>{children}</>;
};

const AppRoutes = () => (
  <AppWrapper>
    <AppLoadingProvider initialKeys={['auth', 'installedApps']}>
      <AuthProvider>
        <InstalledAppsProvider>
          <ThemeProvider>
            <ErrorBoundary>
              <Suspense fallback={null}>
                <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''}>
                  <Routes>
                    <Route path="" element={<AppIndex />} />
                    <Route path="login" element={<Login />} />
                    <Route path="reset-password" element={<ResetPassword />} />

                    {/* Shell ルート（常にアクセス可能・ProtectedRoute のみ） */}
                    {SHELL_ROUTES.map(({ path, Component, protected: isProtected }) => (
                      <Route
                        key={path}
                        path={path}
                        element={
                          isProtected
                            ? <ProtectedRoute><Component /></ProtectedRoute>
                            : <Component />
                        }
                      />
                    ))}

                    {/* App ルート（インストール済みチェックあり） */}
                    {APP_ROUTES.map(({ path, Component, protected: isProtected, appId }) => (
                      <Route
                        key={path}
                        path={path}
                        element={
                          isProtected
                            ? <ProtectedRoute appId={appId}><Component /></ProtectedRoute>
                            : <Component />
                        }
                      />
                    ))}

                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </GoogleOAuthProvider>
              </Suspense>
            </ErrorBoundary>
          </ThemeProvider>
        </InstalledAppsProvider>
      </AuthProvider>
    </AppLoadingProvider>
  </AppWrapper>
);

const router = createBrowserRouter([
  { path: '/*', element: <AppRoutes /> },
  { path: '*',  element: <NotFound /> },
]);

const root = document.getElementById('root');

createRoot(root!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
