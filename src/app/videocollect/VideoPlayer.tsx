import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../shared/firebase';
import { useAuth } from '../auth/AuthContext';
import { usePageTitle } from '../shared/usePageTitle';
import { useFirestoreSave } from '../shared/useFirestoreSave';
import '../shared/app.css';
import './videocollect.css';
import { type DriveFile, type VcAuth, type VcData, VC_INITIAL_DATA, firestorePaths, loadAccessToken, getCachedAccessToken, formatTime, parseVcData, VC_ERROR_CODES, fetchAllDriveFiles, buildVideoQuery, fetchDriveFileMetadata } from './constants';
import { TagModal } from './modals/TagModal';
import { OfflineSaveModal } from './modals/OfflineSaveModal';
import { isOfflineSaved, loadOfflineVideo, deleteOfflineVideo } from './offlineStorage';
import { subscribeTasks, getTasks } from './downloadQueue';
import { DownloadProgressCard } from './DownloadProgressCard';
import { useToast } from '../shared/useToast';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const AUTOPLAY_SECONDS = 5;

const normalizeFileName = (name: string) =>
  name.replace(/\.[^.]+$/, '').toLowerCase();

function lcsLength(a: string, b: string): number {
  const m = a.length, n = b.length;
  let max = 0;
  const dp = new Array(n + 1).fill(0);
  for (let i = 0; i < m; i++) {
    let prev = 0;
    for (let j = 0; j < n; j++) {
      const tmp = dp[j + 1];
      dp[j + 1] = a[i] === b[j] ? prev + 1 : 0;
      if (dp[j + 1] > max) max = dp[j + 1];
      prev = tmp;
    }
  }
  return max;
}

function lcsScore(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  return lcsLength(a, b) / Math.min(a.length, b.length);
}

