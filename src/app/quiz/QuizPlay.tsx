import { useState, useEffect, useRef, useCallback } from 'react';
import { useToast } from '../shared/useToast';
import { useAuth } from '../auth/AuthContext';
import { useNavigate, useSearchParams, useBlocker } from 'react-router-dom';
import '../shared/app.css';
import './quiz.css';
import {
  TOAST_DURATION_MS, EXAM_TIME_LIMIT_MS, EXAM_MAX_PROBLEMS, MASTER_THRESHOLD,
  MAX_RECENT, RECENT_INITIAL_SHOW,
  shuffle, filterProblems, buildProblemChoices, isAnswerCorrect, isWeak, isExamSession, isInvalidProblem,
  getCategories, newProblemSet, parseProblem, parseProblemSet, parseRecentConfig, firestorePaths,
  QUIZ_MODE_LABELS, formatRelativeTime, getInvalidCount,
  type Problem, type ProblemSet, type RecentConfig, type ActiveSession, type QuizSessionConfig,
  type OneByOneSession, type ExamSession, type QuizMode,
} from './constants';
import { useFirestoreData } from '../shared/useFirestoreData';
import { useFirestoreSave } from '../shared/useFirestoreSave';
import { QuizSession } from './views/QuizSession';
import { Button } from '@/components/ui/button';
import { AppMenu } from '../shell/AppMenu';
import { usePageTitle } from '../shared/usePageTitle';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AppLayout } from '../platform/AppLayout';

type QuizPlayData = { sets: ProblemSet[]; recentConfigs: RecentConfig[] };

