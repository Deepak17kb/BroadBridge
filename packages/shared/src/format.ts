import type { Currency } from './types.js';

/**
 * Money formatting, Indian-style throughout.
 *
 * The platform is INR-only. `Currency` is a single-member type rather than a
 * removed one: every call site reads `profile.currency`, and narrowing the type
 * lets the compiler prove no second currency can reach a formatter, which a
 * deleted parameter would not.
 */

const SYMBOL = '₹';
const LOCALE = 'en-IN';

/**
 * Lakh/crore abbreviations. A retirement corpus of 60000000 is unreadable;
 * "6.00 Cr" is not.
 */
export function formatCompact(value: number, _currency: Currency = 'INR'): string {
  const abs = Math.abs(value);
  /*
   * Units are chosen on the value as it will be *shown*, so a figure that
   * rounds up into the next unit is written in that unit: 99,999.6 is
   * "₹1.00 L", not "₹100.0k", and 9,999,999 is "₹1.00 Cr", not "₹100.00 L".
   * A value that rounds to zero carries no sign.
   */
  let body: string;
  if (abs >= 1e7 || Number((abs / 1e5).toFixed(2)) >= 100) body = `${(abs / 1e7).toFixed(2)} Cr`;
  else if (abs >= 1e5 || Number((abs / 1e3).toFixed(1)) >= 100) body = `${(abs / 1e5).toFixed(2)} L`;
  else if (abs >= 1e3 || Math.round(abs) >= 1000) body = `${(abs / 1e3).toFixed(1)}k`;
  else body = abs.toFixed(0);
  const sign = value < 0 && Number(body.replace(/[^\d.]/g, '')) !== 0 ? '-' : '';
  return `${sign}${SYMBOL}${body}`;
}

export function formatCurrency(value: number, _currency: Currency = 'INR', dp = 0): string {
  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: dp,
    minimumFractionDigits: dp,
  }).format(value);
}

export function formatPercent(value: number, dp = 1): string {
  return `${(value * 100).toFixed(dp)}%`;
}

export function formatNumber(value: number, _currency: Currency = 'INR'): string {
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(value);
}

export function formatYears(years: number): string {
  // Rounded to whole months first, so 1.99 years reads "2 years" rather than
  // the impossible "1y 12m", and 0.999 reads "1 year" rather than "12 months".
  const totalMonths = Math.round(years * 12);
  if (totalMonths < 12) return `${totalMonths} months`;
  const whole = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  if (months === 0) return `${whole} year${whole === 1 ? '' : 's'}`;
  return `${whole}y ${months}m`;
}

/** Signed delta string for scenario comparisons. */
export function formatDelta(value: number, currency: Currency = 'INR'): string {
  const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${prefix}${formatCompact(Math.abs(value), currency)}`;
}
