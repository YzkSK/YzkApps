import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { User } from 'lucide-react';
import { auth } from '../shared/firebase';
import { usePageTitle } from '../shared/usePageTitle';
import { useInstalledApps } from '../platform/InstalledAppsContext';
import { APP_REGISTRY, type AppMeta } from '../platform/registry';
import { AppLayout } from '../platform/AppLayout';
import { useToast } from '../shared/useToast';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

type UninstallTarget = {
  app: AppMeta;
  deleteData: boolean;
};

export const Marketplace = () => {
  const navigate = useNavigate();
  usePageTitle('アプリ一覧');
  const { isInstalled, install, uninstall } = useInstalledApps();
  const { toasts, addToast } = useToast();

  const handleLogout = async () => {
    await signOut(auth);
    navigate('/login');
  };
  const [uninstallTarget, setUninstallTarget] = useState<UninstallTarget | null>(null);
  const [processing, setProcessing] = useState(false);

  const handleInstall = async (id: string) => {
    setProcessing(true);
    await install(id);
    addToast('導入しました');
    setProcessing(false);
  };

  const handleUninstallConfirm = async () => {
    if (!uninstallTarget) return;
    setProcessing(true);
    await uninstall(uninstallTarget.app.id, { deleteData: uninstallTarget.deleteData });
    addToast('アンインストールしました');
    setProcessing(false);
    setUninstallTarget(null);
  };

  return (
    <AppLayout
      title="アプリ一覧"
      toasts={toasts}
      headerActions={
        <div className="app-user-info">
          <Link to="/settings" className="app-avatar-btn" aria-label="設定">
            <User size={18} />
          </Link>
          <Button variant="outline" onClick={handleLogout}>ログアウト</Button>
        </div>
      }
    >
      <div style={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {APP_REGISTRY.map(app => {
          const installed = isInstalled(app.id);
          return (
            <div
              key={app.id}
              style={{
                background: 'var(--app-bg-card)',
                border: '1px solid var(--app-border)',
                borderRadius: 10,
                padding: '16px 20px',
                display: 'flex',
                alignItems: 'center',
                gap: 16,
              }}
            >
              <span style={{ fontSize: 32, flexShrink: 0 }}>{app.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--app-text-primary)' }}>
                  {app.label}
                </div>
                <div style={{ fontSize: 13, color: 'var(--app-text-secondary)', marginTop: 2 }}>
                  {app.description}
                </div>
              </div>
              {installed ? (
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <span style={{
                    fontSize: 11,
                    padding: '3px 8px',
                    borderRadius: 4,
                    background: 'var(--app-border)',
                    color: 'var(--app-text-secondary)',
                    fontWeight: 600,
                    alignSelf: 'center',
                  }}>
                    導入済み
                  </span>
                  <Button
                    variant="outline"
                    onClick={() => setUninstallTarget({ app, deleteData: false })}
                    disabled={processing}
                    style={{ fontSize: 12, padding: '4px 10px' }}
                  >
                    削除
                  </Button>
                </div>
              ) : (
                <Button
                  onClick={() => handleInstall(app.id)}
                  disabled={processing}
                  style={{ flexShrink: 0, fontSize: 13 }}
                >
                  導入する
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {/* アンインストール確認ダイアログ */}
      <Dialog
        open={uninstallTarget !== null}
        onOpenChange={open => { if (!open) setUninstallTarget(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              「{uninstallTarget?.app.label}」をアンインストールしますか？
            </DialogTitle>
          </DialogHeader>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '8px 0' }}>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="radio"
                name="deleteData"
                checked={uninstallTarget?.deleteData === false}
                onChange={() => uninstallTarget && setUninstallTarget({ ...uninstallTarget, deleteData: false })}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>データを残す（推奨）</div>
                <div style={{ fontSize: 12, color: 'var(--app-text-secondary)', marginTop: 2 }}>
                  再導入すればデータはそのまま使えます。ローカルキャッシュのみ削除されます。
                </div>
              </div>
            </label>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="radio"
                name="deleteData"
                checked={uninstallTarget?.deleteData === true}
                onChange={() => uninstallTarget && setUninstallTarget({ ...uninstallTarget, deleteData: true })}
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: '#dc2626' }}>データも削除する</div>
                <div style={{ fontSize: 12, color: 'var(--app-text-secondary)', marginTop: 2 }}>
                  Firestore 上のデータも完全に削除されます。この操作は取り消せません。
                </div>
              </div>
            </label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <Button variant="outline" onClick={() => setUninstallTarget(null)} disabled={processing}>
              キャンセル
            </Button>
            <Button
              variant="destructive"
              onClick={handleUninstallConfirm}
              disabled={processing}
            >
              {processing ? '処理中...' : 'アンインストール'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
};
