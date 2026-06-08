import { useState, useEffect } from 'react';
import { useToast } from '../shared/useToast';
import { signOut } from 'firebase/auth';
import { ref, deleteObject } from 'firebase/storage';
import { auth, storage } from '../shared/firebase';
import { useAuth } from '../auth/AuthContext';
import { useNavigate } from 'react-router-dom';
import '../shared/app.css';
import './quiz.css';
import {
  TOAST_DURATION_MS,
  newProblem, newProblemSet, parseProblem, parseProblemSet, firestorePaths, WRONG_CHOICES_COUNT,
  getInvalidCount,
  type Problem, type ProblemSet, type Modal, type AddModal, type EditModal, type AnswerFormat,
} from './constants';
import { useFirestoreData } from '../shared/useFirestoreData';
import { useFirestoreSave } from '../shared/useFirestoreSave';
import { useDragSet } from './useDragSet';
import { useImageCleanup } from './useImageCleanup';
import { ProblemList } from './views/ProblemList';
import { ProblemModal } from './modals/ProblemModal';
import { ProblemSetModal } from './modals/ProblemSetModal';
import { ShareModal } from './modals/ShareModal';
import { ImportModal } from './modals/ImportModal';
import { GeminiPdfModal } from './modals/GeminiPdfModal';
import { Button } from '@/components/ui/button';
import { AppMenu } from '../shell/AppMenu';
import { usePageTitle } from '../shared/usePageTitle';
import { AppLayout } from '../platform/AppLayout';

