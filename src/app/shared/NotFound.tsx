type Action =
  | { label: string; href: string; onClick?: never }
  | { label: string; onClick: () => void; href?: never };

const ErrorPage = ({
  code,
  title,
  message,
  action,
}: {
  code: string;
  title: string;
  message: string;
  action: Action;
}) => (
  <div className="min-h-screen bg-[#f8f9fa] dark:bg-[#111] text-[#1a1a1a] dark:text-[#e0e0e0] flex flex-col items-center justify-center gap-4 p-8 text-center">
    <p className="text-[5rem] font-black leading-none">{code}</p>
    <p className="text-lg font-bold">{title}</p>
    <p className="text-sm text-[#888]">{message}</p>
    {action.href ? (
      <a
        href={action.href}
        className="px-5 py-2 bg-[#1a1a1a] dark:bg-[#e0e0e0] text-white dark:text-[#111] rounded-lg font-semibold text-sm no-underline"
      >
        {action.label}
      </a>
    ) : (
      <button
        onClick={action.onClick}
        className="px-5 py-2 bg-[#1a1a1a] dark:bg-[#e0e0e0] text-white dark:text-[#111] rounded-lg font-semibold text-sm"
      >
        {action.label}
      </button>
    )}
  </div>
);

/** 404 Not Found — 存在しないルート */
export const NotFound = () => (
  <ErrorPage
    code="404"
    title="ページが見つかりません"
    message="URLが間違っているか、ページが削除された可能性があります。"
    action={{ label: 'トップページへ', href: '/' }}
  />
);

/** 403 Forbidden — 未認証・権限なし */
export const Forbidden = () => (
  <ErrorPage
    code="403"
    title="アクセス権限がありません"
    message="このページを表示するにはログインが必要です。"
    action={{ label: 'ログインする', href: '/login' }}
  />
);

/** 500 Internal Server Error — 予期しないランタイムエラー */
export const ServerError = () => (
  <ErrorPage
    code="500"
    title="予期しないエラーが発生しました"
    message="しばらく時間をおいてから再度お試しください。"
    action={{ label: 'ページを再読み込み', onClick: () => window.location.reload() }}
  />
);

/** 503 Service Unavailable — 読み込み失敗・サービス停止 */
export const ServiceUnavailable = () => {
  const handleReload = async () => {
    // 動的 import を避けるためインラインで実装
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    }
    window.location.reload();
  };
  return (
    <ErrorPage
      code="503"
      title="サービスを利用できません"
      message="アプリの読み込みに失敗しました。キャッシュが古くなっているか、一時的な障害の可能性があります。"
      action={{ label: 'キャッシュをクリアして再読み込み', onClick: handleReload }}
    />
  );
};
