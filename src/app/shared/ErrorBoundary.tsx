import { Component, type ReactNode, type ErrorInfo } from 'react';
import { ServerError, ServiceUnavailable } from './NotFound';

type Props = { children: ReactNode };
type State = { hasError: boolean; isChunkError: boolean; clearing: boolean };

async function clearCachesAndReload() {
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  }
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
  }
  window.location.reload();
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, isChunkError: false, clearing: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    const isChunkError = /Loading chunk|Failed to fetch dynamically imported module|ChunkLoadError|dynamically imported module/.test(
      error.message
    );
    return { hasError: true, isChunkError };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary:', error, info);

    // chunk loadエラーはキャッシュをクリアして自動リロード
    if (this.state.isChunkError) {
      this.setState({ clearing: true });
      clearCachesAndReload().catch(e => console.error('キャッシュクリア失敗:', e));
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.state.isChunkError) {
      // 自動リロード中は簡易メッセージを表示
      return this.state.clearing
        ? (
          <div className="min-h-screen bg-[#f8f9fa] dark:bg-[#111] flex flex-col items-center justify-center gap-3 text-[#888]">
            <div className="w-6 h-6 border-2 border-[#ccc] border-t-[#888] rounded-full animate-spin" />
            <p className="text-sm">キャッシュを更新しています...</p>
          </div>
        )
        : <ServiceUnavailable />;
    }
    return <ServerError />;
  }
}

export { clearCachesAndReload };
