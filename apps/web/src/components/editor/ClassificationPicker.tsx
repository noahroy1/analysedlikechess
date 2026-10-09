import { CLASSIFICATIONS, type Classification, type Theme } from '@als/schema';
import { Badge } from '@als/theme';

export interface ClassificationPickerProps {
  theme: Theme;
  value: Classification;
  onPick: (classification: Classification) => void;
  /** Two columns for popovers; one row of chips otherwise. */
  layout?: 'grid' | 'wrap';
}

/** All ten ratings with their badges; the number is its keyboard shortcut. */
export function ClassificationPicker({ theme, value, onPick, layout = 'grid' }: ClassificationPickerProps) {
  return (
    <div className={layout === 'grid' ? 'grid grid-cols-2 gap-1' : 'flex flex-wrap gap-1'} role="listbox" aria-label="Rating">
      {CLASSIFICATIONS.map((c, i) => {
        const style = theme.classifications[c];
        const selected = c === value;
        return (
          <button
            key={c}
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => onPick(c)}
            title={`${style.label} (${(i + 1) % 10})`}
            className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs ${
              selected ? 'bg-neutral-700 text-neutral-50' : 'text-neutral-300 hover:bg-neutral-800'
            }`}
          >
            <Badge badge={style.badge} color={style.color} size={18} />
            <span className="flex-1">{style.label}</span>
            <span className="text-[10px] text-neutral-500 tabular-nums">{(i + 1) % 10}</span>
          </button>
        );
      })}
    </div>
  );
}
