import { useNavigate } from 'react-router-dom';
import type { DriveFile } from '../constants';
import { formatDuration, formatDate, formatSize } from '../constants';

type Props = {
  files: DriveFile[];
  tags: Record<string, string[]>;
  playingId: string | null;
  offlineIds?: Set<string>;
  onTagEdit: (file: DriveFile) => void;
  onRename: (file: DriveFile) => void;
  onDelete: (file: DriveFile) => void;
  onOfflineDelete?: (file: DriveFile) => void;
};

export const VideoList = ({ files, tags, playingId, offlineIds, onTagEdit, onRename, onDelete, onOfflineDelete }: Props) => {
  const navigate = useNavigate();
  const isPlaying = (id: string) => id === playingId;

  const handlePlay = (file: DriveFile) => {
    sessionStorage.setItem('vc-scroll-y', String(window.scrollY));
    navigate(`/videocollect/play?id=${encodeURIComponent(file.id)}&name=${encodeURIComponent(file.name)}`);
  };

  return (
    <div className="vc-list">
      {files.map(file => {
        const fileTags = tags[file.id] ?? [];
        const duration = file.videoMediaMetadata?.durationMillis;
        const playing = isPlaying(file.id);

        return (
          <div key={file.id} className="vc-list-item">
            {/* サムネイル */}
            <div
              className="vc-list-thumb"
              onClick={() => handlePlay(file)}
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter') handlePlay(file); }}
            >
              {file.thumbnailLink
                ? <img src={file.thumbnailLink} alt={file.name} loading="lazy" />
                : (
                  <div className="vc-list-thumb-placeholder">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z" />
                    </svg>
                  </div>
                )
              }
              <div className="vc-list-play-overlay">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
              {duration && <div className="vc-list-duration">{formatDuration(duration)}</div>}
              {playing && (
                <div className="vc-now-playing-badge">
                  <span className="vc-now-playing-dot" />
                  再生中
                </div>
              )}
              {offlineIds?.has(file.id) && (
                <div className="vc-offline-badge">オフライン</div>
              )}
            </div>

            {/* 本文 */}
            <div className="vc-list-body">
              <p className="vc-list-name" title={file.name}>{file.name}</p>
              <p className="vc-list-meta">
                {formatDate(file.modifiedTime)}
                {file.size ? ` · ${formatSize(file.size)}` : ''}
              </p>
              {fileTags.length > 0 && (
                <div className="vc-list-tags">
                  {fileTags.map(tag => (
                    <span key={tag} className="vc-tag">{tag}</span>
                  ))}
                </div>
              )}
            </div>

            {/* アクション */}
            <div className="vc-list-actions">
              {offlineIds?.has(file.id) ? (
                onOfflineDelete && (
                  <button
                    className="vc-icon-btn"
                    onClick={() => onOfflineDelete(file)}
                    aria-label="オフライン保存を削除"
                    title="オフライン保存を削除"
                    style={{ color: '#ef4444' }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                  </button>
                )
              ) : (
                <>
                  <button
                    className="vc-icon-btn"
                    onClick={() => onRename(file)}
                    aria-label="ファイル名を変更"
                    title="ファイル名を変更"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    className="vc-icon-btn"
                    onClick={() => onDelete(file)}
                    aria-label="削除"
                    title="ゴミ箱に移動"
                    style={{ color: '#ef4444' }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                  </button>
                  <button
                    className="vc-icon-btn"
                    onClick={() => onTagEdit(file)}
                    aria-label="タグを編集"
                    title="タグを編集"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                      <line x1="7" y1="7" x2="7.01" y2="7" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
