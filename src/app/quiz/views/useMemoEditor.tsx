import { useState } from 'react';
import { generateMemoExplanation, MemoGenError, MEMO_GEN_ERROR_CODES } from '../memoGenerator';
import type { Problem } from '../constants';
import { Button } from '@/components/ui/button';

type AddToast = (msg: string, type?: 'normal' | 'error' | 'warning') => void;

export function useMemoEditor(
  problems: Problem[],
  onUpdateMemo: (id: string, memo: string) => void,
  addToast: AddToast,
) {
  const [editingMemoId, setEditingMemoId] = useState<string | null>(null);
  const [memoInput, setMemoInput] = useState('');
  const [generatingMemoId, setGeneratingMemoId] = useState<string | null>(null);

  const getMemo = (id: string) => problems.find(p => p.id === id)?.memo ?? '';

  const startEditMemo = (id: string) => { setEditingMemoId(id); setMemoInput(getMemo(id)); };
  const saveMemo      = (id: string) => { onUpdateMemo(id, memoInput); setEditingMemoId(null); };

  const generateMemo = async (id: string) => {
    const problem = problems.find(p => p.id === id);
    if (!problem) return;
    setEditingMemoId(id);
    setMemoInput('');
    setGeneratingMemoId(id);
    try {
      await generateMemoExplanation(problem.question, problem.answer, text => setMemoInput(text));
    } catch (e) {
      console.error('AI解説生成エラー:', e);
      const code = e instanceof MemoGenError && e.reason === 'no_api_key'
        ? MEMO_GEN_ERROR_CODES.NO_API_KEY
        : MEMO_GEN_ERROR_CODES.GENERATE;
      addToast(`AI解説の生成に失敗しました [${code}]`, 'error');
      setMemoInput('');
    } finally {
      setGeneratingMemoId(null);
    }
  };

  const renderMemo = (id: string) => {
    const isGenerating = generatingMemoId === id;
    return editingMemoId === id ? (
      <div className="qz-memo-edit">
        <textarea
          name="memo"
          className="qz-memo-input"
          value={memoInput}
          onChange={e => setMemoInput(e.target.value)}
          autoFocus={!isGenerating}
          placeholder={isGenerating ? 'AI解説を生成中...' : 'メモを入力'}
          readOnly={isGenerating}
        />
        <div className="qz-memo-edit-btns">
          <Button variant="outline" size="sm" onClick={() => { setEditingMemoId(null); setGeneratingMemoId(null); }} disabled={isGenerating}>キャンセル</Button>
          <Button variant="outline" size="sm" onClick={() => generateMemo(id)} disabled={isGenerating}>
            {isGenerating ? '生成中...' : '✨ AI解説'}
          </Button>
          <Button variant="default" size="sm" onClick={() => saveMemo(id)} disabled={isGenerating}>保存</Button>
        </div>
      </div>
    ) : (
      <div className="qz-memo-row" onClick={() => startEditMemo(id)}>
        {getMemo(id)
          ? <span className="qz-memo-text">📝 {getMemo(id)}</span>
          : <span className="qz-memo-placeholder">📝 メモを追加</span>
        }
        <button className="qz-memo-ai-btn" onClick={e => { e.stopPropagation(); generateMemo(id); }}>✨</button>
      </div>
    );
  };

  return { renderMemo };
}
