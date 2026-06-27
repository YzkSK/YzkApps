import { useState, useEffect } from 'react';
import { getOfflineStorageUsage, getStorageLimitGb, checkQuota } from '../offlineStorage';
import { startDownload } from '../downloadQueue';
import { formatSize } from '../constants';

type Props = {
  fileId: string;
  fileName: string;
  fileSize: string;
  proxyUrl: string;
  accessToken: string;
  onClose: () => void;
  addToast: (msg: string, type: 'normal' | 'error' | 'warning') => void;
};

export const OfflineSaveModal = ({
  fileId,
  fileName,
  fileSize,
  proxyUrl,
  accessToken,
  onClose,
  addToast,
}: Props) => {
  const [usage, setUsage] = useState<{ count: number; totalBytes: number } | null>(null);

  useEffect(() => {
    getOfflineStorageUsage().then(setUsage).catch(() => null);
  }, []);

  const fileSizeBytes = parseInt(fileSize, 10) || 0;
  const limitGb    = getStorageLimitGb();
  const limitBytes = limitGb * 1024 * 1024 * 1024;
  const usedBytes  = usage?.totalBytes ?? 0;
  const wouldExceed = usedBytes + fileSizeBytes > limitBytes;

  const handleSave = async () => {
    const quota = await checkQuota(fileSizeBytes).catch(() => 'ok' as const);
    if (quota === 'over-limit') {
      addToast(`保存上限（${limitGb} GB）を超えます。上限を増やすか既存の動画を削除してください。`, 'warning');
      return;
    }
    startDownload({ fileId, fileName, proxyUrl, accessToken, fileSizeBytes });
    onClose();
  };

  return (
    <div className="vc-player-settings-overlay" onClick={onClose}>
      <div className="vc-player-settings-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 360, width: '90%' }}>

        {/* ヘッダー */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>オフライン保存</span>
          <button className="vc-player-btn" onClick={onClose} aria-label="閉じる">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        {/* ファイルサイズ */}
        {fileSizeBytes > 0 && (
          <div style={{ marginBottom: 12, padding: '8px 12px', background: 'rgba(255,255,255,0.05)', borderRadius: 8 }}>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', margin: '0 0 2px' }}>ファイルサイズ</p>
            <span style={{ fontSize: 13, color: '#fff' }}>{formatSize(fileSize)}</span>
          </div>
        )}

        {/* ストレージ使用量 */}
        {usage !== null && (
          <div style={{ marginBottom: 16, padding: '8px 12px', background: 'rgba(255,255,255,0.05)', borderRadius: 8 }}>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', margin: '0 0 4px' }}>ストレージ使用量</p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: '#fff' }}>{formatSize(String(usedBytes))} / {limitGb} GB</span>
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>{usage.count} 件保存済み</span>
            </div>
            <div style={{ height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
              <div style={{ height: '100%', background: usedBytes / limitBytes > 0.9 ? '#ef4444' : '#60a5fa', borderRadius: 2, width: `${Math.min(100, (usedBytes / limitBytes) * 100)}%`, transition: 'width 0.3s' }} />
            </div>
          </div>
        )}

        {wouldExceed && (
          <p style={{ fontSize: 12, color: '#fbbf24', marginBottom: 12 }}>
            保存上限（{limitGb} GB）を超える可能性があります
          </p>
        )}

        <button
          onClick={handleSave}
          style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: '#3b82f6', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
        >
          バックグラウンドで保存
        </button>
      </div>
    </div>
  );
};
