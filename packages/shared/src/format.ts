import { CURRENCY_META, USD_INR_RATE } from './assumptions.js';
import type { Currency } from './types.js';

/**
 * Indian-style abbreviations (L / Cr) for INR and Western (K / M) for USD.
 * A retirement corpus of 60000000 is unreadable; "6.00 Cr" is not.
 */
export function formatCompact(value: number, currency: Currency = 'INR'): string {
  const symbol = CURRENCY_META[currency].symbol;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (currency === 'INR') {
    if (abs >= 1e7) return `${sign}${symbol}${(abs / 1e7).toFixed(2)} Cr`;
    if (abs >= 1e5) return `${sign}${symbol}${(abs / 1e5).toFixed(2)} L`;
    if (abs >= 1e3) return `${sign}${symbol}${(abs / 1e3).toFixed(1)}k`;
    return `${sign}${symbol}${abs.toFixed(0)}`;
  }
  if (abs >= 1e9) return `${sign}${symbol}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${symbol}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${symbol}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${symbol}${abs.toFixed(0)}`;
}

export function formatCurrency(value: number, currency: Currency = 'INR', dp = 0): string {
  const meta = CURRENCY_META[currency];
  return new Intl.NumberFormat(meta.locale, {
    style: 'currency',
    currency: meta.code,
    maximumFractionDigits: dp,
    minimumFractionDigits: dp,
  }).format(value);
}

export function formatPercent(value: number, dp = 1): string {
  return `${(value * 100).toFixed(dp)}%`;
}

export function formatNumber(value: number, currency: Currency = 'INR'): string {
  return new Intl.NumberFormat(CURRENCY_META[currency].locale, {
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Illustrative FX conversion, used only when the user flips display currency.
 * Not a market rate and not intended as one.
 */
export function convertCurrency(value: number, from: Currency, to: Currency): number {
  if (from === to) return value;
  return from === 'INR' ? value / USD_INR_RATE : value * USD_INR_RATE;
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
