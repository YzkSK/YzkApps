import { useRef, useCallback } from 'react';
import { ref, deleteObject, listAll } from 'firebase/storage';
import { storage } from '../shared/firebase';
import type { User } from 'firebase/auth';
import type { ProblemSet } from './constants';

export function useImageCleanup(
  sets: ProblemSet[],
  currentUser: User | null,
): (guardUrl: string) => Promise<void> {
  const setsRef = useRef(sets);
  setsRef.current = sets;

  return useCallback(async (guardUrl: string) => {
    if (!currentUser) return;
    const toPath = (url: string): string | null => {
      try { return ref(storage, url).fullPath; } catch { return null; }
    };
    const usedPaths = new Set(
      setsRef.current
        .flatMap(s => s.problems)
        .map(p => p.imageUrl ? toPath(p.imageUrl) : null)
        .filter((p): p is string => p !== null),
    );
    const guardPath = toPath(guardUrl);
    if (guardPath) usedPaths.add(guardPath);
    try {
      const { items } = await listAll(ref(storage, `quiz-images/${currentUser.uid}`));
      await Promise.all(
        items
          .filter(item => !usedPaths.has(item.fullPath))
          .map(item => deleteObject(item).catch((e) => { console.error('Storage個別削除失敗:', e); })),
      );
    } catch (e) { console.error('ストレージクリーンアップ失敗:', e); /* 補助的処理のため失敗しても続行 */ }
  }, [currentUser]);
}
