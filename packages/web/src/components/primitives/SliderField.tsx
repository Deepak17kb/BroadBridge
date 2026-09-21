import { useId } from 'react';

/**
 * A labelled range slider with its value read out beside it. The readout is
 * the point - a bare slider hides its value - and the filled part of the track
 * shows where in its range the value sits.
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
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  format: (value: number) => string;
  hint?: string;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const fill = max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;
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
        <output className="slider-value" htmlFor={id}>
          {format(value)}
        </output>
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
