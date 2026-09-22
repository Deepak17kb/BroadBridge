import { useEffect, useId, useRef, useState } from 'react';

/**
 * A labelled range slider with its value read out beside it. The readout is
 * the point - a bare slider hides its value - and the filled part of the track
 * shows where in its range the value sits.
 *
 * Where the raw value is itself a meaningful number (rupees, years), the
 * readout is editable: click or tab to it and type an exact figure. A slider
 * can only land on multiples of its step, so on a range of tens of lakhs the
 * nearest stop can be thousands of rupees from the number someone actually
 * has in mind - and dragging to a precise figure is the interaction people
 * with motor impairments struggle with most. Typing answers both.
 */
export function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  hint,
  editable = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  format: (value: number) => string;
  hint?: string;
  /** Only where the raw value reads as the number shown - not for ratios. */
  editable?: boolean;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const fill = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const open = () => {
    setDraft(String(value));
    setEditing(true);
  };

  /** Typing is not held to the slider's step, only to its range. */
  const commit = () => {
    const parsed = Number.parseFloat(draft);
    if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
    setEditing(false);
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="slider-row">
        <input
          id={id}
          className="slider"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number.parseFloat(e.target.value))}
          aria-valuetext={format(value)}
          aria-describedby={hintId}
          style={{ ['--fill' as string]: `${fill}%` }}
        />
        {editable ? (
          editing ? (
            <input
              ref={inputRef}
              className="input slider-edit num"
              type="number"
              min={min}
              max={max}
              value={draft}
              aria-label={`${label}, exact value`}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="slider-value slider-value-edit"
              onClick={open}
              title="Type an exact value"
            >
              {format(value)}
            </button>
          )
        ) : (
          <output className="slider-value" htmlFor={id}>
            {format(value)}
          </output>
        )}
      </div>
      {hint && (
        <div className="field-hint" id={hintId}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** The name the pages have always used. */
export const Slider = SliderField;
