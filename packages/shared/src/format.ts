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
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}${SYMBOL}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${SYMBOL}${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}${SYMBOL}${(abs / 1e3).toFixed(1)}k`;
  return `${sign}${SYMBOL}${abs.toFixed(0)}`;
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
  if (years < 1) return `${Math.round(years * 12)} months`;
  const whole = Math.floor(years);
  const months = Math.round((years - whole) * 12);
  if (months === 0) return `${whole} year${whole === 1 ? '' : 's'}`;
  return `${whole}y ${months}m`;
}

/** Signed delta string for scenario comparisons. */
export function formatDelta(value: number, currency: Currency = 'INR'): string {
  const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${prefix}${formatCompact(Math.abs(value), currency)}`;
}
