import { useState, useEffect, useRef } from 'react';
import type { ActiveSession } from '../constants';
import { isExamSession } from '../constants';

export function useExamTimer(session: ActiveSession, onTimeUp: () => void): number {
  const [remainingMs, setRemainingMs] = useState(0);
  const timeUpFired = useRef(false);
  const onTimeUpRef = useRef(onTimeUp);
  onTimeUpRef.current = onTimeUp;

  const isExam = isExamSession(session);

  useEffect(() => {
    if (!isExam || session.phase !== 'answering') return;
    timeUpFired.current = false;

    const tick = () => {
      const rem = session.startedAt + session.timeLimit - Date.now();
      setRemainingMs(rem);
      if (rem <= 0 && !timeUpFired.current) {
        timeUpFired.current = true;
        onTimeUpRef.current();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExam, session.phase]);

  return remainingMs;
}
