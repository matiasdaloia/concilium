const STAGES = [
  { num: 1, label: 'compete' },
  { num: 2, label: 'judge' },
  { num: 3, label: 'synthesize' },
];

interface StageProgressProps {
  currentStage: number;
  viewStage: number;
  stageDetail?: string;
  onStageClick?: (stage: number) => void;
  maxViewableStage: number;
}

export default function StageProgress({ 
  currentStage, 
  viewStage, 
  stageDetail, 
  onStageClick,
  maxViewableStage 
}: StageProgressProps) {
  return (
    <div className="flex items-center justify-center gap-0 bg-bg-surface h-9 border-b border-border-primary shrink-0">
      {STAGES.map((stage, i) => {
        const isActive = stage.num === viewStage;
        const isComplete = stage.num < currentStage;
        const isPending = stage.num > currentStage;
        const isViewable = stage.num <= maxViewableStage;
        const canClick = isViewable && onStageClick;

        return (
          <div key={stage.num} className="flex items-center">
            {i > 0 && (
              <div className={`w-8 h-px mx-2 ${isComplete ? 'bg-green-primary' : 'bg-border-secondary'}`} />
            )}
            <button
              onClick={() => canClick && onStageClick(stage.num)}
              disabled={!canClick}
              className={`flex items-center gap-2 px-4 py-1 rounded transition-colors
                ${canClick ? 'hover:bg-white/5 cursor-pointer' : 'cursor-default'}
              `}
            >
              <div
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium font-mono
                  ${isComplete ? 'bg-green-primary text-bg-page' : ''}
                  ${isActive ? 'bg-green-primary text-bg-page' : ''}
                  ${isPending ? 'border border-text-muted text-text-muted' : ''}
                `}
              >
                {isComplete ? '✓' : stage.num}
              </div>
              <span
                className={`text-xs font-mono ${isActive ? 'text-green-primary font-medium' : isComplete ? 'text-text-secondary' : 'text-text-muted'}`}
              >
                {stage.label}
              </span>
              {isActive && stageDetail && (
                <span className="text-[11px] text-green-primary font-mono">{stageDetail}</span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
