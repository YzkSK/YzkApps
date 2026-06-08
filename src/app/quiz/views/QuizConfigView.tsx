import { QUIZ_MODE_LABELS, getCategories, filterProblems, isWeak } from '../constants';
import type { Problem, QuizMode } from '../constants';
import { Button } from '@/components/ui/button';

type Props = {
  problems: Problem[];
  categoryFilter: string;
  quizMode: QuizMode;
  onCategoryFilterChange: (value: string) => void;
  onQuizModeChange: (mode: QuizMode) => void;
  onStart: () => void;
};

export const QuizConfigView = ({
  problems, categoryFilter, quizMode,
  onCategoryFilterChange, onQuizModeChange, onStart,
}: Props) => {
  const categories  = getCategories(problems);
  const weakCount   = problems.filter(isWeak).length;
  const targetCount = filterProblems(problems, categoryFilter).length;

  return (
    <div className="bg-white dark:bg-[#1a1a1a] border border-[#e8e8e8] dark:border-[#333] rounded-[14px] p-[18px_16px] mb-5">
      <div className="text-[12px] font-bold text-[#888] mb-3 uppercase tracking-[0.05em]">出題設定</div>

      <div className="mb-[14px]">
        <div className="text-[11px] text-[#888] font-semibold mb-[6px]">問題フィルター</div>
        <select
          name="category-filter"
          className="w-full px-3 py-[9px] border-[1.5px] border-[#e0e0e0] dark:border-[#444] rounded-[9px] bg-white dark:bg-[#222] text-[13px] text-[#1a1a1a] dark:text-[#e0e0e0] font-semibold cursor-pointer appearance-none outline-none focus:border-[#1a1a1a] dark:focus:border-[#888]"
          value={categoryFilter}
          onChange={e => onCategoryFilterChange(e.target.value)}
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
              onClick={() => onQuizModeChange(m)}
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
          onClick={onStart}
          disabled={targetCount === 0}
        >
          出題開始
        </Button>
      </div>
    </div>
  );
};
