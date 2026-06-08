import React, { useState, useCallback, useEffect } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useFirestoreData } from '@/app/shared/useFirestoreData';
import { useToast } from '@/app/shared/useToast';
import { usePageTitle } from '@/app/shared/usePageTitle';
import { useAuth } from '@/app/auth/AuthContext';
import { parseTranscription, type Transcription } from './constants';
import { buildTranscriptionExportData } from './exportUtils';
import { doc, deleteDoc } from 'firebase/firestore';
import { db } from '@/app/shared/firebase';
import { AppLayout } from '@/app/platform/AppLayout';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import './transcribe.css';

export const TranscribePlay: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const { addToast } = useToast();

  const transcriptionId = searchParams.get('id');

  // Firestore から詳細を読み込み
  const path = currentUser?.uid && transcriptionId ? `users/${currentUser.uid}/transcribe/transcriptions/${transcriptionId}` : 'temp';
  const { data: transcription, loading } = useFirestoreData<Transcription>({
    path,
    currentUser: currentUser || null,
    loadingKey: 'transcribe-detail',
    initialData: { transcriptionId: '', fileName: '', text: '' },
    parse: parseTranscription,
  });

  const [editText, setEditText] = useState(transcription?.text ?? '');
  const [isDirty, setIsDirty] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  usePageTitle(transcription?.fileName ?? '文字起こし');

  useEffect(() => {
    setEditText(transcription?.text ?? '');
    setIsDirty(false);
  }, [transcription?.transcriptionId, transcription?.text]);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditText(e.target.value);
    setIsDirty(true);
  };

  const onSave = useCallback(async () => {
    if (!currentUser || !transcriptionId) return;
    try {
      const path = `users/${currentUser.uid}/transcribe/transcriptions/${transcriptionId}`;
      const docRef = doc(db, path);
      const { setDoc } = await import('firebase/firestore');
      await setDoc(docRef, { ...transcription, text: editText, updatedAt: Date.now() }, { merge: true });
      addToast('保存しました', 'normal');
      setIsDirty(false);
    } catch (err: any) {
      addToast(`保存エラー: ${err?.message}`, 'error');
    }
  }, [transcription, editText, currentUser, transcriptionId, addToast]);

  const onDelete = useCallback(async () => {
    if (!currentUser || !transcriptionId) return;
    setIsDeleting(true);
    try {
      const path = `users/${currentUser.uid}/transcribe/transcriptions/${transcriptionId}`;
      await deleteDoc(doc(db, path));
      addToast('削除しました', 'normal');
      navigate('/transcribe');
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('Delete error:', err);
      addToast(`削除エラー: ${err?.message}`, 'error');
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  }, [currentUser, transcriptionId, navigate, addToast]);

  const onExportTXT = () => {
    const blob = new Blob([editText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${transcription?.fileName ?? 'transcription'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onExportJSON = () => {
    const exportData = buildTranscriptionExportData(transcription, editText);
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${transcription?.fileName ?? 'transcription'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div style={{ padding: 16 }}>読み込み中...</div>;
  if (!transcription) return <div style={{ padding: 16 }}>データが見つかりません</div>;

  return (
    <AppLayout
      title={transcription.fileName}
      className="px-[14px] pt-5 pb-[120px]"
      headerActions={(
        <div className="transcribe-play-header-actions">
          <Button asChild variant="outline" size="sm">
            <Link to="/transcribe">← 一覧</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={onSave} disabled={!isDirty} aria-label="保存">
            保存
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowExportDialog(true)} aria-label="エクスポート">
            エクスポート
          </Button>
          <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)} aria-label="削除">
            削除
          </Button>
        </div>
      )}
    >
      <div className="transcribe-play-shell">
        <section className="transcribe-play-hero" role="region" aria-labelledby="transcribe-play-title">
          <div>
            <div className="transcribe-eyebrow">Transcribe</div>
            <h2 id="transcribe-play-title" className="transcribe-play-title">文字起こしを編集・整理する</h2>
            <p className="transcribe-play-text">要約やキーワードを見ながら、本文をそのまま編集できます。</p>
          </div>
          <div className="transcribe-play-metadata">
            <div className="transcribe-play-meta-item">
              <span>言語</span>
              <strong>{transcription.language ?? 'auto'}</strong>
            </div>
            <div className="transcribe-play-meta-item">
              <span>信頼度</span>
              <strong>{(transcription.confidence ?? 0).toFixed(2)}</strong>
            </div>
            <div className="transcribe-play-meta-item">
              <span>更新</span>
              <strong>{new Date(transcription.updatedAt ?? transcription.createdAt ?? 0).toLocaleString('ja-JP')}</strong>
            </div>
          </div>
        </section>

        <div className="transcribe-play-grid">
          <section className="transcribe-play-card">
            <div className="transcribe-play-card-header">
              <div>
                <h3 className="transcribe-card-title">本文</h3>
                <p className="transcribe-card-desc">編集後は保存ボタンで Firestore に反映されます。</p>
              </div>
              {isDirty && <span className="transcribe-badge transcribe-badge--warning">未保存</span>}
            </div>

            <label htmlFor="transcribe-textarea" className="transcribe-textarea-field">
              <span className="transcribe-field-label">テキスト</span>
            </label>
            <textarea
              id="transcribe-textarea"
              aria-label="文字起こしテキスト編集"
              value={editText}
              onChange={handleTextChange}
              className="transcribe-textarea"
              placeholder="文字起こしがここに表示されます"
            />

            {isDirty && <p className="transcribe-play-note">変更があります。保存してください。</p>}
          </section>

          <aside className="transcribe-play-sidebar">
            <section className="transcribe-play-card transcribe-play-card--tight">
              <div className="transcribe-play-card-header">
                <h3 className="transcribe-card-title">要約</h3>
              </div>
              {transcription.summary ? (
                  <p className="transcribe-play-summary">{transcription.summary}</p>
                ) : (
                  <p className="transcribe-play-empty">要約はありません。</p>
                )}
            </section>

            <section className="transcribe-play-card transcribe-play-card--tight">
              <div className="transcribe-play-card-header">
                <h3 className="transcribe-card-title">キーワード</h3>
              </div>
              {transcription.keywords && transcription.keywords.length > 0 ? (
                <div className="transcribe-chip-list" role="list" aria-label="キーワード">
                  {transcription.keywords.map((kw) => (
                    <span key={kw} className="transcribe-chip" role="listitem">{kw}</span>
                  ))}
                </div>
              ) : (
                <p className="transcribe-play-empty">キーワードはありません。</p>
              )}
            </section>

            <section className="transcribe-play-card transcribe-play-card--tight">
              <div className="transcribe-play-card-header">
                <h3 className="transcribe-card-title">元ファイル</h3>
              </div>
              <div className="transcribe-play-filebox">
                <strong>{transcription.fileName}</strong>
                <span>{transcription.fileId ?? 'fileId なし'}</span>
              </div>
            </section>
          </aside>
        </div>
      </div>

      {/* エクスポート選択ダイアログ */}
      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent style={{ maxWidth: 420 }} aria-describedby={"export-desc"}>
          <DialogHeader>
            <DialogTitle>エクスポート形式を選択</DialogTitle>
          </DialogHeader>
          <p id="export-desc" style={{
            fontSize: 13,
            color: 'var(--app-text-secondary)',
            marginBottom: 16,
          }}>
            保存形式を選んでダウンロードできます。
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            <Button variant="outline" onClick={() => { onExportTXT(); setShowExportDialog(false); }}>
              TXT でエクスポート
            </Button>
            <Button variant="outline" onClick={() => { onExportJSON(); setShowExportDialog(false); }}>
              JSON でエクスポート
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 削除確認ダイアログ */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent style={{ maxWidth: 400 }} aria-describedby={"delete-desc"}>
          <DialogHeader>
            <DialogTitle>文字起こしを削除</DialogTitle>
          </DialogHeader>
          <p id="delete-desc" style={{
            fontSize: 13,
            color: 'var(--app-text-secondary)',
            marginBottom: 16,
          }}>
            この操作は取り消せません。
          </p>
          <div style={{
            fontSize: 13,
            color: 'var(--app-text)',
            marginBottom: 20,
            padding: '12px',
            backgroundColor: 'var(--app-bg-secondary)',
            borderRadius: 6,
          }}>
            <strong>{transcription?.fileName}</strong> を削除しますか？
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={isDeleting}
            >
              キャンセル
            </Button>
            <Button
              variant="default"
              onClick={onDelete}
              disabled={isDeleting}
              style={{
                backgroundColor: 'var(--app-error, #dc2626)',
                color: 'white',
              }}
            >
              {isDeleting ? '削除中...' : '削除'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
};

export default TranscribePlay;