export const VideoPlayer = () => {
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fileId = searchParams.get('id') ?? '';
  const fileName = searchParams.get('name') ?? '動画';
  usePageTitle(fileName);

  const { toasts, addToast } = useToast();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [videoNonce, setVideoNonce] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<'processing' | 'codec' | 'error' | null>(null);
  const [vcData, setVcData] = useState<VcData>(VC_INITIAL_DATA);
  const [showTagModal, setShowTagModal] = useState(false);
  const [allFiles, setAllFiles] = useState<DriveFile[] | null>(null);
  const [recLoadFailed, setRecLoadFailed] = useState(false);
  const [recLoading, setRecLoading] = useState(false);
  const [randomSeed, setRandomSeed] = useState(0);
  const [forceRandom, setForceRandom] = useState(false);
  const [expandedSameTag, setExpandedSameTag] = useState(false);
  const [expandedSimilar, setExpandedSimilar] = useState(false);
  const REC_INITIAL = 12;

  const [offlineSaved, setOfflineSaved] = useState(false);
  const [offlineBlobUrl, setOfflineBlobUrl] = useState<string | null>(null);
  const [showOfflineSaveModal, setShowOfflineSaveModal] = useState(false);
  const [fileSize, setFileSize] = useState('0');
  const [thumbnailLink, setThumbnailLink] = useState<string | undefined>(undefined);
  const [autoplayNext, setAutoplayNext] = useState(() => localStorage.getItem('vc-autoplay-next') === 'true');
  const [autoplayCountdown, setAutoplayCountdown] = useState<number | null>(null);
  const [nextupFile, setNextupFile] = useState<DriveFile | null>(null);
  const autoplayIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoplayNavRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fileTags = vcData.tags[fileId] ?? [];
  const allTags = useMemo(
    () => [...new Set(Object.values(vcData.tags).flat())],
    [vcData.tags],
  );

  const { sameTagFiles, similarFiles, isSimilarFallback } = useMemo(() => {
    if (!allFiles) return { sameTagFiles: [], similarFiles: [], isSimilarFallback: true };
    const same = fileTags.length > 0
      ? allFiles.filter(f => f.id !== fileId && (vcData.tags[f.id] ?? []).some(t => fileTags.includes(t)))
      : [];
    const sameIds = new Set(same.map(f => f.id));
    const others = allFiles.filter(f => !sameIds.has(f.id) && f.id !== fileId);

    if (!forceRandom) {
      const currentName = normalizeFileName(fileName);
      const scored = others
        .map(f => ({ file: f, score: lcsScore(currentName, normalizeFileName(f.name)) }))
        .filter(x => x.score >= 0.3)
        .sort((a, b) => b.score - a.score);
      if (scored.length > 0) {
        return { sameTagFiles: same, similarFiles: scored.map(x => x.file), isSimilarFallback: false };
      }
    }

    const random = others.sort(() => Math.random() - 0.5).slice(0, 12);
    return { sameTagFiles: same, similarFiles: random, isSimilarFallback: true };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFiles, randomSeed, forceRandom, fileName, fileId]);

  const saveVcData = useFirestoreSave<VcData>({
    currentUser,
    path: currentUser ? firestorePaths.vcData(currentUser.uid) : '',
  });

  const handleTagSave = (tags: string[]) => {
    const next = { ...vcData, tags: { ...vcData.tags, [fileId]: tags } };
    setVcData(next);
    saveVcData(next);
    setShowTagModal(false);
  };

  const videoRef = useRef<HTMLVideoElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewSeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapRef = useRef<{ side: 'left' | 'right'; time: number } | null>(null);
  const doubleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doubleTapAccumSideRef = useRef<'left' | 'right' | null>(null);
  const doubleTapAccumTotalRef = useRef(0);
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstFileRef = useRef(true);
  // nonce 期限切れによる onError 後にシーク位置を復元するための一時記録
  const nonceRefreshTimeRef = useRef<number | null>(null);
  const [doubleTapSide, setDoubleTapSide] = useState<'left' | 'right' | null>(null);
  const [doubleTapTotal, setDoubleTapTotal] = useState(0);
  const [doubleTapKey, setDoubleTapKey] = useState(0);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [skipSeconds, setSkipSeconds] = useState(10);
  const [showControls, setShowControls] = useState(true);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [isBufferReady, setIsBufferReady] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPreview, setSeekPreview] = useState(0);
  const [seekTarget, setSeekTarget] = useState<number | null>(null);

  useEffect(() => {
    setForceRandom(false);
    setExpandedSimilar(false);
  }, [fileId]);

  // オフライン保存状態をマウント時に確認
  useEffect(() => {
    isOfflineSaved(fileId)
      .then(async (saved) => {
        setOfflineSaved(saved);
        if (saved) {
          const blob = await loadOfflineVideo(fileId);
          if (blob) {
            setOfflineBlobUrl(URL.createObjectURL(blob));
            setFileSize(String(blob.size));
          }
        }
      })
      .catch(e => console.error('オフライン状態確認エラー:', e));
    return () => {
      setOfflineBlobUrl(prev => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [fileId]);

  useEffect(() => {
    if (!currentUser) return;

    const cached = getCachedAccessToken(currentUser.uid);
    if (cached) {
      // キャッシュヒット: 即座に nonce 取得開始（Firestore vcAuth を待たない）
      setAccessToken(cached.token);
      fetchNonce(cached.token).then(nonce => {
        if (nonce) setVideoNonce(nonce);
        else setLoadError(`動画の読み込みに失敗しました [${VC_ERROR_CODES.NONCE_FETCH}]`);
      });
      // vcData のみ読み込む（タグ・レコメンドで必要）
      getDoc(doc(db, firestorePaths.vcData(currentUser.uid)))
        .then(snap => { if (snap.exists()) setVcData(parseVcData(snap.data() as Record<string, unknown>)); })
        .catch(e => console.error('VideoPlayer vcData 読み込みエラー:', e));
      return;
    }

    Promise.all([
      getDoc(doc(db, firestorePaths.vcAuth(currentUser.uid))),
      getDoc(doc(db, firestorePaths.vcData(currentUser.uid))),
    ])
      .then(([authSnap, dataSnap]) => {
        if (dataSnap.exists()) {
          setVcData(parseVcData(dataSnap.data() as Record<string, unknown>));
        }
        if (!authSnap.exists()) {
          setLoadError('Google Drive が連携されていません');
          return null;
        }
        const auth = authSnap.data() as VcAuth;
        if (!auth.refreshToken) {
          setLoadError('Google Drive が連携されていません');
          return null;
        }
        return currentUser.getIdToken().then(idToken => loadAccessToken(currentUser.uid, auth, idToken));
      })
      .then(token => {
        if (token === null) return;
        if (!token) {
          setLoadError(`アクセストークンの取得に失敗しました [${VC_ERROR_CODES.TOKEN_REFRESH}]`);
          return;
        }
        setAccessToken(token);
        // nonce を取得してから videoSrc に使用する（アクセストークンをログに残さないため）
        fetchNonce(token).then(nonce => {
          if (nonce) {
            setVideoNonce(nonce);
          } else {
            setLoadError(`動画の読み込みに失敗しました [${VC_ERROR_CODES.NONCE_FETCH}]`);
          }
        });
      })
      .catch(e => {
        console.error('VideoPlayer 読み込みエラー:', e);
        setLoadError('読み込みに失敗しました');
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  const reloadRecommendations = useCallback(() => {
    if (!accessToken) return;
    setRecLoadFailed(false);
    setAllFiles(null);
    setRecLoading(true);
    fetchAllDriveFiles(accessToken, buildVideoQuery(vcData.folders))
      .then(files => { setAllFiles(files.filter(f => f.id !== fileId)); setRecLoading(false); })
      .catch(() => { setRecLoadFailed(true); setRecLoading(false); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  // レコメンド用に全ファイル一覧を取得
  useEffect(() => {
    if (!accessToken) return;
    setRecLoading(true);
    fetchAllDriveFiles(accessToken, buildVideoQuery(vcData.folders))
      .then(files => { setAllFiles(files.filter(f => f.id !== fileId)); setRecLoading(false); })
      .catch(() => { setRecLoadFailed(true); setRecLoading(false); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  // 現在のファイルのメタデータ（ファイルサイズなど）を取得
  useEffect(() => {
    if (!accessToken || !fileId) return;
    fetchDriveFileMetadata(accessToken, fileId)
      .then(file => {
        if (file && file.size) {
          setFileSize(file.size);
          console.info('[VideoPlayer] fileSize updated', { fileId, size: file.size });
        }
        if (file && file.thumbnailLink) {
          setThumbnailLink(file.thumbnailLink);
        }
      })
      .catch(e => console.error('[VideoPlayer] failed to fetch file metadata', e));
  }, [accessToken, fileId]);

  // レコメンドから別動画に遷移した際にプレイヤー状態をリセットしてスクロール
  useEffect(() => {
    if (isFirstFileRef.current) {
      isFirstFileRef.current = false;
      return;
    }
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setBufferedEnd(0);
    setWaiting(false);
    setIsBufferReady(false);
    setVideoError(null);
    setIsSeeking(false);
    setSeekTarget(null);
    setExpandedSameTag(false);
    setExpandedSimilar(false);
    cancelAutoplay();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  useEffect(() => {
    const handler = () => {
      setIsFullscreen(!!(document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement));
    };
    document.addEventListener('fullscreenchange', handler);
    document.addEventListener('webkitfullscreenchange', handler);
    return () => {
      document.removeEventListener('fullscreenchange', handler);
      document.removeEventListener('webkitfullscreenchange', handler);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('vc-playing-id', fileId);
  }, [fileId]);

  const cancelAutoplay = useCallback(() => {
    if (autoplayIntervalRef.current) clearInterval(autoplayIntervalRef.current);
    if (autoplayNavRef.current) clearTimeout(autoplayNavRef.current);
    setAutoplayCountdown(null);
    setNextupFile(null);
  }, []);

  const startAutoplay = useCallback((file: DriveFile) => {
    if (autoplayIntervalRef.current) clearInterval(autoplayIntervalRef.current);
    if (autoplayNavRef.current) clearTimeout(autoplayNavRef.current);
    setNextupFile(file);
    setAutoplayCountdown(AUTOPLAY_SECONDS);
    autoplayIntervalRef.current = setInterval(() => {
      setAutoplayCountdown(c => {
        if (c === null || c <= 1) {
          clearInterval(autoplayIntervalRef.current!);
          autoplayIntervalRef.current = null;
          return null;
        }
        return c - 1;
      });
    }, 1000);
    autoplayNavRef.current = setTimeout(() => {
      navigate(`/videocollect/play?id=${encodeURIComponent(file.id)}&name=${encodeURIComponent(file.name)}`);
    }, AUTOPLAY_SECONDS * 1000);
  }, [navigate]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (doubleTapTimerRef.current) clearTimeout(doubleTapTimerRef.current);
      if (previewSeekTimerRef.current) clearTimeout(previewSeekTimerRef.current);
      if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
      if (autoplayIntervalRef.current) clearInterval(autoplayIntervalRef.current);
      if (autoplayNavRef.current) clearTimeout(autoplayNavRef.current);
    };
  }, []);

  // ドラッグ中にプレビュー動画を80msデバウンスでシーク（メタデータ読み込み済みの場合のみ）
  useEffect(() => {
    if (!isSeeking) return;
    if (previewSeekTimerRef.current) clearTimeout(previewSeekTimerRef.current);
    previewSeekTimerRef.current = setTimeout(() => {
      const pv = previewVideoRef.current;
      if (pv && pv.readyState >= 1) pv.currentTime = seekPreview;
    }, 80);
  }, [isSeeking, seekPreview]);

  const showControlsTemporary = useCallback(() => {
    setShowControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setShowControls(false);
    }, 3000);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const video = videoRef.current;
      if (!video) return;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          if (video.paused) { video.play(); } else { video.pause(); }
          showControlsTemporary();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 5);
          showControlsTemporary();
          break;
        case 'ArrowRight':
          e.preventDefault();
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
          showControlsTemporary();
          break;
        case 'ArrowUp':
          e.preventDefault();
          video.volume = Math.min(1, video.volume + 0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          video.volume = Math.max(0, video.volume - 0.1);
          break;
        case 'm':
        case 'M':
          video.muted = !video.muted;
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showControlsTemporary]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement) {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else {
        (document as Document & { webkitExitFullscreen?: () => void }).webkitExitFullscreen?.();
      }
    } else {
      const el = containerRef.current;
      if (!el) return;
      (el.requestFullscreen?.() ?? (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.())
        ?.catch(() => {
          const video = videoRef.current;
          if (video && 'webkitEnterFullscreen' in video) {
            (video as HTMLVideoElement & { webkitEnterFullscreen: () => void }).webkitEnterFullscreen();
          }
        });
    }
  };

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    if ((e.target as HTMLElement).closest('button, input')) return;
    if (showControls) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setShowControls(false);
    } else {
      showControlsTemporary();
    }
  }, [showControls, showControlsTemporary]);

  const handleTouchEnd = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const { left, width } = e.currentTarget.getBoundingClientRect();
    const x = e.changedTouches[0].clientX - left;
    const side: 'left' | 'right' = x < width / 2 ? 'left' : 'right';
    const now = Date.now();
    const last = lastTapRef.current;
    if (last && last.side === side && now - last.time < 300) {
      if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
      video.currentTime = side === 'left'
        ? Math.max(0, video.currentTime - skipSeconds)
        : Math.min(video.duration || 0, video.currentTime + skipSeconds);
      lastTapRef.current = null;
      if (doubleTapAccumSideRef.current === side) {
        doubleTapAccumTotalRef.current += skipSeconds;
      } else {
        doubleTapAccumSideRef.current = side;
        doubleTapAccumTotalRef.current = skipSeconds;
      }
      // key を変えて同じ側の連続タップでも CSS アニメーションをリスタート
      setDoubleTapKey(k => k + 1);
      setDoubleTapSide(side);
      setDoubleTapTotal(doubleTapAccumTotalRef.current);
      setShowControls(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (doubleTapTimerRef.current) clearTimeout(doubleTapTimerRef.current);
      doubleTapTimerRef.current = setTimeout(() => {
        setDoubleTapSide(null);
        doubleTapAccumSideRef.current = null;
        doubleTapAccumTotalRef.current = 0;
        showControlsTemporary();
      }, 800);
    } else {
      lastTapRef.current = { side, time: now };
      if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current);
      const wasVisible = showControls;
      singleTapTimerRef.current = setTimeout(() => {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        if (wasVisible) {
          setShowControls(false);
        } else {
          setShowControls(true);
          hideTimerRef.current = setTimeout(() => {
            if (videoRef.current && !videoRef.current.paused) setShowControls(false);
          }, 3000);
        }
      }, 300);
    }
  }, [skipSeconds, showControls, showControlsTemporary]);

  const handleSeekStart = () => {
    setIsSeeking(true);
    setSeekPreview(seekTarget ?? currentTime);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  };

  const updateBuffered = (v: HTMLVideoElement) => {
    const buf = v.buffered;
    for (let i = 0; i < buf.length; i++) {
      if (buf.start(i) <= v.currentTime + 0.1 && buf.end(i) > v.currentTime) {
        setBufferedEnd(buf.end(i));
        return;
      }
    }
  };

  const proxyUrl = import.meta.env.VITE_DRIVE_PROXY_URL as string;

  const fetchNonce = useCallback(async (token: string): Promise<string | null> => {
    if (!currentUser) return null;
    try {
      const idToken = await currentUser.getIdToken();
      const resp = await fetch(`${proxyUrl}/nonce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: currentUser.uid, idToken, accessToken: token }),
      });
      if (!resp.ok) return null;
      const data = await resp.json() as { nonce?: string };
      return data.nonce ?? null;
    } catch (e) {
      console.error(`nonce 取得失敗 [${VC_ERROR_CODES.NONCE_FETCH}]:`, e);
      return null;
    }
  }, [currentUser, proxyUrl]);

  // downloadQueue のダウンロード完了を監視して状態を更新する
  useEffect(() => {
    return subscribeTasks(() => {
      const task = getTasks().get(fileId);
      if (task?.phase !== 'done') return;
      setOfflineSaved(true);
      loadOfflineVideo(fileId).then(blob => {
        if (!blob) return;
        setOfflineBlobUrl(prev => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
        setFileSize(String(blob.size));
      }).catch(() => null);
    });
  }, [fileId]);

  const handleOfflineDelete = async () => {
    try {
      await deleteOfflineVideo(fileId);
      setOfflineSaved(false);
      setOfflineBlobUrl(prev => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      addToast('オフライン保存を削除しました', 'normal');
    } catch (e) {
      console.error('オフライン削除エラー:', e);
      addToast(`削除に失敗しました [${VC_ERROR_CODES.OFFLINE_SAVE}]`, 'error');
    }
  };

  // nonce を使ってアクセストークンを直接 URL に含めない（Cloudflare ログへの記録を防ぐ）
  const videoSrc = offlineBlobUrl ?? (videoNonce
    ? `${proxyUrl}/stream/${encodeURIComponent(fileId)}?token=${encodeURIComponent(videoNonce)}`
    : '');

  if (loadError && !offlineBlobUrl) {
    return (
      <div className="vc-player-page" style={{ alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, textAlign: 'center', padding: '0 24px' }}>
          {loadError}
        </p>
        <Link to="/videocollect" style={{ color: '#60a5fa', fontSize: 13 }}>
          ← 動画一覧に戻る
        </Link>
      </div>
    );
  }

  if ((!accessToken || !videoNonce) && !offlineBlobUrl) {
    return (
      <div className="vc-player-page" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14 }}>読み込み中…</p>
      </div>
    );
  }

  return (
    <div className="vc-player-page">
      {/* トースト */}
      <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 10000, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', pointerEvents: 'none' }}>
        {toasts.map(t => (
          <div key={t.id} style={{
            padding: '8px 18px', borderRadius: 8, fontSize: 13, color: '#fff', pointerEvents: 'none',
            background: t.type === 'error' ? '#dc2626' : t.type === 'warning' ? '#d97706' : 'rgba(30,30,30,0.95)',
            boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
          }}>
            {t.msg}
          </div>
        ))}
      </div>

      {/* ヘッダー */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '12px 16px',
        background: 'var(--vc-bg)',
        flexShrink: 0,
      }}>
        <Link
          to="/videocollect"
          style={{ color: 'var(--vc-text-primary)', textDecoration: 'none', fontSize: 20, lineHeight: 1 }}
          aria-label="戻る"
        >
          ←
        </Link>
      </div>

      {/* 動画 */}
      <div
        ref={containerRef}
        className="vc-player-container"
        onMouseMove={showControlsTemporary}
        onPointerDown={handlePointerDown}
        onTouchEnd={handleTouchEnd}
      >
        <video
          ref={videoRef}
          className="vc-player-video"
          src={videoSrc}
          playsInline
          preload="auto"
          onPlay={() => { setPlaying(true); showControlsTemporary(); }}
          onPause={() => { setPlaying(false); setShowControls(true); }}
          onEnded={() => {
            setPlaying(false);
            setShowControls(true);
            if (autoplayNext) {
              const next = sameTagFiles[0] ?? similarFiles[0] ?? null;
              if (next) startAutoplay(next);
            }
          }}
          onTimeUpdate={() => {
            const v = videoRef.current;
            if (!v) return;
            setCurrentTime(v.currentTime);
            updateBuffered(v);
          }}
          onProgress={() => { const v = videoRef.current; if (v) updateBuffered(v); }}
          onDurationChange={() => setDuration(videoRef.current?.duration ?? 0)}
          onVolumeChange={() => {
            const v = videoRef.current;
            if (!v) return;
            setVolume(v.volume);
            setMuted(v.muted);
          }}
          onRateChange={() => setSpeed(videoRef.current?.playbackRate ?? 1)}
          onSeeked={() => setSeekTarget(null)}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => { setWaiting(false); setIsBufferReady(true); }}
          onCanPlay={() => {
            setWaiting(false);
            setIsBufferReady(true);
            const v = videoRef.current;
            if (!v) return;
            // nonce 更新後の再ロードであれば元の再生位置に戻す
            if (nonceRefreshTimeRef.current !== null) {
              v.currentTime = nonceRefreshTimeRef.current;
              nonceRefreshTimeRef.current = null;
            }
            // ビデオトラックが描画されない場合（コーデック非対応）を検知
            if (v.readyState >= 3 && v.videoWidth === 0 && v.duration > 0) {
              setVideoError('codec');
            }
          }}
          onError={async () => {
            try {
              if (!accessToken) { setVideoError('error'); return; }
              // nonce が期限切れの可能性があるため常に再取得する
              const newNonce = await fetchNonce(accessToken);
              if (newNonce) {
                // 現在の再生位置を保存してから nonce を更新（src が変わり動画がリロードされるため）
                nonceRefreshTimeRef.current = videoRef.current?.currentTime ?? null;
                setVideoNonce(newNonce);
                return;
              }
              // nonce 再取得も失敗した場合は Drive 処理中か判定
              const fallbackNonce = videoNonce;
              if (!fallbackNonce) { setVideoError('error'); return; }
              const res = await fetch(
                `${proxyUrl}/stream/${encodeURIComponent(fileId)}?token=${encodeURIComponent(fallbackNonce)}`,
                { method: 'HEAD' },
              ).catch(() => null);
              setVideoError(res?.status === 503 ? 'processing' : 'error');
            } catch {
              setVideoError('error');
            }
          }}
        />

        {/* ダブルタップインジケーター */}
        {doubleTapSide && (
          <div key={doubleTapKey} className={`vc-doubletap-indicator vc-doubletap-indicator--${doubleTapSide}`}>
            <div className="vc-doubletap-chevrons">
              {[0, 1, 2].map(i =>
                doubleTapSide === 'left' ? (
                  <svg key={i} width="20" height="20" viewBox="0 0 24 24" fill="white" style={{ opacity: 1 - i * 0.25 }}>
                    <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                  </svg>
                ) : (
                  <svg key={i} width="20" height="20" viewBox="0 0 24 24" fill="white" style={{ opacity: 1 - i * 0.25 }}>
                    <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
                  </svg>
                )
              )}
            </div>
            <span className="vc-doubletap-label">
              {doubleTapSide === 'left' ? `-${doubleTapTotal}秒` : `+${doubleTapTotal}秒`}
            </span>
          </div>
        )}

        {/* 初回バッファリングオーバーレイ */}
        {videoError && (
          <div className="vc-buffer-overlay">
            {videoError === 'processing' ? (
              <>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <p className="vc-buffer-text" style={{ maxWidth: 280, textAlign: 'center' }}>
                  Google Drive が動画を処理中です。しばらく待ってからもう一度お試しください。
                </p>
              </>
            ) : (
              <>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <p className="vc-buffer-text">動画を読み込めませんでした</p>
                <button className="vc-buffer-skip" onClick={() => { setVideoError(null); setIsBufferReady(false); videoRef.current?.load(); }}>
                  再試行
                </button>
              </>
            )}
          </div>
        )}

        {!videoError && !isBufferReady && (
          <div className="vc-buffer-overlay">
            <div className="vc-spinner" />
            <p className="vc-buffer-text">
              バッファリング中
              {duration > 0
                ? `… ${Math.round((Math.min(bufferedEnd, duration) / duration) * 100)}%`
                : '…'}
            </p>
            <button className="vc-buffer-skip" onClick={() => setIsBufferReady(true)}>
              今すぐ再生
            </button>
          </div>
        )}

        {/* バッファリングスピナー */}
        {waiting && isBufferReady && (
          <div className="vc-spinner-overlay">
            <div className="vc-spinner" />
          </div>
        )}

        {/* オフライン再生中バッジ */}
        {offlineSaved && (
          <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 10, background: 'rgba(34,197,94,0.85)', borderRadius: 6, padding: '3px 8px', fontSize: 11, color: '#fff', fontWeight: 600, pointerEvents: 'none' }}>
            オフライン
          </div>
        )}

        {/* コントロールオーバーレイ */}
        <div
          className={`vc-player-controls${showControls ? '' : ' vc-player-controls--hidden'}`}
        >
          {/* 上部右: ミュート・設定・オフライン保存・フルスクリーン */}
          <div className="vc-player-controls-top">
            <button
              className="vc-player-btn"
              onClick={() => { const v = videoRef.current; if (v) v.muted = !v.muted; }}
              aria-label={muted ? 'ミュート解除' : 'ミュート'}
            >
              {muted || volume === 0 ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
                </svg>
              )}
            </button>
            <button
              className="vc-player-btn"
              onClick={() => setShowSettingsMenu(true)}
              aria-label="設定"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96a7.05 7.05 0 0 0-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.477.477 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 0 0-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
              </svg>
            </button>
            <button className="vc-player-btn vc-shortcut-btn" onClick={() => setShowShortcutHelp(v => !v)} aria-label="キーボードショートカット" title="キーボードショートカット">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 5H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 5H5v-2h2v2zm10 0H9v-2h8v2zm0-3h-2v-2h2v2zm0-3h-2V8h2v2zm-5 0h-2V8h2v2z"/>
              </svg>
            </button>
            {offlineSaved ? (
              <button
                className="vc-player-btn"
                onClick={handleOfflineDelete}
                aria-label="オフライン保存を削除"
                title="オフライン保存を削除"
                style={{ color: '#22c55e' }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                </svg>
              </button>
            ) : (
              <button
                className="vc-player-btn"
                onClick={async () => {
                  if (!accessToken) return;
                  const nonce = await fetchNonce(accessToken);
                  if (nonce) setVideoNonce(nonce);
                  setShowOfflineSaveModal(true);
                }}
                aria-label="オフラインで保存"
                title="オフラインで保存"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 9h-4V3H9v6H5l7 7 7-7zm0 9H5v2h14v-2z" />
                </svg>
              </button>
            )}
            <button className="vc-player-btn" onClick={toggleFullscreen} aria-label={isFullscreen ? 'フルスクリーン解除' : 'フルスクリーン'}>
              {isFullscreen ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                </svg>
              )}
            </button>
          </div>

          {/* 中央: スキップ戻る・再生/停止・スキップ進む */}
          <div className="vc-player-controls-center">
            <button
              className="vc-player-btn--skip"
              onClick={() => { const v = videoRef.current; if (v) v.currentTime = Math.max(0, v.currentTime - skipSeconds); }}
              aria-label={`${skipSeconds}秒戻る`}
            >
              <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
              </svg>
              <span className="vc-player-skip-label">{skipSeconds}</span>
            </button>

            <button
              className="vc-player-btn--play"
              onClick={() => { const v = videoRef.current; if (!v) return; if (v.paused) { v.play(); } else { v.pause(); } }}
              aria-label={playing ? '一時停止' : '再生'}
            >
              {playing ? (
                <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              ) : (
                <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            <button
              className="vc-player-btn--skip"
              onClick={() => { const v = videoRef.current; if (v) v.currentTime = Math.min(v.duration || 0, v.currentTime + skipSeconds); }}
              aria-label={`${skipSeconds}秒進む`}
            >
              <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18 13c0 3.31-2.69 6-6 6s-6-2.69-6-6 2.69-6 6-6v4l5-5-5-5v4c-4.42 0-8 3.58-8 8s3.58 8 8 8 8-3.58 8-8h-2z" />
              </svg>
              <span className="vc-player-skip-label">{skipSeconds}</span>
            </button>
          </div>

          {/* 下部: シークバー・時間 */}
          <div className="vc-player-controls-bottom">
            <div className="vc-seek-wrapper">
              {isSeeking && duration > 0 && (
                <div
                  className="vc-seek-preview"
                  style={{ left: `clamp(60px, ${(seekPreview / duration) * 100}%, calc(100% - 60px))` }}
                >
                  <video
                    ref={previewVideoRef}
                    className="vc-seek-preview-video"
                    src={videoSrc}
                    muted
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={() => {
                      const pv = previewVideoRef.current;
                      if (pv) pv.currentTime = seekPreview;
                    }}
                  />
                  <span className="vc-seek-preview-time">{formatTime(seekPreview)}</span>
                </div>
              )}
              <input
                type="range"
                className="vc-seek-bar"
                min={0}
                max={duration || 1}
                step={0.01}
                value={isSeeking ? seekPreview : (seekTarget ?? currentTime)}
                onMouseDown={handleSeekStart}
                onTouchStart={handleSeekStart}
                onChange={e => setSeekPreview(Number(e.target.value))}
                onMouseUp={e => {
                  const target = Number((e.target as HTMLInputElement).value);
                  const v = videoRef.current;
                  if (v) v.currentTime = target;
                  setSeekTarget(target);
                  setIsSeeking(false);
                  showControlsTemporary();
                }}
                onTouchEnd={e => {
                  const v = videoRef.current;
                  if (v) v.currentTime = seekPreview;
                  setSeekTarget(seekPreview);
                  setIsSeeking(false);
                  e.stopPropagation();
                  showControlsTemporary();
                }}
                style={duration ? {
                  background: (() => {
                    const pos = isSeeking ? seekPreview : (seekTarget ?? currentTime);
                    const played = (pos / duration) * 100;
                    const buffered = (Math.max(bufferedEnd, pos) / duration) * 100;
                    return `linear-gradient(to right,
                      rgba(255,255,255,0.9) ${played}%,
                      rgba(255,255,255,0.4) ${played}%,
                      rgba(255,255,255,0.4) ${buffered}%,
                      rgba(255,255,255,0.2) ${buffered}%)`;
                  })(),
                } : undefined}
              />
            </div>
            <span className="vc-player-time">
              {formatTime(isSeeking ? seekPreview : (seekTarget ?? currentTime))} / {formatTime(duration)}
            </span>
          </div>
        </div>

        {/* ショートカットヘルプ */}
        {showShortcutHelp && (
          <div className="vc-player-settings-overlay" onClick={() => setShowShortcutHelp(false)}>
            <div className="vc-player-settings-panel" onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>キーボードショートカット</span>
                <button className="vc-player-btn" onClick={() => setShowShortcutHelp(false)} aria-label="閉じる">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                  </svg>
                </button>
              </div>
              {([
                ['Space / K', '再生 / 一時停止'],
                ['←', '5秒戻す'],
                ['→', '5秒進む'],
                ['↑', '音量 +10%'],
                ['↓', '音量 -10%'],
                ['M', 'ミュート切替'],
                ['F', 'フルスクリーン切替'],
              ] as [string, string][]).map(([key, desc]) => (
                <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.08)', fontSize: 13, color: '#fff' }}>
                  <kbd style={{ background: 'rgba(255,255,255,0.15)', borderRadius: 4, padding: '2px 8px', fontFamily: 'monospace', fontSize: 12 }}>{key}</kbd>
                  <span style={{ color: 'rgba(255,255,255,0.7)' }}>{desc}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 自動再生カウントダウン */}
        {nextupFile && autoplayCountdown !== null && (
          <div className="vc-autoplay-overlay">
            <div className="vc-autoplay-thumb">
              {nextupFile.thumbnailLink
                ? <img src={nextupFile.thumbnailLink} alt="" />
                : <div style={{ width: '100%', height: '100%', background: '#222' }} />
              }
            </div>
            <div className="vc-autoplay-info">
              <span className="vc-autoplay-label">次の動画</span>
              <span className="vc-autoplay-title">{nextupFile.name}</span>
              <div className="vc-autoplay-row">
                <div className="vc-autoplay-bar">
                  <div key={nextupFile.id} className="vc-autoplay-bar-fill" />
                </div>
                <span className="vc-autoplay-sec">{autoplayCountdown}秒</span>
              </div>
            </div>
            <button className="vc-autoplay-cancel" onClick={cancelAutoplay} aria-label="自動再生をキャンセル" title="キャンセル">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
            </button>
          </div>
        )}

        {/* 設定モーダル（フルスクリーン時も表示されるようコンテナ内に配置） */}
        {showSettingsMenu && (
          <div className="vc-player-settings-overlay" onClick={() => setShowSettingsMenu(false)}>
            <div className="vc-player-settings-panel" onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>設定</span>
                <button className="vc-player-btn" onClick={() => setShowSettingsMenu(false)} aria-label="閉じる">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                  </svg>
                </button>
              </div>

              <p className="vc-settings-section-label">再生速度</p>
              <div className="vc-settings-options" style={{ marginBottom: 20 }}>
                {SPEEDS.map(s => (
                  <button
                    key={s}
                    className={`vc-settings-option${s === speed ? ' vc-settings-option--active' : ''}`}
                    onClick={() => { const v = videoRef.current; if (v) v.playbackRate = s; setSpeed(s); }}
                  >
                    {s}x
                  </button>
                ))}
              </div>

              <p className="vc-settings-section-label">ダブルタップスキップ</p>
              <div className="vc-settings-options" style={{ marginBottom: 20 }}>
                {[5, 10, 15, 30].map(s => (
                  <button
                    key={s}
                    className={`vc-settings-option${s === skipSeconds ? ' vc-settings-option--active' : ''}`}
                    onClick={() => setSkipSeconds(s)}
                  >
                    {s}秒
                  </button>
                ))}
              </div>

              <p className="vc-settings-section-label">自動再生</p>
              <div className="vc-settings-options">
                <button
                  className={`vc-settings-option${autoplayNext ? ' vc-settings-option--active' : ''}`}
                  onClick={() => {
                    const next = !autoplayNext;
                    setAutoplayNext(next);
                    localStorage.setItem('vc-autoplay-next', String(next));
                    if (!next) cancelAutoplay();
                  }}
                >
                  {autoplayNext ? 'ON' : 'OFF'}
                </button>
              </div>
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 6 }}>
                動画終了後 {AUTOPLAY_SECONDS} 秒で次の動画を再生します
              </p>

            </div>
          </div>
        )}
      </div>

      {/* タイトル・タグ */}
      {videoError === 'codec' && (() => {
        const isChrome = navigator.userAgent.includes('Chrome') && !navigator.userAgent.includes('Edg');
        const isEdge = navigator.userAgent.includes('Edg/');
        const msg = isChrome
          ? 'Chrome の設定 → システム →「ハードウェアアクセラレーション」を有効にすると改善する場合があります。または Edge ブラウザをお試しください。'
          : isEdge
            ? 'Edge での再生に対応しています。映像コーデック（H.265 / HEVC など）が端末でサポートされていない可能性があります。'
            : 'このブラウザでは映像コーデック（H.265 / HEVC など）が再生できない可能性があります。Chrome または Edge をお試しください。';
        return (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 16px', background: 'rgba(234,179,8,0.15)', borderBottom: '1px solid rgba(234,179,8,0.3)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#eab308" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <p style={{ fontSize: 12, color: '#eab308', margin: 0 }}>
              映像が表示されていません（H.265 / HEVC の可能性）。{msg}
            </p>
          </div>
        );
      })()}

      <div className="vc-player-info">
        <h2 className="vc-player-title">{fileName}</h2>
        <div className="vc-card-tags" style={{ marginTop: 8 }}>
          {fileTags.map(tag => (
            <span key={tag} className="vc-tag">{tag}</span>
          ))}
          <button
            className="vc-icon-btn vc-tag-edit-btn"
            onClick={() => setShowTagModal(true)}
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

      {/* レコメンド */}
      {recLoading && (
        <div className="vc-recommendations">
          <p style={{ fontSize: 13, color: 'var(--vc-text-secondary)', margin: 0, padding: '10px 0' }}>読み込み中…</p>
        </div>
      )}
      {!recLoading && recLoadFailed && (
        <div className="vc-recommendations">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0' }}>
            <p style={{ fontSize: 13, color: 'var(--vc-text-secondary)', margin: 0 }}>おすすめ動画の読み込みに失敗しました</p>
            <button
              onClick={reloadRecommendations}
              style={{ fontSize: 12, color: 'var(--vc-accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}
            >再試行</button>
          </div>
        </div>
      )}
      {!recLoading && !recLoadFailed && (sameTagFiles.length > 0 || similarFiles.length > 0) && (
        <div className="vc-recommendations">
          {sameTagFiles.length > 0 && (
            <div className="vc-rec-section">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <p className="vc-recommendations-label">同じタグ</p>
                <button
                  onClick={() => { reloadRecommendations(); setExpandedSameTag(false); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vc-text-secondary)', padding: 2, display: 'flex', alignItems: 'center' }}
                  aria-label="同じタグを再読み込み"
                  title="再読み込み"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                  </svg>
                </button>
              </div>
              <div className="vc-rec-grid">
                {(expandedSameTag ? sameTagFiles : sameTagFiles.slice(0, REC_INITIAL)).map(f => (
                  <Link
                    key={f.id}
                    to={`/videocollect/play?id=${encodeURIComponent(f.id)}&name=${encodeURIComponent(f.name)}`}
                    className="vc-rec-card"
                  >
                    <div className="vc-rec-thumb">
                      {f.thumbnailLink
                        ? <img src={f.thumbnailLink} alt="" loading="lazy" />
                        : <div className="vc-rec-thumb-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg></div>
                      }
                      {nextupFile?.id === f.id && autoplayCountdown !== null && (
                        <div className="vc-rec-nextup-overlay">
                          <span className="vc-rec-nextup-count">{autoplayCountdown}</span>
                          <span className="vc-rec-nextup-label">次の動画</span>
                        </div>
                      )}
                    </div>
                    <p className="vc-rec-name">{f.name}</p>
                  </Link>
                ))}
              </div>
              {sameTagFiles.length > REC_INITIAL && (
                <button className="vc-rec-expand-btn" onClick={() => setExpandedSameTag(v => !v)}>
                  {expandedSameTag ? '閉じる' : `さらに ${sameTagFiles.length - REC_INITIAL} 件表示`}
                </button>
              )}
            </div>
          )}
          {similarFiles.length > 0 && (
            <div className="vc-rec-section">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <p className="vc-recommendations-label">
                  {!isSimilarFallback && !forceRandom ? '名前が似ている動画' : 'おすすめ'}
                </p>
                <button
                  onClick={() => {
                    if (!isSimilarFallback && !forceRandom) {
                      setForceRandom(true);
                      setRandomSeed(s => s + 1);
                    } else {
                      setRandomSeed(s => s + 1);
                    }
                    setExpandedSimilar(false);
                  }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--vc-text-secondary)', padding: 2, display: 'flex', alignItems: 'center' }}
                  aria-label={!isSimilarFallback && !forceRandom ? 'おすすめに切り替え' : 'おすすめをシャッフル'}
                  title={!isSimilarFallback && !forceRandom ? 'おすすめに切り替え' : 'シャッフル'}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                  </svg>
                </button>
              </div>
              <div className="vc-rec-grid">
                {(expandedSimilar ? similarFiles : similarFiles.slice(0, REC_INITIAL)).map(f => (
                  <Link
                    key={f.id}
                    to={`/videocollect/play?id=${encodeURIComponent(f.id)}&name=${encodeURIComponent(f.name)}`}
                    className="vc-rec-card"
                  >
                    <div className="vc-rec-thumb">
                      {f.thumbnailLink
                        ? <img src={f.thumbnailLink} alt="" loading="lazy" />
                        : <div className="vc-rec-thumb-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg></div>
                      }
                      {nextupFile?.id === f.id && autoplayCountdown !== null && (
                        <div className="vc-rec-nextup-overlay">
                          <span className="vc-rec-nextup-count">{autoplayCountdown}</span>
                          <span className="vc-rec-nextup-label">次の動画</span>
                        </div>
                      )}
                    </div>
                    <p className="vc-rec-name">{f.name}</p>
                  </Link>
                ))}
              </div>
              {similarFiles.length > REC_INITIAL && (
                <button className="vc-rec-expand-btn" onClick={() => setExpandedSimilar(v => !v)}>
                  {expandedSimilar ? '閉じる' : `さらに ${similarFiles.length - REC_INITIAL} 件表示`}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {showTagModal && (
        <TagModal
          file={{ id: fileId, name: fileName } as Parameters<typeof TagModal>[0]['file']}
          currentTags={fileTags}
          allTags={allTags}
          onSave={handleTagSave}
          onClose={() => setShowTagModal(false)}
        />
      )}

      {showOfflineSaveModal && videoNonce && (
        <OfflineSaveModal
          fileId={fileId}
          fileName={fileName}
          fileSize={fileSize}
          proxyUrl={proxyUrl}
          accessToken={videoNonce}
          thumbnailLink={thumbnailLink}
          onClose={() => setShowOfflineSaveModal(false)}
          addToast={addToast}
        />
      )}

      <DownloadProgressCard />
    </div>
  );
};
