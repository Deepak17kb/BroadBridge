import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import type { Currency } from '@wealth/shared';

/** What a number field shows for `value`. Zero is left to the placeholder. */
function numberText(value: number): string {
  return Number.isFinite(value) && value !== 0 ? String(value) : '';
}

function parseNumber(text: string): number {
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Drops leading zeros as they are typed, so "05" reads "5" - but never the zero in "0.5". */
export function withoutLeadingZeros(text: string): string {
  return text.replace(/^(-?)0+(?=\d)/, '$1');
}

/**
 * A number field whose zero is a placeholder rather than text.
 *
 * A controlled `<input type="number">` re-derives its text from the stored
 * number, and that goes wrong two ways. React leaves the DOM alone whenever the
 * text already parses to the controlled value - so a field holding 0 that the
 * user types "85000" into shows "085000", because that *is* 85000. And a caller
 * that formats the number (`toFixed(1)`) rewrites the text after every
 * keystroke: typing "8.5" into a rate showing 10.0 became "8.0", then "8.05",
 * then 8.1.
 *
 * So zero renders as an empty field with a "0" placeholder, and the field keeps
 * its own copy of what was typed. Only the parsed number leaves it - and the
 * parent may ignore a partial value, which the field then keeps showing.
 */
export function NumberInput({
  value,
  onChange,
  placeholder = '0',
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: number;
  onChange: (next: number) => void;
}) {
  const [text, setText] = useState(() => numberText(value));
  const [synced, setSynced] = useState(value);

  // A value that changed from outside - a sample profile loaded, a figure
  // edited on another card - replaces the text. One the text already says is
  // left alone, so "8." or "1.50" survives its own round trip through the
  // parent. Adjusting during render, rather than in an effect, means the stale
  // text is never painted.
  if (value !== synced) {
    setSynced(value);
    if (parseNumber(text) !== value) setText(numberText(value));
  }

  return (
    <input
      {...rest}
      type="number"
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(withoutLeadingZeros(e.target.value));
        onChange(parseNumber(e.target.value));
      }}
    />
  );
}

/**
 * A labelled field. The label is always linked to its control - the id is
 * generated when none is given - and the hint is announced with it.
 */
export function FormField({
  label,
  hint,
  id,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  id?: string;
  children: (control: { id: string; describedBy?: string }) => ReactNode;
}) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={fieldId}>{label}</label>
      {children({ id: fieldId, describedBy: hintId })}
      {hint && (
        <div className="field-hint" id={hintId}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** A rupee amount. Without a visible label, pass `ariaLabel` so it still has a name. */
export function MoneyInput({
  label,
  ariaLabel,
  value,
  onChange,
  currency: _currency,
  hint,
  min = 0,
  max,
  step = 1000,
  id,
}: {
  label?: string;
  ariaLabel?: string;
  value: number;
  onChange: (next: number) => void;
  currency: Currency;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  id?: string;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <div className="field">
      {label && <label htmlFor={inputId}>{label}</label>}
      <div className="input-prefix">
        <span aria-hidden="true">₹</span>
        <NumberInput
          id={inputId}
          className="input num"
          inputMode="decimal"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={onChange}
          aria-label={label ? undefined : ariaLabel}
          aria-describedby={hintId}
        />
      </div>
      {hint && (
        <div className="field-hint" id={hintId}>
          {hint}
        </div>
      )}
    </div>
  );
}
