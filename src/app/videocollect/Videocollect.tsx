import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { db } from '../shared/firebase';
import { useAuth } from '../auth/AuthContext';
import { usePageTitle } from '../shared/usePageTitle';
import { useToast } from '../shared/useToast';
import { useFirestoreData } from '../shared/useFirestoreData';
import { useFirestoreSave } from '../shared/useFirestoreSave';
import { AppMenu } from '../shell/AppMenu';
import { AppLayout } from '../platform/AppLayout';
import { Button } from '@/components/ui/button';
import '../shared/app.css';
import './videocollect.css';
import {
  type DriveFile,
  type DriveFolder,
  type VcData,
  type VcAuth,
  VC_INITIAL_DATA,
  firestorePaths,
  parseVcData,
  VC_ERROR_CODES,
  fetchAllDriveFiles,
  loadAccessToken,
  buildVideoQuery,
  getCachedAccessToken,
  getCachedFileList,
  cacheFileList,
  renameFile,
  trashFile,
} from './constants';
import { listOfflineSavedIds } from './offlineStorage';

import { VideoGrid } from './views/VideoGrid';
import { VideoList } from './views/VideoList';
import { FolderModal } from './modals/FolderModal';
import { FilterModal } from './modals/FilterModal';
import { TagModal } from './modals/TagModal';
import { UploadModal } from './modals/UploadModal';
import { RenameModal } from './modals/RenameModal';
import { DeleteModal } from './modals/DeleteModal';
import { DownloadProgressCard } from './DownloadProgressCard';

type PageState =
  | { status: 'unauthenticated' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'empty' }
  | { status: 'loaded'; files: DriveFile[] };

type Modal =
  | null
  | { type: 'folder' }
  | { type: 'upload' }
  | { type: 'filter' }
  | { type: 'tag'; file: DriveFile }
  | { type: 'rename'; file: DriveFile }
  | { type: 'delete'; file: DriveFile };

