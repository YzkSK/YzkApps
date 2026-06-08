import { useState, useRef } from 'react';
import type { ProblemSet } from './constants';

type DragSetReturn = {
  dragSetId: string | null;
  dragSetIdRef: React.MutableRefObject<string | null>;
  setPointerPos: { x: number; y: number } | null;
  didDragSetRef: React.MutableRefObject<boolean>;
  setSlotHeightRef: React.MutableRefObject<number>;
  setCardWidthRef: React.MutableRefObject<number>;
  setCardLeftRef: React.MutableRefObject<number>;
  setGrabOffsetRef: React.MutableRefObject<number>;
  getSetShift: (i: number) => number;
  startSetDrag: (id: string, clientX: number, clientY: number, cardEl: HTMLElement | null) => void;
  endSetDrag: (clientX: number, clientY: number) => void;
  cancelSetDrag: () => void;
  updateDragOverSet: (id: string | null) => void;
  updateDragPointerPos: (x: number, y: number) => void;
  getSetItemIdFromPoint: (x: number, y: number) => string | null;
};

export function useDragSet(
  sets: ProblemSet[],
  onReorder: (orderedIds: string[]) => void,
): DragSetReturn {
  const [dragSetId, setDragSetId]         = useState<string | null>(null);
  const [dragOverSetId, setDragOverSetId] = useState<string | null>(null);
  const [setPointerPos, setSetPointerPos] = useState<{ x: number; y: number } | null>(null);

  const didDragSetRef        = useRef(false);
  const dragSetIdRef         = useRef<string | null>(null);
  const dragOverSetIdRef     = useRef<string | null>(null);
  const prevDragOverSetIdRef = useRef<string | null>(null);
  const setSlotHeightRef     = useRef(80);
  const setCardWidthRef      = useRef(0);
  const setCardLeftRef       = useRef(0);
  const setGrabOffsetRef     = useRef(0);
  const onReorderRef         = useRef(onReorder);
  onReorderRef.current       = onReorder;
  // sets は endSetDrag で最新値が必要なため ref で保持
  const setsRef              = useRef(sets);
  setsRef.current            = sets;

  const dragFromSetIdx = dragSetId     ? sets.findIndex(s => s.id === dragSetId)     : -1;
  const dragToSetIdx   = dragOverSetId ? sets.findIndex(s => s.id === dragOverSetId) : -1;

  const getSetShift = (i: number): number => {
    if (dragFromSetIdx === -1 || dragToSetIdx === -1 || dragFromSetIdx === dragToSetIdx) return 0;
    const sp = setSlotHeightRef.current;
    if (dragFromSetIdx < dragToSetIdx && i > dragFromSetIdx && i <= dragToSetIdx) return -sp;
    if (dragFromSetIdx > dragToSetIdx && i >= dragToSetIdx && i < dragFromSetIdx) return  sp;
    return 0;
  };

  const clearDragOverSet = () => {
    prevDragOverSetIdRef.current = null;
    dragOverSetIdRef.current = null;
    setDragOverSetId(null);
  };

  // ドラッグ中のアイテム自身には反応しない
  const updateDragOverSet = (id: string | null) => {
    if (id === null || id === dragSetIdRef.current) return;
    if (id !== prevDragOverSetIdRef.current) navigator.vibrate?.(30);
    prevDragOverSetIdRef.current = id;
    dragOverSetIdRef.current = id;
    setDragOverSetId(id);
  };

  const updateDragPointerPos = (x: number, y: number) => {
    setSetPointerPos({ x, y });
  };

  const getSetItemIdFromPoint = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    return (el?.closest('[data-item-id]') as HTMLElement | null)?.dataset.itemId ?? null;
  };

  const startSetDrag = (id: string, clientX: number, clientY: number, cardEl: HTMLElement | null) => {
    if (cardEl) {
      const rect = cardEl.getBoundingClientRect();
      if (rect.height > 0) setSlotHeightRef.current = rect.height + 10;
      setCardWidthRef.current  = rect.width;
      setCardLeftRef.current   = rect.left;
      setGrabOffsetRef.current = clientY - rect.top;
    }
    dragSetIdRef.current = id;
    setDragSetId(id);
    setSetPointerPos({ x: clientX, y: clientY });
    didDragSetRef.current = false;
  };

  const endSetDrag = (clientX: number, clientY: number) => {
    const toId = getSetItemIdFromPoint(clientX, clientY) ?? dragOverSetIdRef.current;
    if (toId && toId !== dragSetIdRef.current && dragSetIdRef.current) {
      didDragSetRef.current = true;
      const current = setsRef.current;
      const fromIdx = current.findIndex(x => x.id === dragSetIdRef.current);
      const toIdx   = current.findIndex(x => x.id === toId);
      if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
        const next = [...current];
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved!);
        onReorderRef.current(next.map(x => x.id));
      }
    }
    dragSetIdRef.current = null;
    setDragSetId(null);
    setSetPointerPos(null);
    clearDragOverSet();
  };

  const cancelSetDrag = () => {
    dragSetIdRef.current = null;
    setDragSetId(null);
    setSetPointerPos(null);
    clearDragOverSet();
  };

  return {
    dragSetId,
    dragSetIdRef,
    setPointerPos,
    didDragSetRef,
    setSlotHeightRef,
    setCardWidthRef,
    setCardLeftRef,
    setGrabOffsetRef,
    getSetShift,
    startSetDrag,
    endSetDrag,
    cancelSetDrag,
    updateDragOverSet,
    updateDragPointerPos,
    getSetItemIdFromPoint,
  };
}
