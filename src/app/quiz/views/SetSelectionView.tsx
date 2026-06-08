import { RECENT_INITIAL_SHOW, QUIZ_MODE_LABELS, formatRelativeTime, getInvalidCount } from '../constants';
import type { ProblemSet, RecentConfig } from '../constants';
import { Button } from '@/components/ui/button';

type Props = {
  sets: ProblemSet[];
  selectedSetIds: string[];
  recentConfigs: RecentConfig[];
  showAllRecent: boolean;
  onToggleAllRecent: () => void;
  onToggleSet: (id: string) => void;
  onApplyRecent: (config: RecentConfig) => void;
  onNext: () => void;
  onNavigateToQuiz: () => void;
};

export const SetSelectionView = ({
  sets, selectedSetIds, recentConfigs, showAllRecent,
  onToggleAllRecent, onToggleSet, onApplyRecent, onNext, onNavigateToQuiz,
}: Props) => (
  <>
    {recentConfigs.length > 0 && (
      <div className="mb-5">
        <div className="text-[11px] font-bold text-[#aaa] uppercase tracking-[0.06em] mb-2">直近の記録</div>
        {(showAllRecent ? recentConfigs : recentConfigs.slice(0, RECENT_INITIAL_SHOW)).map(config => {
          const validCount = config.setIds.filter(id => sets.some(s => s.id === id)).length;
          return (
            <div key={config.id} className="qz-recent-item" onClick={() => onApplyRecent(config)}>
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
            onClick={onToggleAllRecent}
          >
            {showAllRecent ? '折りたたむ ▲' : `さらに表示 (${recentConfigs.length - RECENT_INITIAL_SHOW}件) ▼`}
          </button>
        )}
      </div>
    )}

    <div className="flex items-center justify-between mb-3">
      <div className="text-sm font-black text-[#1a1a1a] dark:text-[#e0e0e0]">
        問題集を選択
        {selectedSetIds.length > 0 && (
          <span className="text-sm font-semibold text-[#555] dark:text-[#aaa]"> ({selectedSetIds.length}件)</span>
        )}
      </div>
    </div>

    {sets.length === 0 ? (
      <p className="text-sm text-gray-400 text-center py-8">
        <span className="text-[32px] block mb-3">📚</span>
        問題集がまだありません
        <span className="block mt-2.5">
          <Button variant="default" onClick={onNavigateToQuiz}>
            問題集を作成する →
          </Button>
        </span>
      </p>
    ) : (
      <>
        {sets.map(s => {
          const selected     = selectedSetIds.includes(s.id);
          const invalidCount = getInvalidCount(s.problems);
          const disabled     = s.problems.length === 0 || invalidCount > 0;
          return (
            <div
              key={s.id}
              className={`qz-set-item qz-set-item--check${selected ? ' qz-set-item--selected' : ''}${disabled ? ' qz-set-item--disabled' : ''}`}
              onClick={() => !disabled && onToggleSet(s.id)}
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
            onClick={onNext}
          >
            次へ →
          </Button>
        </div>
      </>
    )}
  </>
);