export const Videocollect = () => {
  const { currentUser } = useAuth();
  usePageTitle('動画');
  const { toasts, addToast } = useToast();

  const [pageState, setPageState] = useState<PageState>({ status: 'loading' });
  const [modal, setModal] = useState<Modal>(null);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<'date-desc' | 'date-asc' | 'name-asc' | 'name-desc' | 'size-desc' | 'size-asc'>('date-desc');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() =>
    (localStorage.getItem('vc-view-mode') as 'grid' | 'list') ?? 'grid',
  );
  const [playingId] = useState<string | null>(() => localStorage.getItem('vc-playing-id'));
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [offlineIds, setOfflineIds] = useState<Set<string>>(new Set());
  const [offlineOnly, setOfflineOnly] = useState(false);

  const { data, setData, loading, dbError } = useFirestoreData({
    currentUser,
    path: currentUser ? firestorePaths.vcData(currentUser.uid) : '',
    parse: parseVcData,
    loadingKey: 'vc-data',
    initialData: VC_INITIAL_DATA,
  });

  const saveData = useFirestoreSave<VcData>({
    currentUser,
    path: currentUser ? firestorePaths.vcData(currentUser.uid) : '',
  });

  useEffect(() => {
    listOfflineSavedIds()
      .then(ids => setOfflineIds(new Set(ids)))
      .catch(() => null);
  }, []);

  useEffect(() => {
    if (!currentUser) return;

    // キャッシュがあれば即座にアクセストークンをセット（Firestore 読み込みを待たない）
    const cached = getCachedAccessToken(currentUser.uid);
    if (cached) setAccessToken(cached.token);

    getDoc(doc(db, firestorePaths.vcAuth(currentUser.uid)))
      .then(snap => {
        if (!snap.exists()) {
          if (!cached) setPageState({ status: 'unauthenticated' });
          return null;
        }
        const auth = snap.data() as VcAuth;
        if (!auth.refreshToken) {
          if (!cached) setPageState({ status: 'unauthenticated' });
          return null;
        }
        return currentUser.getIdToken().then(idToken => loadAccessToken(currentUser.uid, auth, idToken));
      })
      .then(token => {
        if (token === null) return;
        if (!token) {
          if (!cached) {
            addToast(`Drive に接続できませんでした [${VC_ERROR_CODES.TOKEN_REFRESH}]`, 'error');
            setPageState({ status: 'unauthenticated' });
          }
          return;
        }
        // トークンがリフレッシュされた場合のみ更新
        if (token !== cached?.token) setAccessToken(token);
      })
      .catch(e => {
        console.error('VcAuth 読み込みエラー:', e);
        if (!cached) setPageState({ status: 'error' });
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  const fetchFiles = useCallback(async (token: string, folders: DriveFolder[], silent = false) => {
    if (!silent) setPageState({ status: 'loading' });
    try {
      const files = await fetchAllDriveFiles(token, buildVideoQuery(folders));
      if (currentUser) cacheFileList(currentUser.uid, folders, files);
      setPageState(files.length > 0 ? { status: 'loaded', files } : { status: 'empty' });
    } catch (e) {
      console.error('ファイル取得エラー:', e);
      if (!silent) {
        addToast(`動画一覧の取得に失敗しました [${VC_ERROR_CODES.FILES_FETCH}]`, 'error');
        setPageState({ status: 'error' });
      }
    }
  }, [addToast, currentUser]);

  const hasInitializedRef = useRef(false);
  const scrollRestoredRef = useRef(false);

  useEffect(() => {
    if (pageState.status !== 'loaded' || scrollRestoredRef.current) return;
    const stored = sessionStorage.getItem('vc-scroll-y');
    if (!stored) return;
    scrollRestoredRef.current = true;
    sessionStorage.removeItem('vc-scroll-y');
    const y = Number(stored);
    requestAnimationFrame(() => {
      window.scrollTo({ top: y, behavior: 'instant' });
    });
  }, [pageState.status]);

  // VcData のロード完了 + accessToken の両方が揃ったら一覧取得
  useEffect(() => {
    if (!accessToken || loading || hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    const cachedFiles = currentUser ? getCachedFileList(currentUser.uid, data.folders) : null;
    if (cachedFiles) {
      // キャッシュを即座に表示し、バックグラウンドで最新データを取得
      setPageState(cachedFiles.length > 0 ? { status: 'loaded', files: cachedFiles } : { status: 'empty' });
      fetchFiles(accessToken, data.folders, true);
    } else {
      fetchFiles(accessToken, data.folders);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, loading]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    Object.values(data.tags).forEach(tags => tags.forEach(t => set.add(t)));
    return Array.from(set).sort();
  }, [data.tags]);

  const filteredFiles = useMemo(() => {
    if (pageState.status !== 'loaded') return [];
    let files = activeTags.length > 0
      ? pageState.files.filter(f => activeTags.some(t => (data.tags[f.id] ?? []).includes(t)))
      : pageState.files;
    if (offlineOnly) files = files.filter(f => offlineIds.has(f.id));
    return [...files].sort((a, b) => {
      switch (sortKey) {
        case 'date-desc': return new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime();
        case 'date-asc':  return new Date(a.modifiedTime).getTime() - new Date(b.modifiedTime).getTime();
        case 'name-asc':  return a.name.localeCompare(b.name, 'ja');
        case 'name-desc': return b.name.localeCompare(a.name, 'ja');
        case 'size-desc': return Number(b.size ?? 0) - Number(a.size ?? 0);
        case 'size-asc':  return Number(a.size ?? 0) - Number(b.size ?? 0);
      }
    });
  }, [pageState, activeTags, data.tags, sortKey, offlineOnly, offlineIds]);

  const handleFolderSave = (folders: DriveFolder[]) => {
    const next = { ...data, folders };
    setData(next);
    saveData(next);
    setModal(null);
    if (accessToken) fetchFiles(accessToken, folders);
  };

  const handleTagSave = (file: DriveFile, tags: string[]) => {
    const next = { ...data, tags: { ...data.tags, [file.id]: tags } };
    setData(next);
    saveData(next);
    setModal(null);
  };

  const handleUploaded = () => {
    if (accessToken) fetchFiles(accessToken, data.folders);
  };

  const handleRename = async (file: DriveFile, newName: string) => {
    if (!accessToken) return;
    try {
      await renameFile(accessToken, file.id, newName);
      setPageState(prev => {
        if (prev.status !== 'loaded') return prev;
        return { ...prev, files: prev.files.map(f => f.id === file.id ? { ...f, name: newName } : f) };
      });
      setModal(null);
      addToast('ファイル名を変更しました', 'normal');
    } catch (e) {
      console.error('ファイル名変更エラー:', e);
      addToast(`ファイル名の変更に失敗しました [${VC_ERROR_CODES.RENAME}]`, 'error');
    }
  };

  const handleDelete = async (file: DriveFile) => {
    if (!accessToken) return;
    try {
      await trashFile(accessToken, file.id);
      setPageState(prev => {
        if (prev.status !== 'loaded') return prev;
        const files = prev.files.filter(f => f.id !== file.id);
        return files.length > 0 ? { ...prev, files } : { status: 'empty' };
      });
      const next = { ...data, tags: { ...data.tags } };
      delete next.tags[file.id];
      setData(next);
      saveData(next);
      setModal(null);
      addToast('ゴミ箱に移動しました', 'normal');
    } catch (e) {
      console.error('ファイル削除エラー:', e);
      addToast(`削除に失敗しました [${VC_ERROR_CODES.DELETE}]`, 'error');
    }
  };

  const vcHeader = (
    <header className="app-header">
      <div className="app-header-left">
        <AppMenu />
        <h1 className="app-page-title">動画</h1>
      </div>
    </header>
  );

  if (pageState.status === 'unauthenticated') {
    return (
      <AppLayout pageClassName="vc-page" header={vcHeader}>
        <div className="vc-unauth">
          <p className="vc-unauth-title">Google Drive が連携されていません</p>
          <p className="vc-unauth-desc">設定画面から Google Drive に接続してください</p>
          <Link to="/settings" className="vc-unauth-link">設定へ</Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout pageClassName="vc-page" className="" dbError={dbError} toasts={toasts} header={vcHeader}>
      <main style={{ padding: '16px', paddingBottom: 80 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
          <button
            className="vc-icon-btn"
            onClick={() => setModal({ type: 'folder' })}
            aria-label="フォルダ設定"
            title="フォルダ設定"
            style={{ border: '1px solid var(--vc-card-border)', borderRadius: 8, padding: '6px 10px', gap: 6 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
            </svg>
            <span style={{ fontSize: 13 }}>フォルダ</span>
          </button>
          <Button
            variant="default"
            size="sm"
            onClick={() => setModal({ type: 'upload' })}
            disabled={!accessToken}
          >
            アップロード
          </Button>
          <button
            className="vc-icon-btn"
            onClick={() => setModal({ type: 'filter' })}
            aria-label="タグで絞り込み"
            title="タグで絞り込み"
            style={{ border: '1px solid var(--vc-card-border)', borderRadius: 8, padding: '6px 10px', gap: 6, position: 'relative' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z" />
            </svg>
            <span style={{ fontSize: 13 }}>フィルター</span>
            {(activeTags.length > 0 || offlineOnly) && (
              <span style={{
                position: 'absolute', top: -6, right: -6,
                background: 'var(--vc-accent)', color: '#fff',
                fontSize: 10, fontWeight: 700, borderRadius: '99px',
                minWidth: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '0 4px',
              }}>
                {activeTags.length + (offlineOnly ? 1 : 0)}
              </span>
            )}
          </button>

          <div className="vc-view-toggle" style={{ marginLeft: 'auto' }}>
            <button
              className={`vc-view-btn${viewMode === 'grid' ? ' vc-view-btn--active' : ''}`}
              onClick={() => { setViewMode('grid'); localStorage.setItem('vc-view-mode', 'grid'); }}
              aria-label="グリッド表示"
              title="グリッド表示"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z" />
              </svg>
            </button>
            <button
              className={`vc-view-btn${viewMode === 'list' ? ' vc-view-btn--active' : ''}`}
              onClick={() => { setViewMode('list'); localStorage.setItem('vc-view-mode', 'list'); }}
              aria-label="リスト表示"
              title="リスト表示"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" />
              </svg>
            </button>
          </div>
        </div>

        {pageState.status === 'loading' && (
          <div className="vc-empty">
            <p style={{ fontSize: 14, color: 'var(--vc-text-secondary)' }}>読み込み中…</p>
          </div>
        )}
        {pageState.status === 'error' && (
          <div className="vc-empty">
            <p style={{ fontSize: 14, color: 'var(--vc-text-secondary)' }}>
              エラーが発生しました
            </p>
          </div>
        )}
        {pageState.status === 'empty' && (
          <div className="vc-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor"
              style={{ color: 'var(--vc-text-secondary)', opacity: 0.4 }}>
              <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z" />
            </svg>
            <p style={{ fontSize: 14, color: 'var(--vc-text-secondary)' }}>
              動画が見つかりませんでした
            </p>
          </div>
        )}
        {pageState.status === 'loaded' && filteredFiles.length === 0 && (activeTags.length > 0 || offlineOnly) && (
          <div className="vc-empty">
            <p style={{ fontSize: 14, color: 'var(--vc-text-secondary)', marginBottom: 8 }}>
              {offlineOnly && activeTags.length === 0
                ? 'オフライン保存済みの動画がありません'
                : '選択したフィルターに一致する動画がありません'}
            </p>
            {activeTags.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
                {activeTags.map(tag => (
                  <span key={tag} className="vc-tag">{tag}</span>
                ))}
              </div>
            )}
            <button
              style={{ marginTop: 10, fontSize: 12, color: 'var(--vc-accent)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
              onClick={() => { setActiveTags([]); setOfflineOnly(false); }}
            >フィルターを解除</button>
          </div>
        )}
        {pageState.status === 'loaded' && filteredFiles.length > 0 && viewMode === 'grid' && (
          <VideoGrid
            files={filteredFiles}
            tags={data.tags}
            accessToken={accessToken!}
            playingId={playingId}
            previewingId={previewingId}
            offlineIds={offlineIds}
            onPreviewChange={setPreviewingId}
            onTagEdit={file => setModal({ type: 'tag', file })}
            onRename={file => setModal({ type: 'rename', file })}
            onDelete={file => setModal({ type: 'delete', file })}
          />
        )}
        {pageState.status === 'loaded' && filteredFiles.length > 0 && viewMode === 'list' && (
          <VideoList
            files={filteredFiles}
            tags={data.tags}
            playingId={playingId}
            offlineIds={offlineIds}
            onTagEdit={file => setModal({ type: 'tag', file })}
            onRename={file => setModal({ type: 'rename', file })}
            onDelete={file => setModal({ type: 'delete', file })}
          />
        )}
      </main>

      {/* モーダル */}
      {modal?.type === 'filter' && (
        <FilterModal
          allTags={allTags}
          activeTags={activeTags}
          sortKey={sortKey}
          offlineOnly={offlineOnly}
          onApply={(tags, sort, offline) => { setActiveTags(tags); setSortKey(sort); setOfflineOnly(offline); }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'folder' && accessToken && (
        <FolderModal
          selectedFolders={data.folders}
          accessToken={accessToken}
          onSave={handleFolderSave}
          onClose={() => setModal(null)}
          onError={msg => addToast(msg, 'error')}
        />
      )}
      {modal?.type === 'upload' && accessToken && (
        <UploadModal
          accessToken={accessToken}
          defaultFolders={data.folders}
          onUploaded={handleUploaded}
          onClose={() => setModal(null)}
          onError={msg => addToast(msg, 'error')}
        />
      )}
      {modal?.type === 'tag' && (
        <TagModal
          file={modal.file}
          currentTags={data.tags[modal.file.id] ?? []}
          allTags={allTags}
          onSave={tags => handleTagSave(modal.file, tags)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'rename' && (
        <RenameModal
          file={modal.file}
          onRename={newName => handleRename(modal.file, newName)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'delete' && (
        <DeleteModal
          file={modal.file}
          onDelete={() => handleDelete(modal.file)}
          onClose={() => setModal(null)}
        />
      )}
      <DownloadProgressCard />
    </AppLayout>
  );
};
