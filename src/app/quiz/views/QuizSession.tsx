import { useState, useEffect, useMemo } from 'react';
import { ImageWithLoader } from './ImageWithLoader';
import { ResultView } from './ResultView';
import { useExamTimer } from './useExamTimer';
import { useMemoEditor } from './useMemoEditor';
import {
  type ActiveSession, type OneByOneSession, type ExamSession, type Problem,
  isExamSession, buildProblemChoices, formatTime,
} from '../constants';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Props = {
  session: ActiveSession;
  problems: Problem[];  // 最新の bookmarked / memo 状態のために使う
  onFlashcardReveal: () => void;
  onFlashcardJudge: (correct: boolean) => void;
  onWrittenInputChange: (value: string) => void;
  onWrittenSubmit: () => void;
  onWrittenNext: (correct: boolean, answer: string) => void;
  onChoiceSelect: (option: string) => void;
  onChoiceNext: (correct: boolean, choice: string) => void;
  onExamNext: () => void;
  onExamPrev: () => void;
  onExamWrittenInputChange: (value: string) => void;
  onSubmitExam: () => void;
  onTimeUp: () => void;
  onEnd: () => void;
  onInterrupt: () => void;
  onJumpTo: (index: number) => void;
  onToggleBookmark: (id: string) => void;
  onUpdateMemo: (id: string, memo: string) => void;
  addToast: (msg: string, type?: 'normal' | 'error' | 'warning') => void;
};

