import { useState, useEffect, useRef, useCallback } from 'react';
import { useToast } from '../shared/useToast';
import { useAuth } from '../auth/AuthContext';
import { useNavigate, useSearchParams, useBlocker } from 'react-router-dom';
import '../shared/app.css';
import './quiz.css';
import {
  TOAST_DURATION_MS, EXAM_TIME_LIMIT_MS, EXAM_MAX_PROBLEMS, MASTER_THRESHOLD,
  MAX_RECENT,
  shuffle, filterProblems, buildProblemChoices, isAnswerCorrect, isExamSession, isInvalidProblem,
  newProblemSet, parseProblem, parseProblemSet, parseRecentConfig, firestorePaths,
  type Problem, type ProblemSet, type RecentConfig, type ActiveSession, type QuizSessionConfig,
  type OneByOneSession, type ExamSession, type QuizMode,
} from './constants';
import { useFirestoreData } from '../shared/useFirestoreData';
import { useFirestoreSave } from '../shared/useFirestoreSave';
import { QuizSession } from './views/QuizSession';
import { SetSelectionView } from './views/SetSelectionView';
import { QuizConfigView } from './views/QuizConfigView';
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

  const [showAllRecent, setShowAllRecent]     = useState(false);
  const initSetId = searchParams.get('set');
  const [selectedSetIds, setSelectedSetIds]   = useState<string[]>(initSetId ? [initSetId] : []);
  const [configConfirmed, setConfigConfirmed] = useState(false);
  const [session, setSession]                 = useState<ActiveSession | null>(null);
  const { toasts, addToast }                  = useToast(TOAST_DURATION_MS);
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

  const toggleBookmark   = (id: string) => updateProblemInSets(id, p => ({ ...p, bookmarked: !p.bookmarked }));
  const handleUpdateMemo = (id: string, memo: string) => updateProblemInSets(id, p => ({ ...p, memo }));

  // ── セッション開始 ──────────────────────────────────────
  const startSession = (config: QuizSessionConfig) => {
    const filtered = filterProblems(problems, config.categoryFilter).filter(p => !isInvalidProblem(p));
    if (filtered.length === 0) { addToast('対象の問題がありません'); return; }

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

  const blocker = useBlocker(isSessionInProgress);

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
        ) : configConfirmed ? (
          <QuizConfigView
            problems={problems}
            categoryFilter={categoryFilter}
            quizMode={quizMode}
            onCategoryFilterChange={setCategoryFilter}
            onQuizModeChange={setQuizMode}
            onStart={() => startSession({ mode: quizMode, categoryFilter })}
          />
        ) : (
          <SetSelectionView
            sets={sets}
            selectedSetIds={selectedSetIds}
            recentConfigs={recentConfigs}
            showAllRecent={showAllRecent}
            onToggleAllRecent={() => setShowAllRecent(v => !v)}
            onToggleSet={toggleSetSelection}
            onApplyRecent={applyRecentConfig}
            onNext={() => setConfigConfirmed(true)}
            onNavigateToQuiz={() => navigate('/quiz')}
          />
        )}
      </div>

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