export const QuizPlay = () => {
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  usePageTitle('問題集');

  const [showAllRecent, setShowAllRecent]   = useState(false);
  const initSetId = searchParams.get('set');
  const [selectedSetIds, setSelectedSetIds] = useState<string[]>(initSetId ? [initSetId] : []);
  const [configConfirmed, setConfigConfirmed] = useState(false);
  const [session, setSession]               = useState<ActiveSession | null>(null);
  const { toasts, addToast }                = useToast(TOAST_DURATION_MS);
  const setsRef = useRef<ProblemSet[]>([]);

  const [categoryFilter, setCategoryFilter] = useState('');
  const [quizMode, setQuizMode]             = useState<QuizMode>('oneByOne');

  const saveToFirestore = useFirestoreSave<QuizPlayData>({
    currentUser,
    path: firestorePaths.quizData(currentUser?.uid ?? ''),
  });

  const { data, setData, loading, dbError } = useFirestoreData<QuizPlayData>({
    currentUser,
    path: firestorePaths.quizData(currentUser?.uid ?? ''),
    parse: (raw) => {
      let sets: ProblemSet[];
      if (Array.isArray(raw.sets)) {
        sets = (raw.sets as Record<string, unknown>[]).map(parseProblemSet);
      } else if (Array.isArray(raw.problems)) {
        const migrated = newProblemSet('問題集');
        migrated.problems = (raw.problems as Record<string, unknown>[]).map(parseProblem);
        sets = [migrated];
      } else {
        sets = [];
      }
      const recentConfigs = Array.isArray(raw.recentConfigs)
        ? (raw.recentConfigs as Record<string, unknown>[]).map(parseRecentConfig)
        : [];
      return { sets, recentConfigs };
    },
    loadingKey: 'quizplay',
    initialData: { sets: [], recentConfigs: [] },
  });

  const sets = data.sets;
  const recentConfigs = data.recentConfigs;
  const setSets = useCallback((updater: ProblemSet[] | ((prev: ProblemSet[]) => ProblemSet[])) => {
    setData(prev => ({
      ...prev,
      sets: typeof updater === 'function' ? updater(prev.sets) : updater,
    }));
  }, [setData]);
  const setRecentConfigs = useCallback((recents: RecentConfig[]) => {
    setData(prev => ({ ...prev, recentConfigs: recents }));
  }, [setData]);

  setsRef.current = sets;

  // ── 選択中のセット・問題 ──────────────────────────────────
  const selectedSets = sets.filter(s => selectedSetIds.includes(s.id));
  const problems     = selectedSets.flatMap(s => s.problems);

  const toggleSetSelection = (id: string) => {
    setSelectedSetIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const applyRecentConfig = (config: RecentConfig) => {
    const validIds = config.setIds.filter(id => sets.some(s => s.id === id));
    if (validIds.length === 0) { addToast('選択された問題集が見つかりません'); return; }
    setSelectedSetIds(validIds);
    setQuizMode(config.mode);
    setCategoryFilter(config.categoryFilter);
    setConfigConfirmed(true);
  };

  // ── 問題更新（複数セット横断）─────────────────────────────
  const updateProblemInSets = useCallback((id: string, updater: (p: Problem) => Problem) => {
    setData(prev => {
      const nextSets = prev.sets.map(s => ({ ...s, problems: s.problems.map(p => p.id === id ? updater(p) : p) }));
      saveToFirestore({ sets: nextSets, recentConfigs: prev.recentConfigs });
      return { ...prev, sets: nextSets };
    });
  }, [saveToFirestore, setData]);

  const recordResult = useCallback((entries: { id: string; correct: boolean }[]) => {
    const mastered: string[] = [];
    const next = setsRef.current.map(s => ({
      ...s,
      problems: s.problems.map(p => {
        const entry = entries.find(e => e.id === p.id);
        if (!entry) return p;
        const consecutive = entry.correct ? p.consecutiveCorrect + 1 : 0;
        const consecutiveWrong = entry.correct ? 0 : p.consecutiveWrong + 1;
        // 不正解経験あり (attemptCount > consecutiveCorrect) の問題がちょうど5連続正解に達したときのみトースト
        if (consecutive === MASTER_THRESHOLD && p.attemptCount > p.consecutiveCorrect) {
          mastered.push(p.question);
        }
        return { ...p, consecutiveCorrect: consecutive, consecutiveWrong, correctCount: p.correctCount + (entry.correct ? 1 : 0), attemptCount: p.attemptCount + 1 };
      }),
    }));
    setSets(next);
    setsRef.current = next;
    mastered.forEach(q => addToast(`「${q.length > 15 ? q.slice(0, 15) + '…' : q}」をマスターしました！`));
    saveToFirestore({ sets: next, recentConfigs: data.recentConfigs });
  }, [saveToFirestore, setSets, data.recentConfigs]);

  const toggleBookmark  = (id: string) => updateProblemInSets(id, p => ({ ...p, bookmarked: !p.bookmarked }));
  const handleUpdateMemo = (id: string, memo: string) => updateProblemInSets(id, p => ({ ...p, memo }));

  // ── セッション設定 ──────────────────────────────────────
  const categories  = getCategories(problems);
  const weakCount   = problems.filter(isWeak).length;
  const targetCount = filterProblems(problems, categoryFilter).length;

  const startSession = (config: QuizSessionConfig) => {
    const filtered = filterProblems(problems, config.categoryFilter).filter(p => !isInvalidProblem(p));
    if (filtered.length === 0) { addToast('対象の問題がありません'); return; }

    // 直近の記録を保存
    const newRecent: RecentConfig = {
      id: crypto.randomUUID(),
      setIds: selectedSetIds,
      setNames: selectedSets.map(s => s.name),
      mode: config.mode,
      categoryFilter: config.categoryFilter,
      usedAt: Date.now(),
    };
    const deduped = recentConfigs.filter(c =>
      !(c.setIds.length === selectedSetIds.length &&
        c.setIds.every(id => selectedSetIds.includes(id)) &&
        c.mode === config.mode &&
        c.categoryFilter === config.categoryFilter)
    );
    const updatedRecents = [newRecent, ...deduped].slice(0, MAX_RECENT);
    setRecentConfigs(updatedRecents);
    saveToFirestore({ sets, recentConfigs: updatedRecents });

    if (config.mode === 'oneByOne') {
      setSession({
        mode: 'oneByOne', config,
        queue: shuffle(filtered), currentIndex: 0, results: [], answers: [],
        phase: 'answering', writtenInput: '', pendingResult: null,
      } as OneByOneSession);
    } else {
      const queue = shuffle(filtered).slice(0, EXAM_MAX_PROBLEMS);
      const choiceOptionsMap: Record<number, string[]> = {};
      queue.forEach((p, i) => {
        if (p.answerFormat === 'choice2' || p.answerFormat === 'choice4') {
          choiceOptionsMap[i] = buildProblemChoices(p);
        }
      });
      setSession({
        mode: 'exam', config,
        queue, currentIndex: 0,
        answers: new Array(queue.length).fill(''),
        phase: 'answering', choiceOptionsMap,
        startedAt: Date.now(), timeLimit: EXAM_TIME_LIMIT_MS, elapsedMs: null,
      } as ExamSession);
    }
  };

  // ── 一問一答ハンドラー ────────────────────────────────
  const handleFlashcardReveal = () =>
    setSession(s => s && !isExamSession(s) ? { ...s, phase: 'revealed' } : s);

  const advanceOneByOne = (correct: boolean, answer: string) => {
    if (!session || isExamSession(session)) return;
    const problemId = session.queue[session.currentIndex].id;
    recordResult([{ id: problemId, correct }]);
    setSession(prev => {
      if (!prev || isExamSession(prev)) return prev;
      const results = [...prev.results, correct];
      const answers = [...prev.answers, answer];
      const next = prev.currentIndex + 1;
      if (next >= prev.queue.length)
        return { ...prev, results, answers, phase: 'finished' as OneByOneSession['phase'] };
      return { ...prev, results, answers, currentIndex: next, phase: 'answering', writtenInput: '', pendingResult: null };
    });
  };

  const handleFlashcardJudge     = (correct: boolean) => advanceOneByOne(correct, '');
  const handleWrittenInputChange = (value: string) =>
    setSession(s => s && !isExamSession(s) ? { ...s, writtenInput: value } : s);
  const handleWrittenSubmit = () =>
    setSession(prev => {
      if (!prev || isExamSession(prev)) return prev;
      const correct = isAnswerCorrect(prev.writtenInput, prev.queue[prev.currentIndex].answer);
      return { ...prev, phase: 'revealed', pendingResult: correct };
    });
  const handleWrittenNext  = (correct: boolean, answer: string) => advanceOneByOne(correct, answer);
  const handleChoiceSelect = (option: string) =>
    setSession(prev => {
      if (!prev || !isExamSession(prev)) return prev;
      const answers = [...prev.answers];
      answers[prev.currentIndex] = option;
      return { ...prev, answers };
    });
  const handleChoiceNext = (correct: boolean, choice: string) => advanceOneByOne(correct, choice);

  // ── 試験ハンドラー ─────────────────────────────────────
  const moveToReviewing = (s: ExamSession): ExamSession => {
    const elapsedMs = Date.now() - s.startedAt;
    recordResult(s.queue.map((p, i) => ({ id: p.id, correct: isAnswerCorrect(s.answers[i] ?? '', p.answer) })));
    return { ...s, phase: 'reviewing', elapsedMs };
  };

  const handleExamNext = () =>
    setSession(prev => {
      if (!prev || !isExamSession(prev)) return prev;
      const next = prev.currentIndex + 1;
      return next >= prev.queue.length ? moveToReviewing(prev) : { ...prev, currentIndex: next };
    });
  const handleExamPrev = () =>
    setSession(prev =>
      prev && isExamSession(prev) ? { ...prev, currentIndex: Math.max(0, prev.currentIndex - 1) } : prev
    );
  const handleExamWrittenInputChange = (value: string) =>
    setSession(prev => {
      if (!prev || !isExamSession(prev)) return prev;
      const answers = [...prev.answers];
      answers[prev.currentIndex] = value;
      return { ...prev, answers };
    });
  const handleSubmitExam = () =>
    setSession(prev => prev && isExamSession(prev) ? moveToReviewing(prev) : prev);
  const handleTimeUp = () => {
    addToast('時間終了！');
    setSession(prev => prev && isExamSession(prev) ? moveToReviewing(prev) : prev);
  };
  const handleJumpTo = (index: number) =>
    setSession(prev => prev && isExamSession(prev) ? { ...prev, currentIndex: index } : prev);

  const endSession = () => setSession(null);
  const handleInterrupt = () =>
    setSession(prev => prev && !isExamSession(prev) ? { ...prev, phase: 'finished' as OneByOneSession['phase'] } : prev);

  // セッション進行中（answering / revealed）かどうか
  const isSessionInProgress =
    session !== null &&
    session.phase !== 'finished' &&
    session.phase !== 'reviewing';

  // React Router のナビゲーションをブロック
  const blocker = useBlocker(isSessionInProgress);

  // ブラウザのリロード・タブ閉じをブロック
  useEffect(() => {
    if (!isSessionInProgress) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isSessionInProgress]);

  if (loading) return null;

  const playHeader =
    session !== null ? (
      <header className="app-header">
        <div className="app-header-left">
          <AppMenu />
          <h1 className="app-page-title">{session.mode === 'oneByOne' ? '一問一答' : '試験'}</h1>
        </div>
      </header>
    ) : configConfirmed ? (
      <header className="app-header">
        <div className="app-header-left">
          <AppMenu />
          <h1 className="app-page-title">{selectedSets.map(s => s.name).join(' + ')}</h1>
        </div>
        <div className="app-header-actions">
          <Button variant="outline" onClick={() => setConfigConfirmed(false)}>← 戻る</Button>
        </div>
      </header>
    ) : (
      <header className="app-header">
        <div className="app-header-left">
          <AppMenu />
          <h1 className="app-page-title">出題する</h1>
        </div>
        <div className="app-header-actions">
          <Button variant="outline" onClick={() => navigate('/quiz')}>← 問題集一覧</Button>
        </div>
      </header>
    );

  return (
    <AppLayout
      className="px-[14px] pt-5 pb-[120px]"
      dbError={dbError}
      toasts={toasts}
      header={playHeader}
    >

      <div className="max-w-[640px] mx-auto">
        {session !== null ? (
          // ── 回答中 ─────────────────────────────────────
          <>
            <QuizSession
              session={session}
              problems={problems}
              onFlashcardReveal={handleFlashcardReveal}
              onFlashcardJudge={handleFlashcardJudge}
              onWrittenInputChange={handleWrittenInputChange}
              onWrittenSubmit={handleWrittenSubmit}
              onWrittenNext={handleWrittenNext}
              onChoiceSelect={handleChoiceSelect}
              onChoiceNext={handleChoiceNext}
              onExamNext={handleExamNext}
              onExamPrev={handleExamPrev}
              onExamWrittenInputChange={handleExamWrittenInputChange}
              onSubmitExam={handleSubmitExam}
              onTimeUp={handleTimeUp}
              onEnd={endSession}
              onInterrupt={handleInterrupt}
              onJumpTo={handleJumpTo}
              onToggleBookmark={toggleBookmark}
              onUpdateMemo={handleUpdateMemo}
              addToast={addToast}
            />
          </>
        ) : configConfirmed ? (
          // ── 出題設定 ──────────────────────────────────
          <>
            <div className="bg-white dark:bg-[#1a1a1a] border border-[#e8e8e8] dark:border-[#333] rounded-[14px] p-[18px_16px] mb-5">
              <div className="text-[12px] font-bold text-[#888] mb-3 uppercase tracking-[0.05em]">出題設定</div>

              <div className="mb-[14px]">
                <div className="text-[11px] text-[#888] font-semibold mb-[6px]">問題フィルター</div>
                <select
                  name="category-filter"
                  className="w-full px-3 py-[9px] border-[1.5px] border-[#e0e0e0] dark:border-[#444] rounded-[9px] bg-white dark:bg-[#222] text-[13px] text-[#1a1a1a] dark:text-[#e0e0e0] font-semibold cursor-pointer appearance-none outline-none focus:border-[#1a1a1a] dark:focus:border-[#888]"
                  value={categoryFilter}
                  onChange={e => setCategoryFilter(e.target.value)}
                >
                  <option value="">すべて ({problems.length}件)</option>
                  <option value="BOOKMARKED">★ ブックマーク</option>
                  {weakCount > 0 && <option value="WEAK">⚡ 苦手問題 ({weakCount}件)</option>}
                  {categories.map(c => (
                    <option key={c} value={c}>{c} ({problems.filter(p => p.category === c).length}件)</option>
                  ))}
                </select>
              </div>

              <div className="mb-[14px]">
                <div className="text-[11px] text-[#888] font-semibold mb-[6px]">モード</div>
                <div className="qz-mode-btns">
                  {(['oneByOne', 'exam'] as QuizMode[]).map(m => (
                    <button
                      key={m}
                      className={`qz-mode-btn${quizMode === m ? ' qz-mode-btn--active' : ''}`}
                      onClick={() => setQuizMode(m)}
                    >
                      {QUIZ_MODE_LABELS[m]}
                      {m === 'exam' && <span className="text-[10px] opacity-70 block">最大50問・50分</span>}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between mt-4 pt-[14px] border-t border-[#f0f0f0] dark:border-[#333]">
                <div className="text-[13px] text-[#888] font-semibold">対象: {targetCount}件</div>
                <Button
                  variant="default"
                  onClick={() => startSession({ mode: quizMode, categoryFilter })}
                  disabled={targetCount === 0}
                >
                  出題開始
                </Button>
              </div>
            </div>
          </>
        ) : (
          // ── 問題集選択 ────────────────────────────────
          <>
            {/* 直近の記録 */}
            {recentConfigs.length > 0 && (
              <div className="mb-5">
                <div className="text-[11px] font-bold text-[#aaa] uppercase tracking-[0.06em] mb-2">直近の記録</div>
                {(showAllRecent ? recentConfigs : recentConfigs.slice(0, RECENT_INITIAL_SHOW)).map(config => {
                  const validCount = config.setIds.filter(id => sets.some(s => s.id === id)).length;
                  return (
                    <div key={config.id} className="qz-recent-item" onClick={() => applyRecentConfig(config)}>
                      <div className="qz-recent-main">
                        <div className="qz-recent-names">{config.setNames.join(' + ')}</div>
                        <div className="qz-recent-meta">
                          {QUIZ_MODE_LABELS[config.mode]}
                          {config.categoryFilter && ` · ${config.categoryFilter}`}
                          {validCount < config.setIds.length && <span className="qz-recent-warn"> · 一部削除済み</span>}
                        </div>
                      </div>
                      <div className="qz-recent-time">{formatRelativeTime(config.usedAt)}</div>
                    </div>
                  );
                })}
                {recentConfigs.length > RECENT_INITIAL_SHOW && (
                  <button
                    className="text-[12px] text-[#888] font-semibold mt-1 w-full text-center py-1 hover:text-[#1a1a1a] dark:hover:text-[#e0e0e0]"
                    onClick={() => setShowAllRecent(v => !v)}
                  >
                    {showAllRecent ? '折りたたむ ▲' : `さらに表示 (${recentConfigs.length - RECENT_INITIAL_SHOW}件) ▼`}
                  </button>
                )}
              </div>
            )}

            {/* 問題集チェックリスト */}
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-black text-[#1a1a1a] dark:text-[#e0e0e0]">
                問題集を選択
                {selectedSetIds.length > 0 && <span className="text-sm font-semibold text-[#555] dark:text-[#aaa]"> ({selectedSetIds.length}件)</span>}
              </div>
            </div>

            {sets.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">
                <span className="text-[32px] block mb-3">📚</span>
                問題集がまだありません
                <span className="block mt-2.5">
                  <Button variant="default" onClick={() => navigate('/quiz')}>
                    問題集を作成する →
                  </Button>
                </span>
              </p>
            ) : (
              <>
                {sets.map(s => {
                  const selected      = selectedSetIds.includes(s.id);
                  const invalidCount  = getInvalidCount(s.problems);
                  const disabled      = s.problems.length === 0 || invalidCount > 0;
                  return (
                    <div
                      key={s.id}
                      className={`qz-set-item qz-set-item--check${selected ? ' qz-set-item--selected' : ''}${disabled ? ' qz-set-item--disabled' : ''}`}
                      onClick={() => !disabled && toggleSetSelection(s.id)}
                    >
                      <div className={`qz-set-checkbox${selected ? ' qz-set-checkbox--checked' : ''}`}>
                        {selected ? '✓' : ''}
                      </div>
                      <div className="qz-set-info">
                        <div className="qz-set-name">{s.name}</div>
                        <div className="qz-set-count">
                          {s.problems.length === 0
                            ? '問題なし'
                            : invalidCount > 0
                              ? <span className="text-amber-500 text-[12px] font-semibold">⚠ {invalidCount}件の選択肢が不足</span>
                              : `${s.problems.length}問`}
                        </div>
                      </div>
                    </div>
                  );
                })}

                <div className="mt-4">
                  <Button
                    variant="default"
                    className="w-full"
                    disabled={selectedSetIds.length === 0}
                    onClick={() => setConfigConfirmed(true)}
                  >
                    次へ →
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* 離脱確認ダイアログ */}
      {blocker.state === 'blocked' && (
        <Dialog open={true} onOpenChange={() => blocker.reset?.()}>
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>問題を中断しますか？</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-[#888] mb-4">
              回答中のセッションが失われます。本当にページを離れますか？
            </p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => blocker.reset?.()}>
                続ける
              </Button>
              <Button variant="destructive" className="flex-1" onClick={() => blocker.proceed?.()}>
                離れる
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </AppLayout>
  );
};
