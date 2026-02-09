import { useState, useCallback, useRef } from 'react';
import Button from './Button';
import Badge from './Badge';
import { api } from '../api';
import type { RunRecord } from '../types';

interface ResponseRankerProps {
  run: RunRecord;
  onFeedbackSaved?: () => void;
}

export default function ResponseRanker({ run, onFeedbackSaved }: ResponseRankerProps) {
  const [items, setItems] = useState<Array<{ model: string; response: string }>>(() =>
    run.stage1.map((s) => ({ model: s.model, response: s.response })),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(!!run.metadata.userFeedback);
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  const moveItem = useCallback((from: number, to: number) => {
    if (from === to) return;
    setItems((prev: Array<{ model: string; response: string }>) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setSaved(false);
  }, []);

  const handleDragStart = useCallback((index: number) => {
    dragItem.current = index;
  }, []);

  const handleDragEnter = useCallback((index: number) => {
    dragOverItem.current = index;
  }, []);

  const handleDragEnd = useCallback(() => {
    if (dragItem.current !== null && dragOverItem.current !== null) {
      moveItem(dragItem.current, dragOverItem.current);
    }
    dragItem.current = null;
    dragOverItem.current = null;
  }, [moveItem]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const ranking = {
        rankedModelIds: items.map((i: { model: string }) => i.model),
        timestamp: new Date().toISOString(),
      };
      await api.saveUserFeedback(run.id, ranking);
      setSaved(true);
      onFeedbackSaved?.();
    } catch {
      // Silently handle save errors
    } finally {
      setSaving(false);
    }
  }, [items, run.id, onFeedbackSaved]);

  const snapshot = run.metadata.modelSnapshots;

  return (
    <div className="p-6">
      <div className="mb-4">
        <h3 className="text-xs font-medium text-text-secondary tracking-wide mb-1">
          Rank Responses
        </h3>
        <p className="text-[10px] text-text-muted">
          Drag to reorder or use arrows. Position #1 is the best response.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {items.map((item: { model: string; response: string }, index: number) => (
          <div
            key={item.model}
            draggable
            onDragStart={() => handleDragStart(index)}
            onDragEnter={() => handleDragEnter(index)}
            onDragEnd={handleDragEnd}
            onDragOver={(e: { preventDefault: () => void }) => e.preventDefault()}
            className="bg-bg-surface border border-border-primary rounded-lg p-4 flex items-center gap-4 cursor-grab active:cursor-grabbing hover:border-border-secondary transition-colors"
          >
            {/* Rank number */}
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                index === 0
                  ? 'bg-green-primary/20 text-green-primary'
                  : 'bg-bg-hover text-text-muted'
              }`}
            >
              {index + 1}
            </div>

            {/* Model name */}
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium text-text-primary truncate block">
                {item.model}
              </span>
              {snapshot?.[item.model] && (
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-[10px] text-text-muted">
                    {snapshot[item.model].costPer1kTokens > 0
                      ? `$${snapshot[item.model].costPer1kTokens.toFixed(4)}/1k tokens`
                      : 'cost n/a'}
                  </span>
                  <Badge
                    variant={
                      snapshot[item.model].speedTier === 'fast'
                        ? 'green'
                        : snapshot[item.model].speedTier === 'balanced'
                          ? 'amber'
                          : 'red'
                    }
                  >
                    {snapshot[item.model].speedTier}
                    {snapshot[item.model].latencyMs > 0 &&
                      ` (${(snapshot[item.model].latencyMs / 1000).toFixed(1)}s)`}
                  </Badge>
                </div>
              )}
            </div>

            {/* Arrow buttons */}
            <div className="flex flex-col gap-0.5 shrink-0">
              <button
                disabled={index === 0}
                onClick={() => moveItem(index, index - 1)}
                className="px-1.5 py-0.5 text-[10px] rounded bg-bg-hover hover:bg-border-primary text-text-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Move up"
              >
                &#9650;
              </button>
              <button
                disabled={index === items.length - 1}
                onClick={() => moveItem(index, index + 1)}
                className="px-1.5 py-0.5 text-[10px] rounded bg-bg-hover hover:bg-border-primary text-text-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Move down"
              >
                &#9660;
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || saved}>
          {saving ? 'Saving...' : saved ? 'Saved' : 'Save Preference'}
        </Button>
        {saved && (
          <span className="text-[10px] text-green-primary">
            Your ranking has been saved
          </span>
        )}
      </div>
    </div>
  );
}