export const QuizSession = ({
  session, problems,
  onFlashcardReveal, onFlashcardJudge,
  onWrittenInputChange, onWrittenSubmit, onWrittenNext,
  onChoiceSelect, onChoiceNext,
  onExamNext, onExamPrev, onExamWrittenInputChange,
  onSubmitExam, onTimeUp,
  onEnd, onInterrupt, onJumpTo, onToggleBookmark, onUpdateMemo, addToast,
}: Props) => {
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null);
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [showSheet, setShowSheet] = useState(true);

  const isExam = isExamSession(session);
  const remainingMs = useExamTimer(session, onTimeUp);
  const { renderMemo } = useMemoEditor(problems, onUpdateMemo, addToast);

  const getBookmarked = (id: string) => problems.find(p => p.id === id)?.bookmarked ?? false;

  // selectedChoice を currentIndex が変わるたびにリセット・復元
  useEffect(() => {
    if (isExam && session.phase === 'answering') {
      const prev = (session as ExamSession).answers[session.currentIndex];
      setSelectedChoice(prev || null);
    } else {
      setSelectedChoice(null);
    }
  }, [session.currentIndex]);

  // 一問一答: 現在の問題
  const oneByOneQ = !isExam ? session.queue[session.currentIndex] : null;
  // 試験: 現在の問題
  const examQ = isExam ? session.queue[session.currentIndex] : null;
  const currentQ = oneByOneQ ?? examQ;

  // 一問一答: choice オプション（安定化）
  const oneByOneChoiceOptions = useMemo(() => {
    if (isExam || !oneByOneQ) return [];
    if (oneByOneQ.answerFormat === 'choice2' || oneByOneQ.answerFormat === 'choice4') {
      return buildProblemChoices(oneByOneQ);
    }
    return [];
  }, [isExam ? null : session.currentIndex]);

  // 試験: choice オプション（セッション開始時に全問分生成済み）
  const examChoiceOptions = isExam ? ((session as ExamSession).choiceOptionsMap[session.currentIndex] ?? []) : [];
  const choiceOptions = isExam ? examChoiceOptions : oneByOneChoiceOptions;

  // チェックシート
  const renderSheet = () => {
    if (!isExam && (session as OneByOneSession).phase === 'finished') return null;
    if (isExam && session.phase === 'reviewing') return null;

    return (
      <div className="qz-sheet">
        <button className="qz-sheet-header" onClick={() => setShowSheet(v => !v)}>
          <span className="qz-sheet-title">回答進捗</span>
          <span className="qz-sheet-toggle-icon">{showSheet ? '▼' : '▲'}</span>
        </button>
        {showSheet && (
          <div className="qz-sheet-inner">
            {session.queue.map((p, i) => {
              let cls = 'qz-sheet-cell';
              if (i === session.currentIndex) cls += ' qz-sheet-cell--current';
              else if (!isExam) {
                const results = (session as OneByOneSession).results;
                if (i < results.length) {
                  cls += results[i] ? ' qz-sheet-cell--correct' : ' qz-sheet-cell--wrong';
                }
              } else {
                if ((session as ExamSession).answers[i]) cls += ' qz-sheet-cell--answered';
              }
              if (isExam) cls += ' qz-sheet-cell--clickable';
              const bm = getBookmarked(p.id);
              return (
                <div key={p.id} className={cls} onClick={isExam ? () => onJumpTo(i) : undefined}>
                  {i + 1}
                  {bm && <span className="qz-sheet-bm">★</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // ── 結果画面（一問一答 finished / 試験 reviewing）──────────
  const oneByOnePhase = !isExam ? (session as OneByOneSession).phase : null;
  if ((!isExam && oneByOnePhase === 'finished') || (isExam && session.phase === 'reviewing')) {
    return (
      <ResultView
        session={session}
        problems={problems}
        onToggleBookmark={onToggleBookmark}
        onUpdateMemo={onUpdateMemo}
        onEnd={onEnd}
        addToast={addToast}
      />
    );
  }

  if (!currentQ) return null;

  const isAnswering = session.phase === 'answering';
  const isRevealed  = !isExam && oneByOnePhase === 'revealed';
  const method      = currentQ.answerFormat;
  const bookmarked  = getBookmarked(currentQ.id);

  // ── 試験: answering ─────────────────────────────────────
  if (isExam) {
    const s = session as ExamSession;
    const totalQ        = s.queue.length;
    const answeredCount = s.answers.filter(a => a !== '').length;
    const isWritten     = method === 'written';
    const isChoice      = method === 'choice2' || method === 'choice4';
    const isFlashcard   = method === 'flashcard';
    const canNext       = isFlashcard || isWritten || (isChoice && !!selectedChoice);

    const handleChoiceClick = (opt: string) => {
      setSelectedChoice(opt);
      onChoiceSelect(opt);
    };

    return (
      <>
        {/* タイマーヘッダー */}
        <div className="flex items-center justify-between mb-[14px]">
          <div className={`qz-timer${remainingMs < 5 * 60 * 1000 ? ' qz-timer--warning' : ''}`}>
            {formatTime(remainingMs)}
          </div>
          <div className="flex gap-2 items-center">
            <span className="text-[13px] text-[#888] font-semibold">{answeredCount}/{totalQ} 回答済み</span>
            <Button variant="default" size="sm" onClick={() => {
              const unanswered = s.answers.filter(a => a === '').length;
              if (unanswered > 0) setShowSubmitConfirm(true);
              else onSubmitExam();
            }}>提出する</Button>
          </div>
        </div>

        <Progress value={(s.currentIndex / totalQ) * 100} className="mb-5" />

        <button
          className={`qz-bookmark-row${bookmarked ? ' qz-bookmark-row--active' : ''}`}
          onClick={() => onToggleBookmark(currentQ.id)}
        >
          {bookmarked ? '★ ブックマーク済み' : '☆ ブックマークに追加'}
        </button>

        <div className="qz-card">
          <div className="qz-card-label">問 {s.currentIndex + 1}</div>
          <div className={currentQ.imageUrl ? 'qz-card-body' : undefined}>
            {currentQ.imageUrl && <ImageWithLoader src={currentQ.imageUrl} className="qz-card-img-side" />}
            <div className="qz-card-question">{currentQ.question}</div>
          </div>
        </div>

        {isWritten && (
          <textarea
            name="exam-answer"
            className="qz-written-input"
            value={s.answers[s.currentIndex] ?? ''}
            onChange={e => onExamWrittenInputChange(e.target.value)}
            placeholder="答えを入力（空欄でスキップ）"
          />
        )}

        {isChoice && (
          <div className={`qz-choices${method === 'choice2' ? ' qz-choices--row' : ''}`}>
            {choiceOptions.map((opt) => (
              <button
                key={opt}
                className={`qz-choice-btn${selectedChoice === opt ? ' qz-choice-btn--selected' : ''}`}
                onClick={() => handleChoiceClick(opt)}
              >
                {opt}
              </button>
            ))}
          </div>
        )}

        <div className="flex gap-2 items-center">
          {s.currentIndex > 0 && (
            <Button variant="outline" onClick={onExamPrev}>← 前の問題</Button>
          )}
          <Button
            variant="default"
            className="flex-1"
            onClick={s.currentIndex === totalQ - 1
              ? () => {
                  const unanswered = s.answers.filter(a => a === '').length;
                  if (unanswered > 0) setShowSubmitConfirm(true);
                  else onSubmitExam();
                }
              : onExamNext}
            disabled={!canNext}
          >
            {s.currentIndex === totalQ - 1 ? '提出する' : '次の問題 →'}
          </Button>
        </div>

        {renderSheet()}

        {showSubmitConfirm && (() => {
          const unansweredNums = s.answers
            .map((a, i) => a === '' ? i + 1 : null)
            .filter((n): n is number => n !== null);
          return (
            <Dialog open={true} onOpenChange={() => setShowSubmitConfirm(false)}>
              <DialogContent aria-describedby={undefined}>
                <DialogHeader>
                  <DialogTitle>未回答の問題があります</DialogTitle>
                </DialogHeader>
                <p className="text-sm text-gray-500 mb-1">
                  以下の問題が未回答のまま提出されます。このまま提出しますか？
                </p>
                <div className="flex flex-wrap gap-1.5 mb-4">
                  {unansweredNums.map(n => (
                    <span
                      key={n}
                      className="text-xs font-bold px-2 py-1 rounded bg-[#f3f4f6] dark:bg-[#333] text-[#1a1a1a] dark:text-[#e0e0e0] cursor-pointer hover:bg-[#e5e7eb] dark:hover:bg-[#444]"
                      onClick={() => { onJumpTo(n - 1); setShowSubmitConfirm(false); }}
                      title={`問題 ${n} へ移動`}
                    >
                      {n}
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={() => setShowSubmitConfirm(false)}>戻る</Button>
                  <Button variant="default" className="flex-1" onClick={() => { setShowSubmitConfirm(false); onSubmitExam(); }}>提出する</Button>
                </div>
              </DialogContent>
            </Dialog>
          );
        })()}
      </>
    );
  }

  // ── 一問一答 ────────────────────────────────────────────
  const s = session as OneByOneSession;
  const totalQ   = s.queue.length;
  const progress = s.currentIndex + 1;

  return (
    <>
      <div className="flex items-center justify-between mb-[14px]">
        <div className="text-[13px] text-[#888] font-semibold">{progress} / {totalQ}</div>
        <Button variant="outline" size="sm" onClick={onInterrupt}>中断</Button>
      </div>

      <Progress value={(progress / totalQ) * 100} className="mb-5" />

      <button
        className={`qz-bookmark-row${bookmarked ? ' qz-bookmark-row--active' : ''}`}
        onClick={() => onToggleBookmark(currentQ.id)}
      >
        {bookmarked ? '★ ブックマーク済み' : '☆ ブックマークに追加'}
      </button>

      {/* フラッシュカード */}
      {method === 'flashcard' && (
        <>
          <div className={`qz-card${isRevealed ? ' qz-card--flip' : ''}`}>
            <div className="qz-card-label">問題</div>
            <div className={currentQ.imageUrl ? 'qz-card-body' : undefined}>
              {currentQ.imageUrl && <ImageWithLoader src={currentQ.imageUrl} className="qz-card-img-side" />}
              <div className="qz-card-question">{currentQ.question}</div>
            </div>
            {isRevealed && (
              <div className="qz-card-answer">
                <div className="qz-card-answer-label">答え</div>
                <div className="qz-card-answer-text">{currentQ.answer}</div>
              </div>
            )}
          </div>
          {isAnswering && (
            <Button variant="default" className="w-full" onClick={onFlashcardReveal}>
              答えを見る
            </Button>
          )}
          {isRevealed && (
            <>
              {renderMemo(currentQ.id)}
              <div className="flex gap-2 mt-1">
                <button className="qz-judge-btn qz-judge-btn--incorrect" onClick={() => onFlashcardJudge(false)}>✗ 不正解</button>
                <button className="qz-judge-btn qz-judge-btn--correct"   onClick={() => onFlashcardJudge(true)}>✓ 正解</button>
              </div>
            </>
          )}
        </>
      )}

      {/* 記述式 */}
      {method === 'written' && (
        <>
          <div className="qz-card">
            <div className="qz-card-label">問題</div>
            <div className={currentQ.imageUrl ? 'qz-card-body' : undefined}>
              {currentQ.imageUrl && <ImageWithLoader src={currentQ.imageUrl} className="qz-card-img-side" />}
              <div className="qz-card-question">{currentQ.question}</div>
            </div>
          </div>
          {isAnswering && (
            <>
              <textarea
                name="written-answer"
                className="qz-written-input"
                value={s.writtenInput}
                onChange={e => onWrittenInputChange(e.target.value)}
                placeholder="答えを入力してください"
                autoFocus
              />
              <Button variant="default" className="w-full" onClick={onWrittenSubmit}>
                回答する
              </Button>
            </>
          )}
          {isRevealed && (
            <>
              <div className={`qz-written-result qz-written-result--${s.pendingResult ? 'correct' : 'incorrect'}`}>
                {s.pendingResult ? '✓ 正解' : '✗ 不正解'}
              </div>
              <div className="qz-written-compare">
                あなたの回答: <span>{s.writtenInput || '未回答'}</span>
              </div>
              <div className="qz-written-compare">
                正解: <span>{currentQ.answer}</span>
              </div>
              {renderMemo(currentQ.id)}
              <Button variant="default" className="w-full" onClick={() => onWrittenNext(!!s.pendingResult, s.writtenInput)}>
                次へ
              </Button>
            </>
          )}
        </>
      )}

      {/* 2択 / 4択 */}
      {(method === 'choice2' || method === 'choice4') && (
        <>
          <div className="qz-card">
            <div className="qz-card-label">問題</div>
            <div className={currentQ.imageUrl ? 'qz-card-body' : undefined}>
              {currentQ.imageUrl && <ImageWithLoader src={currentQ.imageUrl} className="qz-card-img-side" />}
              <div className="qz-card-question">{currentQ.question}</div>
            </div>
          </div>
          <div className={`qz-choices${method === 'choice2' ? ' qz-choices--row' : ''}`}>
            {choiceOptions.map((opt) => {
              let cls = 'qz-choice-btn';
              if (isRevealed) {
                if (opt === currentQ.answer)    cls += ' qz-choice-btn--correct';
                else if (opt === selectedChoice) cls += ' qz-choice-btn--incorrect';
              } else if (opt === selectedChoice) {
                cls += ' qz-choice-btn--selected';
              }
              return (
                <button
                  key={opt}
                  className={cls}
                  disabled={isRevealed}
                  onClick={() => {
                    if (isAnswering) {
                      setSelectedChoice(opt);
                      onChoiceSelect(opt);
                    }
                  }}
                >
                  {opt}
                </button>
              );
            })}
          </div>
          {isAnswering && (
            <Button
              variant="default"
              className="w-full"
              disabled={!selectedChoice}
              onClick={onFlashcardReveal}
            >
              答えを見る
            </Button>
          )}
          {isRevealed && (
            <>
              {renderMemo(currentQ.id)}
              <Button variant="default" className="w-full" onClick={() => onChoiceNext(selectedChoice === currentQ.answer, selectedChoice ?? '')}>
                次へ
              </Button>
            </>
          )}
        </>
      )}

      {renderSheet()}
    </>
  );
};
