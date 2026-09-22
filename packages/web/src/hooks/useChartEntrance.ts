import { useEffect, useState } from 'react';

/**
 * Animation that plays on arrival and then gets out of the way.
 *
 * Recharts' `isAnimationActive` covers mount *and* update with one flag, which
 * is why every chart here had it switched off: on the Scenario Lab the numbers
 * change on every frame of a slider drag, and an easing animation behind that
 * turns a live readout into a lagging smear.
 *
 * So the flag is true for the first paint only. The chart draws itself in when
 * the page opens, then settles to instant updates for the rest of its life.
 * A reduced-motion preference skips the entrance entirely.
 */
export function useChartEntrance(durationMs = 900): {
  isAnimationActive: boolean;
  animationDuration: number;
  animationEasing: 'ease-out';
} {
  const [active, setActive] = useState(() => !prefersReducedMotion());

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setActive(false), durationMs + 120);
    return () => window.clearTimeout(timer);
  }, [active, durationMs]);

  return {
    isAnimationActive: active,
    animationDuration: durationMs,
    animationEasing: 'ease-out',
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