export const Quiz = () => {
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  usePageTitle('問題集');

  const [activeSetId, setActiveSetId] = useState<string | null>(null);
  const [modal, setModal]             = useState<Modal>(null);
  const { toasts, addToast }          = useToast(TOAST_DURATION_MS);
  const [formError, setFormError]     = useState('');

  // saveToFirestore を先に定義して onAfterLoad から参照できるようにする
  const saveToFirestore = useFirestoreSave<{ sets: ProblemSet[] }>({
    currentUser,
    path: firestorePaths.quizData(currentUser?.uid ?? ''),
  });

  // index === 0 の問題があれば再採番が必要なフラグ（parse → onAfterLoad で共有）
  let needsReindexSave = false;

  const { data: sets, setData: setSets, loading, dbError } = useFirestoreData<ProblemSet[]>({
    currentUser,
    path: firestorePaths.quizData(currentUser?.uid ?? ''),
    parse: (raw) => {
      needsReindexSave = false;
      if (Array.isArray(raw.sets)) {
        const loaded = (raw.sets as Record<string, unknown>[]).map(parseProblemSet);
        const needsReindex = loaded.some(s => s.problems.some(p => p.index === 0));
        if (!needsReindex) return loaded;
        needsReindexSave = true;
        return loaded.map(s =>
          s.problems.some(p => p.index === 0)
            ? { ...s, problems: s.problems.map((p, i) => ({ ...p, index: i + 1 })) }
            : s
        );
      }
      if (Array.isArray(raw.problems)) {
        // 旧データ移行: problems → デフォルトセット
        const migrated = newProblemSet('問題集');
        migrated.problems = (raw.problems as Record<string, unknown>[]).map(parseProblem);
        return [migrated];
      }
      return [];
    },
    loadingKey: 'quiz',
    initialData: [],
    onAfterLoad: (data) => {
      if (needsReindexSave) saveToFirestore({ sets: data });
    },
  });

  const cleanupImages = useImageCleanup(sets, currentUser);

  const {
    dragSetId, setPointerPos,
    didDragSetRef, setCardWidthRef, setCardLeftRef, setGrabOffsetRef,
    getSetShift, startSetDrag, endSetDrag, cancelSetDrag,
    updateDragOverSet, updateDragPointerPos, getSetItemIdFromPoint,
  } = useDragSet(sets, (orderedIds) => {
    const next = orderedIds.map(id => sets.find(s => s.id === id)!).filter(Boolean);
    setSets(next);
    saveToFirestore({ sets: next });
  });

  // ローディング完了後、保存済みGeminiセッションがあれば自動復元
  useEffect(() => {
    if (loading || !currentUser) return;
    const raw = localStorage.getItem(`gemini-session-${currentUser.uid}`);
    if (!raw) return;
    try {
      const s = JSON.parse(raw) as { step?: string };
      if (s.step === 'review' || s.step === 'verify' || s.step === 'fix') {
        setModal({ type: 'gemini-pdf' });
      } else {
        localStorage.removeItem(`gemini-session-${currentUser.uid}`);
      }
    } catch {
      localStorage.removeItem(`gemini-session-${currentUser.uid}`);
    }
  }, [loading, currentUser]);

  const handleLogout = async () => {
    await signOut(auth);
    navigate('/login');
  };

  // ── 問題集 CRUD ──────────────────────────────────────────
  const createSet = (name: string, answerFormat: AnswerFormat = 'written') => {
    const next = [...sets, newProblemSet(name, answerFormat)];
    setSets(next);
    saveToFirestore({ sets: next });
    setModal(null);
  };

  const updateSet = (setId: string, name: string, answerFormat: AnswerFormat) => {
    const next = sets.map(s => {
      if (s.id !== setId) return s;
      // 形式が変わったら全問題の answerFormat を同期し、不要な wrongChoices をクリア
      const problems = s.answerFormat !== answerFormat
        ? s.problems.map(p => ({
            ...p,
            answerFormat,
            wrongChoices: WRONG_CHOICES_COUNT[answerFormat] === 0 ? [] : p.wrongChoices,
          }))
        : s.problems;
      return { ...s, name, answerFormat, problems };
    });
    setSets(next);
    saveToFirestore({ sets: next });
    setModal(null);
  };

  const deleteSet = (setId: string) => {
    const deletingSet = sets.find(s => s.id === setId);
    const remainingSets = sets.filter(s => s.id !== setId);

    // 削除する問題集の画像のうち、他のセットで使われていないものを削除
    if (deletingSet) {
      const remainingPaths = new Set(
        remainingSets.flatMap(s => s.problems).map(p => {
          if (!p.imageUrl) return null;
          try { return ref(storage, p.imageUrl).fullPath; } catch { return null; }
        }).filter((p): p is string => p !== null),
      );
      for (const p of deletingSet.problems) {
        if (!p.imageUrl) continue;
        try {
          const path = ref(storage, p.imageUrl).fullPath;
          if (!remainingPaths.has(path)) {
            deleteObject(ref(storage, p.imageUrl)).catch((e) => { console.error('Storage削除失敗:', e); });
          }
        } catch (e) { console.error('Storage参照失敗:', e); }
      }
    }

    setSets(remainingSets);
    saveToFirestore({ sets: remainingSets });
    if (activeSetId === setId) setActiveSetId(null);
    setModal(null);
  };

  const resetSetStats = (setId: string) => {
    const next = sets.map(s => s.id !== setId ? s : {
      ...s,
      problems: s.problems.map(p => ({ ...p, attemptCount: 0, correctCount: 0, consecutiveCorrect: 0, consecutiveWrong: 0 })),
    });
    setSets(next);
    saveToFirestore({ sets: next });
  };

  // ── 問題 CRUD（アクティブセット内）────────────────────────
  const activeSet  = sets.find(s => s.id === activeSetId) ?? null;
  const problems   = activeSet?.problems ?? [];

  const updateActiveSetProblems = (updated: Problem[]) => {
    const next = sets.map(s => s.id === activeSetId ? { ...s, problems: updated } : s);
    setSets(next);
    saveToFirestore({ sets: next });
  };

  const handleReorder = (orderedIds: string[]) => {
    const reordered = orderedIds.map(id => problems.find(p => p.id === id)!).filter(Boolean);
    updateActiveSetProblems(reordered.map((p, i) => ({ ...p, index: i + 1 })));
  };

  const openAdd  = () => { setFormError(''); setModal({ type: 'add' }); };
  const openEdit = (id: string) => { setFormError(''); setModal({ type: 'edit', problemId: id }); };

  const saveProblem = (
    question: string, answer: string, category: string, wrongChoices: string[], memo: string, imageUrl: string,
  ): boolean => {
    const fmt = activeSet?.answerFormat ?? 'written';
    if (!question.trim() || !answer.trim()) {
      setFormError('問題文と答えは必須です');
      return false;
    }
    if (fmt === 'choice4' && wrongChoices.some(w => !w.trim())) {
      setFormError('不正解の選択肢をすべて入力してください');
      return false;
    }
    let next: Problem[];
    if (modal?.type === 'add') {
      const maxIndex = problems.reduce((m, p) => Math.max(m, p.index), 0);
      next = [...problems, newProblem(question.trim(), answer.trim(), category.trim(), fmt, wrongChoices, memo, imageUrl, maxIndex + 1)];
    } else if (modal?.type === 'edit') {
      next = problems.map(p =>
        p.id === modal.problemId
          ? { ...p, question: question.trim(), answer: answer.trim(), category: category.trim(), answerFormat: fmt, wrongChoices, memo, imageUrl }
          : p
      );
    } else {
      return false;
    }
    updateActiveSetProblems(next);
    setModal(null);
    return true;
  };

  const deleteProblem = (id: string) => {
    const problem = problems.find(p => p.id === id);
    if (problem?.imageUrl) {
      const problemPath = (() => { try { return ref(storage, problem.imageUrl).fullPath; } catch { return null; } })();
      const usedElsewhere = problemPath !== null && sets.flatMap(s => s.problems).some(p => {
        if (p.id === id || !p.imageUrl) return false;
        try { return ref(storage, p.imageUrl).fullPath === problemPath; } catch { return false; }
      });
      if (!usedElsewhere) {
        deleteObject(ref(storage, problem.imageUrl)).catch((e) => { console.error('Storage削除失敗:', e); });
      }
    }
    updateActiveSetProblems(problems.filter(p => p.id !== id).map((p, i) => ({ ...p, index: i + 1 })));
    setModal(null);
  };

  const toggleBookmark = (id: string) => {
    updateActiveSetProblems(problems.map(p => p.id === id ? { ...p, bookmarked: !p.bookmarked } : p));
  };

  const handleImport = (imported: Problem[], title: string, answerFormat?: AnswerFormat) => {
    const s = newProblemSet(title || 'インポートした問題集', answerFormat);
    s.problems = imported.map((p, i) => ({ ...p, index: i + 1 }));
    const next = [...sets, s];
    setSets(next);
    saveToFirestore({ sets: next });
    setModal(null);
  };

  const handleImportToExisting = (imported: Problem[], setId: string) => {
    const next = sets.map(s =>
      s.id === setId
        ? { ...s, problems: [...s.problems, ...imported.map((p, i) => ({ ...p, index: s.problems.reduce((m, q) => Math.max(m, q.index), 0) + i + 1 }))] }
        : s
    );
    setSets(next);
    saveToFirestore({ sets: next });
    setModal(null);
  };

  if (loading) return null;

  const quizHeader = activeSetId === null ? (
    <header className="app-header">
      <div className="app-header-left">
        <AppMenu />
        <h1 className="app-page-title">問題集</h1>
      </div>
      <div className="app-header-actions">
        <Button variant="outline" onClick={handleLogout}>ログアウト</Button>
      </div>
    </header>
  ) : (
    <header className="app-header">
      <div className="app-header-left">
        <AppMenu />
        <h1 className="app-page-title">{activeSet?.name}</h1>
      </div>
      <div className="app-header-actions">
        <Button variant="outline" size="sm" onClick={() => setModal({ type: 'set-edit', setId: activeSetId! })}>名前変更</Button>
        <Button variant="outline" onClick={() => setActiveSetId(null)}>← 一覧</Button>
      </div>
    </header>
  );

  return (
    <AppLayout
      className="px-[14px] pt-5 pb-[120px]"
      dbError={dbError}
      toasts={toasts}
      header={quizHeader}
    >

      <div className="max-w-[640px] mx-auto">
        {activeSetId === null ? (
          // ── 問題集一覧 ─────────────────────────────────────
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="text-sm font-black text-[#1a1a1a] dark:text-[#e0e0e0]">マイ問題集 ({sets.length}件)</div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setModal({ type: 'import' })}>インポート</Button>
                <Button variant="outline" onClick={() => setModal({ type: 'gemini-pdf' })}>AI問題抽出</Button>
                <Button variant="default" onClick={() => setModal({ type: 'set-create' })}>＋ 新規作成</Button>
              </div>
            </div>

            {sets.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">
                <span className="text-[32px] block mb-3">📚</span>
                問題集がまだありません
                <span className="block mt-2.5">
                  <Button variant="default" onClick={() => setModal({ type: 'set-create' })}>
                    ＋ 問題集を作成する
                  </Button>
                </span>
              </p>
            ) : (
              sets.map((s, i) => {
                const invalidCount = getInvalidCount(s.problems);
                const isDragging   = dragSetId === s.id;
                const shift        = getSetShift(i);
                const isGrabbing   = isDragging && !!setPointerPos;
                return (
                <div
                  key={s.id}
                  data-item-id={s.id}
                  style={shift ? { transform: `translateY(${shift}px)` } : undefined}
                  className={`qz-set-item transition-[transform,opacity] duration-[220ms] ease-[cubic-bezier(0.25,0.46,0.45,0.94)]
                    ${isGrabbing ? 'qz-drag-placeholder' : isDragging ? 'opacity-40' : 'opacity-100'}`}
                  onClick={() => { if (!didDragSetRef.current) setActiveSetId(s.id); didDragSetRef.current = false; }}
                >
                  <div
                    className="-ml-4 -my-[14px] mr-3 flex items-center px-2.5 border-r border-[#ececec] dark:border-[#2a2a2a] rounded-l-[11px] flex-shrink-0 touch-none cursor-grab active:cursor-grabbing"
                    onMouseDown={e => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      startSetDrag(s.id, e.clientX, e.clientY, e.currentTarget.parentElement);
                      const onMove = (me: MouseEvent) => {
                        updateDragPointerPos(me.clientX, me.clientY);
                        updateDragOverSet(getSetItemIdFromPoint(me.clientX, me.clientY));
                      };
                      const onUp = (me: MouseEvent) => {
                        endSetDrag(me.clientX, me.clientY);
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                        document.body.style.userSelect = '';
                        document.body.style.cursor = '';
                      };
                      document.addEventListener('mousemove', onMove);
                      document.addEventListener('mouseup', onUp);
                      document.body.style.userSelect = 'none';
                      document.body.style.cursor = 'grabbing';
                    }}
                    onTouchStart={e => {
                      e.preventDefault();
                      const touch = e.touches[0];
                      if (!touch) return;
                      startSetDrag(s.id, touch.clientX, touch.clientY, e.currentTarget.parentElement);
                    }}
                    onTouchMove={e => {
                      e.preventDefault();
                      const touch = e.touches[0];
                      if (!touch) return;
                      updateDragPointerPos(touch.clientX, touch.clientY);
                      updateDragOverSet(getSetItemIdFromPoint(touch.clientX, touch.clientY));
                    }}
                    onTouchEnd={e => {
                      e.preventDefault();
                      const touch = e.changedTouches[0];
                      if (touch) endSetDrag(touch.clientX, touch.clientY);
                      else cancelSetDrag();
                    }}
                  >
                    <span className="text-[16px] text-[#ccc] select-none">⠿</span>
                  </div>
                  <div className="qz-set-info">
                    <div className="qz-set-name">{s.name}</div>
                    <div className="qz-set-count">
                      {s.problems.length}問
                      {invalidCount > 0 && <span className="text-amber-500 text-[12px] font-semibold"> · ⚠ {invalidCount}件の選択肢が不足</span>}
                    </div>
                  </div>
                  <div className="qz-set-actions" onClick={e => e.stopPropagation()}>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setModal({ type: 'set-edit', setId: s.id })}
                    >
                      編集
                    </Button>
                  </div>
                </div>
                );
              })
            )}

            {/* ドラッグ中のゴーストカード（マウス・タッチ共通） */}
            {setPointerPos && dragSetId && (() => {
              const gs = sets.find(s => s.id === dragSetId);
              if (!gs) return null;
              return (
                <div
                  style={{
                    position: 'fixed',
                    top: setPointerPos.y - setGrabOffsetRef.current,
                    left: setCardLeftRef.current,
                    width: setCardWidthRef.current,
                    pointerEvents: 'none',
                    zIndex: 9999,
                    borderRadius: 12,
                  }}
                  className="qz-set-item qz-drag-ghost"
                >
                  <div className="-ml-4 -my-[14px] mr-3 flex items-center px-2.5 border-r border-[#ececec] dark:border-[#2a2a2a] rounded-l-[11px] flex-shrink-0">
                    <span className="text-[16px] text-[#ccc] select-none">⠿</span>
                  </div>
                  <div className="qz-set-info">
                    <div className="qz-set-name">{gs.name}</div>
                    <div className="qz-set-count">{gs.problems.length}問</div>
                  </div>
                </div>
              );
            })()}
          </>
        ) : (
          // ── 問題一覧（アクティブセット内）──────────────────
          <>
            <ProblemList
              problems={problems}
              onAdd={openAdd}
              onEdit={openEdit}
              onShare={() => setModal({ type: 'share' })}
              onToggleBookmark={toggleBookmark}
              onReorder={handleReorder}
            />
          </>
        )}
      </div>

      {/* 問題集作成・編集モーダル */}
      {(modal?.type === 'set-create' || modal?.type === 'set-edit') && (
        <ProblemSetModal
          modal={modal}
          sets={sets}
          onSave={(name, answerFormat) => {
            if (modal.type === 'set-create') createSet(name, answerFormat);
            else updateSet(modal.setId, name, answerFormat);
          }}
          onDelete={modal.type === 'set-edit' ? () => deleteSet(modal.setId) : undefined}
          onReset={modal.type === 'set-edit' ? () => resetSetStats(modal.setId) : undefined}
          onClose={() => setModal(null)}
        />
      )}

      {(modal?.type === 'add' || modal?.type === 'edit') && currentUser && (
        <ProblemModal
          modal={modal as AddModal | EditModal}
          problems={problems}
          allProblems={sets.flatMap(s => s.problems)}
          answerFormat={activeSet?.answerFormat ?? 'written'}
          uid={currentUser.uid}
          formError={formError}
          onSave={saveProblem}
          onDelete={deleteProblem}
          onClose={() => setModal(null)}
          addToast={addToast}
          onCleanupImages={cleanupImages}
        />
      )}
      {modal?.type === 'share' && currentUser && (
        <ShareModal
          problems={problems}
          uid={currentUser.uid}
          answerFormat={activeSet?.answerFormat ?? 'written'}
          defaultTitle={activeSet?.name}
          existingShareCode={activeSet?.shareCode}
          onShareCodeSaved={(code) => {
            if (!activeSetId) return;
            const next = sets.map(s => s.id === activeSetId ? { ...s, shareCode: code } : s);
            setSets(next);
            saveToFirestore({ sets: next });
          }}
          onClose={() => setModal(null)}
          addToast={addToast}
        />
      )}
      {modal?.type === 'import' && (
        <ImportModal
          onImport={handleImport}
          onClose={() => setModal(null)}
          addToast={addToast}
          uid={currentUser?.uid ?? ''}
          allProblems={sets.flatMap(s => s.problems)}
        />
      )}
      {modal?.type === 'gemini-pdf' && (
        <GeminiPdfModal
          sets={sets}
          onImportNew={handleImport}
          onImportExisting={handleImportToExisting}
          onClose={() => setModal(null)}
          addToast={addToast}
          uid={currentUser?.uid ?? ''}
        />
      )}

      {activeSetId === null && sets.length > 0 && (
        <div className="fixed bottom-[56px] left-0 right-0 px-[14px] flex justify-center pointer-events-none">
          <Button className="w-full max-w-[640px] pointer-events-auto" variant="default" onClick={() => navigate('/quiz/play')}>
            回答する
          </Button>
        </div>
      )}

    </AppLayout>
  );
};
