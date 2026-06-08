import { useState, useEffect, useRef } from 'react';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage } from '../../shared/firebase';
import { getCachedImageUrl } from '../imageCache';
import { generateMemoExplanation, MemoGenError, MEMO_GEN_ERROR_CODES } from '../memoGenerator';
import {
  type AddModal, type EditModal, type Problem, type AnswerFormat,
  WRONG_CHOICES_COUNT, CHOICE2_OPTIONS, getErrorCode,
} from '../constants';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

type Props = {
  modal: AddModal | EditModal;
  problems: Problem[];
  allProblems: Problem[];
  answerFormat: AnswerFormat;
  uid: string;
  formError: string;
  onSave: (question: string, answer: string, category: string, wrongChoices: string[], memo: string, imageUrl: string) => boolean;
  onDelete: (id: string) => void;
  onClose: () => void;
  addToast: (msg: string) => void;
  onCleanupImages: (guardUrl: string) => void;
};

const MAX_PX = 250;

const resizeToBlob = (file: File): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_PX / img.width, MAX_PX / img.height);
      const w = Math.round(img.width  * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url); // onerror 時も revoke してメモリリークを防ぐ
      reject(e instanceof Error ? e : new Error('Image load failed'));
    };
    img.src = url;
  });

const hashBlob = async (blob: Blob): Promise<string> => {
  const hashBuffer = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
};

