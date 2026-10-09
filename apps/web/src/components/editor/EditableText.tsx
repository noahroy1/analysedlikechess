import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';

export interface EditableTextProps {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  /** Enter ends editing instead of adding a line. */
  singleLine?: boolean;
  field: string;
  /** Focus counter: focuses whenever it changes. */
  focusSignal?: number;
}

/**
 * Plain-text in-place editing. Uncontrolled while typing (so the caret never
 * jumps); the DOM is re-synced only when the value changes from elsewhere, e.g. undo.
 */
export function EditableText({ value, placeholder, onChange, singleLine, field, focusSignal }: EditableTextProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.textContent === value) return;
    el.textContent = value;
    if (document.activeElement === el) placeCaretAtEnd(el);
  }, [value]);

  useLayoutEffect(() => {
    if (focusSignal === undefined || !ref.current) return;
    ref.current.focus();
    placeCaretAtEnd(ref.current);
  }, [focusSignal]);

  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (singleLine || e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Enter') {
      // Card text is one paragraph per field.
      e.preventDefault();
    }
  };

  return (
    <span
      ref={ref}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      role="textbox"
      aria-label={placeholder}
      data-field={field}
      data-placeholder={placeholder}
      className="als-editable"
      spellCheck
      onInput={(e) => onChange((e.currentTarget.textContent ?? '').replace(/\n/g, ' '))}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

function placeCaretAtEnd(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
