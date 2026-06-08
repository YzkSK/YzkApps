import { useState } from 'react';
import { ImageWithLoader } from './ImageWithLoader';
import {
  type ActiveSession, type OneByOneSession, type ExamSession, type Problem,
  isExamSession, isAnswerCorrect, formatElapsed,
} from '../constants';
import { useMemoEditor } from './useMemoEditor';
import { Button } from '@/components/ui/button';

type ResultFilter = 'all' | 'correct' | 'incorrect' | 'bookmarked';

type Props = {
  session: ActiveSession;
  problems: Problem[];
  onToggleBookmark: (id: string) => void;
  onUpdateMemo: (id: string, memo: string) => void;
  onEnd: () => void;
  addToast: (msg: string, type?: 'normal' | 'error' | 'warning') => void;
};

export const ResultView = ({ session, problems, onToggleBookmark, onUpdateMemo, onEnd, addToast }: Props) => {
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all');
  const { renderMemo } = useMemoEditor(problems, onUpdateMemo, addToast);

  const getBookmarked = (id: string) => problems.find(p => p.id === id)?.bookmarked ?? false;

  const filterBtns = ([['all','すべて'],['correct','✓ 正解'],['incorrect','✗ 不正解'],['bookmarked','★ ブックマーク']] as [ResultFilter, string][]).map(
    ([f, label]) => (
      <button key={f} className={`qz-filter-btn${resultFilter === f ? ' qz-filter-btn--active' : ''}`} onClick={() => setResultFilter(f)}>
        {label}
      </button>
    )
  );

  // ── 試験: reviewing ─────────────────────────────────────
  if (isExamSession(session)) {
    const s = session as ExamSession;
    const correctCount = s.queue.filter((p, i) => isAnswerCorrect(s.answers[i] ?? '', p.answer)).length;
    const elapsed = s.elapsedMs != null ? formatElapsed(s.elapsedMs) : null;

    const filtered = s.queue.map((p, i) => {
      const userAns = s.answers[i] ?? '';
      const correct = isAnswerCorrect(userAns, p.answer);
      return { p, correct, userAns };
    }).filter(({ p, correct }) => {
      if (resultFilter === 'correct')    return correct;
      if (resultFilter === 'incorrect')  return !correct;
      if (resultFilter === 'bookmarked') return getBookmarked(p.id);
      return true;
    });

    return (
      <div className="pb-6">
        <div className="text-center py-7">
          <div className="text-[52px] font-black text-[#1a1a1a] dark:text-[#e0e0e0] leading-none">{correctCount}/{s.queue.length}</div>
          <div className="text-[13px] text-[#888] mt-[6px]">正解</div>
        </div>
        {elapsed && <div className="text-center text-[13px] text-[#888] mb-5">所要時間: {elapsed}</div>}

        <div className="flex gap-[6px] mb-[14px] flex-wrap">{filterBtns}</div>

        {filtered.map(({ p, correct, userAns }) => (
          <div key={p.id} className={`qz-result-item qz-result-item--${correct ? 'ok' : 'ng'}`}>
            <div className={`qz-result-icon qz-result-icon--${correct ? 'ok' : 'ng'}`}>{correct ? '○' : '✗'}</div>
            <div className="flex-1 min-w-0">
              <div className="qz-result-qa">
                <div className="qz-result-q">
                  <div className="qz-result-qa-label">問題</div>
                  <div className={p.imageUrl ? 'qz-result-q-body' : undefined}>
                    {p.imageUrl && <ImageWithLoader src={p.imageUrl} className="qz-result-img" spinnerClassName="qz-img-spinner--thumb" />}
                    <div className="qz-result-question">{p.question}</div>
                  </div>
                </div>
                <div className="qz-result-a">
                  <div className="qz-result-qa-label">回答</div>
                  <div className={`qz-result-answer${correct ? '' : ' qz-result-answer--wrong'}`}>{userAns || '未回答'}</div>
                  {!correct && <div className="qz-result-userans">正解: {p.answer}</div>}
                </div>
              </div>
              {renderMemo(p.id)}
            </div>
            <button className="qz-result-bm-btn" onClick={() => onToggleBookmark(p.id)}>
              {getBookmarked(p.id) ? '★' : '☆'}
            </button>
          </div>
        ))}

        <div className="mt-5">
          <Button variant="default" className="w-full" onClick={onEnd}>問題一覧に戻る</Button>
        </div>
      </div>
    );
  }

  // ── 一問一答: finished ─────────────────────────────────
  const s = session as OneByOneSession;
  const correctCount = s.results.filter(Boolean).length;
  const totalCount   = s.queue.length;

  const filtered = s.queue.map((p, i) => ({
    p,
    correct:  s.results[i] as boolean | undefined,
    answered: i < s.results.length,
  })).filter(({ p, correct, answered }) => {
    if (resultFilter === 'correct')    return correct === true;
    if (resultFilter === 'incorrect')  return answered && correct === false;
    if (resultFilter === 'bookmarked') return getBookmarked(p.id);
    return true;
  });

  return (
    <div className="pb-6">
      <div className="text-center py-7">
        <div className="text-[52px] font-black text-[#1a1a1a] dark:text-[#e0e0e0] leading-none">{correctCount}/{totalCount}</div>
        <div className="text-[13px] text-[#888] mt-[6px]">正解</div>
      </div>

      <div className="flex gap-[6px] mb-[14px] flex-wrap">{filterBtns}</div>

      {filtered.map(({ p, correct, answered }) => {
        const userAns = s.answers[s.queue.indexOf(p)];
        const rowCls = !answered ? 'skip' : correct ? 'ok' : 'ng';
        return (
          <div key={p.id} className={`qz-result-item qz-result-item--${rowCls}`}>
            <div className={`qz-result-icon qz-result-icon--${!answered ? 'skip' : correct ? 'ok' : 'ng'}`}>
              {!answered ? '—' : correct ? '○' : '✗'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="qz-result-qa">
                <div className="qz-result-q">
                  <div className="qz-result-qa-label">問題</div>
                  <div className={p.imageUrl ? 'qz-result-q-body' : undefined}>
                    {p.imageUrl && <ImageWithLoader src={p.imageUrl} className="qz-result-img" spinnerClassName="qz-img-spinner--thumb" />}
                    <div className="qz-result-question">{p.question}</div>
                  </div>
                </div>
                {p.answerFormat !== 'flashcard' && answered && (
                  <div className="qz-result-a">
                    <div className="qz-result-qa-label">回答</div>
                    <div className={`qz-result-answer${correct ? '' : ' qz-result-answer--wrong'}`}>{userAns || '未回答'}</div>
                    {!correct && <div className="qz-result-userans">正解: {p.answer}</div>}
                  </div>
                )}
                {!answered && p.answerFormat !== 'flashcard' && (
                  <div className="qz-result-a">
                    <div className="qz-result-qa-label text-[#bbb]">未回答</div>
                    <div className="qz-result-userans">正解: {p.answer}</div>
                  </div>
                )}
              </div>
              {renderMemo(p.id)}
            </div>
            <button className="qz-result-bm-btn" onClick={() => onToggleBookmark(p.id)}>
              {getBookmarked(p.id) ? '★' : '☆'}
            </button>
          </div>
        );
      })}

      <div className="mt-5 flex gap-2">
        <Button variant="default" className="flex-1" onClick={onEnd}>問題一覧に戻る</Button>
      </div>
    </div>
  );
};
