import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { DriveFile } from '../constants';
import { formatDuration, formatDate } from '../constants';
import { useAuth } from '../../auth/AuthContext';

const PREVIEW_CLIP_DURATION_MS = 5_000;
const PREVIEW_CLIP_COUNT = 4;

type Props = {
  file: DriveFile;
  tags: string[];
  accessToken: string;
  isPreviewing: boolean;
  isPlaying: boolean;
  isOffline?: boolean;
  onPreviewChange: (id: string | null) => void;
  onTagEdit: (file: DriveFile) => void;
  onRename: (file: DriveFile) => void;
  onDelete: (file: DriveFile) => void;
};

export const VideoCard = ({ file, tags, accessToken, isPreviewing, isPlaying, isOffline, onPreviewChange, onTagEdit, onRename, onDelete }: Props) => {
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const duration = file.videoMediaMetadata?.durationMillis;
  const [previewNonce, setPreviewNonce] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const previewPositionsRef = useRef<number[]>([]);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingClipIndexRef = useRef<number | null>(null);

  const proxyUrl = import.meta.env.VITE_DRIVE_PROXY_URL as string;

  const clearPreviewTimer = () => {
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  };

  // 外部から isPreviewing が false になったとき（別カードが開始）にクリーンアップ
  useEffect(() => {
    if (!isPreviewing) {
      clearPreviewTimer();
      pendingClipIndexRef.current = null;
      setPreviewNonce(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPreviewing]);

  // アンマウント時にタイマーをクリア
  useEffect(() => () => clearPreviewTimer(), []);

  const fetchNonce = async (): Promise<string | null> => {
    if (!currentUser) return null;
    try {
      const idToken = await currentUser.getIdToken();
      const resp = await fetch(`${proxyUrl}/nonce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: currentUser.uid, idToken, accessToken }),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as { nonce?: string };
      return data.nonce ?? null;
    } catch (e) {
      console.error('VideoCard nonce 取得失敗:', e);
      return null;
    }
  };

  const seekToClip = (idx: number) => {
    const video = videoRef.current;
    if (!video || idx >= PREVIEW_CLIP_COUNT) {
      onPreviewChange(null);
      return;
    }
    clearPreviewTimer();
    pendingClipIndexRef.current = idx;
    video.currentTime = previewPositionsRef.current[idx];
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !video.seeking) {
      startClipTimer();
    }
  };

  const startClipTimer = () => {
    const idx = pendingClipIndexRef.current;
    if (idx === null) return;
    pendingClipIndexRef.current = null;
    clearPreviewTimer();
    previewTimerRef.current = setTimeout(() => seekToClip(idx + 1), PREVIEW_CLIP_DURATION_MS);
  };

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    const durationSec = isFinite(video.duration) ? video.duration : 0;
    if (durationSec > 0) {
      const clipSec = PREVIEW_CLIP_DURATION_MS / 1000;
      const safeEnd = Math.max(0, durationSec - clipSec);
      previewPositionsRef.current = Array.from({ length: PREVIEW_CLIP_COUNT }, () =>
        Math.random() * safeEnd
      ).sort((a, b) => a - b);
    }
    seekToClip(0);
  };

  const handlePlay = () => {
    navigate(`/videocollect/play?id=${encodeURIComponent(file.id)}&name=${encodeURIComponent(file.name)}`);
  };

  const handleTitleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isPreviewing) {
      onPreviewChange(null);
      return;
    }

    // ランダム4か所の位置を生成
    const durationMs = duration ? Number(duration) : 0;
    if (durationMs > 0) {
      const durationSec = durationMs / 1000;
      const clipSec = PREVIEW_CLIP_DURATION_MS / 1000;
      const safeEnd = Math.max(0, durationSec - clipSec);
      previewPositionsRef.current = Array.from({ length: PREVIEW_CLIP_COUNT }, () =>
        Math.random() * safeEnd
      ).sort((a, b) => a - b);
    } else {
      previewPositionsRef.current = [0, 0, 0, 0];
    }

    onPreviewChange(file.id);

    const nonce = await fetchNonce();
    if (!nonce) {
      onPreviewChange(null);
      return;
    }
    setPreviewNonce(nonce);
  };

  return (
    <div className="vc-card" onClick={handleTitleClick}>
      <div className="vc-card-thumb" onClick={e => { e.stopPropagation(); handlePlay(); }} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') handlePlay(); }}>
        {isPreviewing ? (
          <video
            ref={videoRef}
            className="vc-card-preview-video"
            src={previewNonce ? `${proxyUrl}/stream/${encodeURIComponent(file.id)}?token=${encodeURIComponent(previewNonce)}` : undefined}
            autoPlay
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={handleLoadedMetadata}
            onCanPlay={startClipTimer}
            onSeeked={startClipTimer}
          />
        ) : file.thumbnailLink ? (
          <img src={file.thumbnailLink} alt={file.name} loading="lazy" />
        ) : (
          <div className="vc-card-thumb-placeholder">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z" />
            </svg>
          </div>
        )}
        {!isPreviewing && (
          <div className="vc-card-play-overlay">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="white">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}
        {duration && (
          <div className="vc-card-duration">{formatDuration(duration)}</div>
        )}
        {isPlaying && (
          <div className="vc-now-playing-badge">
            <span className="vc-now-playing-dot" />
            再生中
          </div>
        )}
        {isOffline && (
          <div className="vc-offline-badge">オフライン</div>
        )}
      </div>

      <div className="vc-card-body">
        <p
          className={`vc-card-name${isPreviewing ? ' vc-card-name--previewing' : ''}`}
          title={isPreviewing ? 'クリックしてプレビューを閉じる' : 'クリックしてプレビュー'}
        >
          {file.name}
          <span className="vc-card-preview-hint" aria-hidden="true">
            {isPreviewing ? '▶ プレビュー中' : '▶ プレビュー'}
          </span>
        </p>
        <p className="vc-card-date">{formatDate(file.modifiedTime)}</p>

        <div className="vc-card-tags">
          {tags.map(tag => (
            <span key={tag} className="vc-tag">{tag}</span>
          ))}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 2, flexShrink: 0 }}>
            <button
              className="vc-icon-btn"
              onClick={e => { e.stopPropagation(); onRename(file); }}
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
              onClick={e => { e.stopPropagation(); onDelete(file); }}
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
              className="vc-icon-btn vc-tag-edit-btn"
              onClick={e => { e.stopPropagation(); onTagEdit(file); }}
              aria-label="タグを編集"
              title="タグを編集"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                <line x1="7" y1="7" x2="7.01" y2="7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
