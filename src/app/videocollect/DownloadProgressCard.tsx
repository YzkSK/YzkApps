import { useState, useEffect, useRef } from 'react';
import { subscribeTasks, getTasks, cancelDownload, dismissError, type DownloadTask } from './downloadQueue';

const PHASE_LABEL: Record<string, string> = {
  'fetching': '取得中',
  'saving':   '保存中',
  'done':     '保存完了',
  'error':    'エラー',
};

export const DownloadProgressCard = () => {
  const [items, setItems] = useState<DownloadTask[]>(() => [...getTasks().values()]);

  useEffect(() => subscribeTasks(() => setItems([...getTasks().values()])), []);

  if (items.length === 0) return null;

  return (
    <div style={{ position: 'fixed', bottom: 80, left: 16, zIndex: 9000, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
      {items.map(task => <TaskCard key={task.fileId} task={task} />)}
    </div>
  );
};

const TaskCard = ({ task }: { task: DownloadTask }) => {
  const { fileId, fileName, phase, progress, errorCode } = task;
  const touchStartX = useRef<number | null>(null);

  const isActive = phase !== 'done' && phase !== 'error';
  const isDone   = phase === 'done';
  const isError  = phase === 'error';
  const pct      = Math.round(progress * 100);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const dx = Math.abs(e.changedTouches[0].clientX - touchStartX.current);
    touchStartX.current = null;
    if (dx > 72) dismissError(fileId);
  };

  const borderColor = isDone
    ? 'rgba(34,197,94,0.35)'
    : isError
    ? 'rgba(239,68,68,0.4)'
    : 'rgba(255,255,255,0.12)';

  return (
    <div
      onTouchStart={isError ? handleTouchStart : undefined}
      onTouchEnd={isError ? handleTouchEnd : undefined}
      style={{
        pointerEvents: 'auto',
        background: 'rgba(18,18,18,0.96)',
        border: `1px solid ${borderColor}`,
        borderRadius: 10,
        padding: '10px 14px',
        minWidth: 240,
        maxWidth: 320,
        backdropFilter: 'blur(8px)',
        userSelect: 'none',
      }}
    >
      {/* ヘッダー行 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 210 }}>
          {fileName}
        </span>
        {isActive && (
          <button
            onClick={() => cancelDownload(fileId)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.45)', fontSize: 11, padding: '0 0 0 8px', flexShrink: 0 }}
          >
            キャンセル
          </button>
        )}
        {isError && (
          <button
            onClick={() => dismissError(fileId)}
            aria-label="閉じる"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', padding: '0 0 0 8px', flexShrink: 0, display: 'flex', alignItems: 'center' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        )}
      </div>

      {/* ステータス行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {isDone ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="#22c55e" style={{ flexShrink: 0 }}>
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
          </svg>
        ) : isError ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="#ef4444" style={{ flexShrink: 0 }}>
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        ) : (
          <div className="vc-spinner" style={{ width: 13, height: 13, flexShrink: 0 }} />
        )}

        <span style={{ fontSize: 11, color: isDone ? '#22c55e' : isError ? '#ef4444' : 'rgba(255,255,255,0.55)', flex: 1 }}>
          {PHASE_LABEL[phase] ?? phase}
          {phase === 'fetching' && pct > 0 ? ` ${pct}%` : ''}
          {isError && errorCode ? ` [${errorCode}]` : ''}
        </span>
      </div>

      {/* プログレスバー */}
      {phase === 'fetching' && (
        <div style={{ height: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2, marginTop: 7, overflow: 'hidden' }}>
          <div style={{ height: '100%', background: '#3b82f6', borderRadius: 2, width: `${pct}%`, transition: 'width 0.3s' }} />
        </div>
      )}

      {/* エラー時のスワイプヒント */}
      {isError && (
        <p style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)', margin: '6px 0 0', textAlign: 'center' }}>
          スワイプで削除
        </p>
      )}
    </div>
  );
};