export const ProblemModal = ({ modal, problems, allProblems, answerFormat, uid, formError, onSave, onDelete, onClose, addToast, onCleanupImages }: Props) => {
  const [question, setQuestion]         = useState('');
  const [answer, setAnswer]             = useState('');
  const [category, setCategory]         = useState('');
  const [memo, setMemo]                 = useState('');
  const [wrongChoices, setWrongChoices] = useState<string[]>([]);
  const [existingImageUrl, setExistingImageUrl] = useState('');
  const [imageFile, setImageFile]       = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState('');
  const [imageRemoved, setImageRemoved] = useState(false);
  const [imageError, setImageError]     = useState('');
  const [uploading, setUploading]       = useState(false);
  const [generatingMemo, setGeneratingMemo] = useState(false);
  const [imgLoaded, setImgLoaded]       = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const allProblemsRef = useRef(allProblems);
  useEffect(() => { allProblemsRef.current = allProblems; }, [allProblems]);

  useEffect(() => {
    const needed = WRONG_CHOICES_COUNT[answerFormat];
    if (modal.type === 'edit') {
      const p = problems.find(p => p.id === modal.problemId);
      if (p) {
        setQuestion(p.question);
        setAnswer(p.answer);
        setCategory(p.category);
        setMemo(p.memo);
        const wc = [...p.wrongChoices];
        while (wc.length < needed) wc.push('');
        setWrongChoices(wc.slice(0, needed));
        if (p.imageUrl) {
          let cancelled = false;
          getCachedImageUrl(p.imageUrl).then(url => {
            if (cancelled) return;
            setExistingImageUrl(p.imageUrl ?? '');
            setImagePreview(url);
          }).catch(() => {
            if (cancelled) return;
            setExistingImageUrl(p.imageUrl ?? '');
            setImagePreview(p.imageUrl ?? '');
          });
          return () => { cancelled = true; };
        }
      }
    } else {
      setWrongChoices(Array(needed).fill(''));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal.type, modal.type === 'edit' ? modal.problemId : '']);

  const generateMemoFromAI = async () => {
    setGeneratingMemo(true);
    setMemo('');
    try {
      await generateMemoExplanation(question, answer, text => setMemo(text));
    } catch (e) {
      console.error('AI解説生成エラー:', e);
      const code = e instanceof MemoGenError && e.reason === 'no_api_key'
        ? MEMO_GEN_ERROR_CODES.NO_API_KEY
        : MEMO_GEN_ERROR_CODES.GENERATE;
      addToast(`AI解説の生成に失敗しました [${code}]`);
      setMemo('');
    } finally {
      setGeneratingMemo(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setImageError('画像は1MB以下にしてください');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setImageError('');
    setImageFile(file);
    setImageRemoved(false);
    setImgLoaded(true); // ローカルファイルはすぐ表示
    setImagePreview(URL.createObjectURL(file));
  };

  const handleRemoveImage = () => {
    // ローカルファイルから作成した blob URL のみ revoke する
    if (imageFile && imagePreview.startsWith('blob:')) {
      URL.revokeObjectURL(imagePreview);
    }
    setImageFile(null);
    setImagePreview('');
    setImageRemoved(true);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // アンマウント時に blob URL を revoke してメモリリークを防ぐ
  useEffect(() => {
    return () => {
      if (imageFile && imagePreview.startsWith('blob:')) {
        URL.revokeObjectURL(imagePreview);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async () => {
    let imageUrl = existingImageUrl;
    let newStoragePath: string | null = null;

    if (imageFile) {
      setUploading(true);
      try {
        const blob = await resizeToBlob(imageFile);
        const hash = await hashBlob(blob);
        const path = `quiz-images/${uid}/${hash}.png`;
        const storageRef = ref(storage, path);

        // 既存の問題と同じファイル（パス一致）があれば、そのURLを再利用してトークンを保持
        const reused = allProblemsRef.current.find(p => {
          if (!p.imageUrl) return false;
          try { return ref(storage, p.imageUrl).fullPath === path; } catch { return false; }
        });

        if (reused) {
          imageUrl = reused.imageUrl;
        } else {
          await uploadBytes(storageRef, blob);
          imageUrl = await getDownloadURL(storageRef);
          newStoragePath = path;
        }
      } catch (e) {
        addToast(`画像のアップロードに失敗しました（${getErrorCode(e)}）`);
        setUploading(false);
        return;
      }
      setUploading(false);
    } else if (imageRemoved) {
      imageUrl = '';
    }

    const success = onSave(question, answer, category, wrongChoices.map(s => s.trim()), memo, imageUrl);

    if (success) {
      // 保存成功: 古い画像を削除（新しい画像と同じパス、または他の問題で使用中でなければ）
      const editingId = modal.type === 'edit' ? modal.problemId : null;
      const existingPath = (() => { try { return ref(storage, existingImageUrl).fullPath; } catch { return null; } })();
      const newPath = imageUrl ? (() => { try { return ref(storage, imageUrl).fullPath; } catch { return null; } })() : null;
      if ((imageFile || imageRemoved) && existingImageUrl && existingPath !== newPath) {
        const usedElsewhere = existingPath !== null && allProblemsRef.current.some(p => {
          if (p.id === editingId || !p.imageUrl) return false;
          try { return ref(storage, p.imageUrl).fullPath === existingPath; } catch { return false; }
        });
        if (!usedElsewhere) {
          try { await deleteObject(ref(storage, existingImageUrl)); } catch (e) { console.warn('旧画像削除失敗:', e); }
        }
      }
      // 画像を選択した操作だった場合、孤立した画像をクリーンアップ
      if (imageFile) onCleanupImages(imageUrl);
    } else {
      // 保存失敗: 新たにアップロードした画像のみ削除してロールバック
      if (newStoragePath) {
        try { await deleteObject(ref(storage, newStoragePath)); } catch (e) { console.warn('アップロードロールバック失敗:', e); }
      }
    }
  };

  const handleWrongChoiceChange = (index: number, value: string) => {
    setWrongChoices(prev => prev.map((v, i) => i === index ? value : v));
  };

  const wrongChoiceCount = WRONG_CHOICES_COUNT[answerFormat];
  const currentPreview = imagePreview;

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[400px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {modal.type === 'add' ? '問題を追加' : '問題を編集'}
          </DialogTitle>
        </DialogHeader>

        {formError && <p className="text-sm text-red-500 mb-3">{formError}</p>}

        {/* 問題文 */}
        <div className="mb-4">
          <Label>問題文 *</Label>
          <Textarea
            className={formError && !question.trim() ? 'border-red-400' : ''}
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="問題文を入力してください"
          />
        </div>

        {/* 画像 */}
        <div className="mb-4">
          <Label>画像（任意）</Label>
          {currentPreview ? (
            <div className="qz-img-preview-wrap">
              {!imgLoaded && <div className="qz-img-spinner qz-img-spinner--preview" />}
              {imgLoaded && (
                <div className="qz-img-preview-inner">
                  <img src={currentPreview} className="qz-img-preview" alt="問題画像" />
                  <button className="qz-img-remove-btn" onClick={handleRemoveImage} type="button">✕ 削除</button>
                </div>
              )}
              {/* ロード検知用（非表示） */}
              {!imgLoaded && (
                <img src={currentPreview} className="hidden" alt=""
                  onLoad={() => setImgLoaded(true)} onError={() => setImgLoaded(true)} />
              )}
            </div>
          ) : (
            <button
              className="qz-img-upload-btn"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              ＋ 画像を選択
            </button>
          )}
          {currentPreview && (
            <Button
              variant="outline"
              size="sm"
              className="mt-1.5"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              画像を変更
            </Button>
          )}
          <input
            ref={fileInputRef}
            name="problem-image"
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
          {imageError && <p className="text-sm text-red-500 mt-1">{imageError}</p>}
        </div>

        {/* 正解 */}
        <div className="mb-4">
          <Label>{wrongChoiceCount > 0 ? '正解 *' : '答え *'}</Label>
          {answerFormat === 'choice2' ? (
            <div className="qz-mode-btns">
              {CHOICE2_OPTIONS.map(opt => (
                <button
                  key={opt}
                  type="button"
                  style={{ flex: 1 }}
                  className={`qz-mode-btn text-lg${answer === opt ? ' qz-mode-btn--active' : ''}${formError && !answer ? ' qz-mode-btn--error' : ''}`}
                  onClick={() => setAnswer(opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          ) : (
            <Input
              className={formError && !answer.trim() ? 'border-red-400' : ''}
              value={answer}
              onChange={e => setAnswer(e.target.value)}
              placeholder={wrongChoiceCount > 0 ? '正解の選択肢を入力' : '答えを入力してください'}
            />
          )}
        </div>

        {/* 不正解の選択肢（choice4） */}
        {wrongChoiceCount > 0 && (
          <div className="mb-4">
            <Label>不正解の選択肢 *</Label>
            {wrongChoices.map((wc, i) => (
              <Input
                key={i}
                className={`mb-2${formError && !wc.trim() ? ' border-red-400' : ''}`}
                value={wc}
                onChange={e => handleWrongChoiceChange(i, e.target.value)}
                placeholder={`不正解 ${i + 1}`}
              />
            ))}
          </div>
        )}

        {/* カテゴリ */}
        <div className="mb-4">
          <Label>カテゴリ（任意）</Label>
          <Input
            value={category}
            onChange={e => setCategory(e.target.value)}
            placeholder="例：数学, 英単語"
          />
        </div>

        {/* メモ */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <Label>メモ（任意）</Label>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={generateMemoFromAI}
              disabled={generatingMemo || !question.trim() || !answer.trim()}
            >
              {generatingMemo ? '生成中...' : '✨ AI解説を生成'}
            </Button>
          </div>
          <Textarea
            className="min-h-[72px]"
            value={memo}
            onChange={e => setMemo(e.target.value)}
            placeholder={generatingMemo ? 'AI解説を生成中...' : '補足・解説・覚え方など'}
            readOnly={generatingMemo}
          />
        </div>

        <div className="flex gap-2 items-center mt-5">
          {modal.type === 'edit' && (
            <Button variant="destructive" onClick={() => onDelete(modal.problemId)}>
              削除
            </Button>
          )}
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={uploading || generatingMemo}>キャンセル</Button>
          <Button variant="default" className="flex-[2]" onClick={handleSave} disabled={uploading || generatingMemo}>
            {uploading ? 'アップロード中...' : '保存'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
