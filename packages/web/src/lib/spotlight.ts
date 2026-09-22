/**
 * The spotlight: a pool of light that tracks the pointer across whichever
 * panel it is over, and takes its colour from whatever is under the cursor.
 *
 * CSS cannot know where inside an element the cursor is, so this writes the
 * position into two custom properties and the stylesheet draws the rest. The
 * cost is kept to one delegated listener for the whole document rather than
 * one per card, and one write per animation frame rather than one per pointer
 * event - a pointermove fires far more often than the screen refreshes, and
 * writing a custom property forces a repaint each time.
 *
 * The colour comes from `data-spot`, which anything with a colour of its own
 * declares - a chart segment, a legend swatch, a toned badge. The nearest one
 * above the cursor wins; with none, the light falls back to the accent. The
 * attribute is read rather than the element's computed background because a
 * `getComputedStyle` call per frame is the one thing that would make this
 * expensive, and a segment's colour is already known at render time.
 *
 * Only the panel under the pointer is ever touched, and it is cleaned up on
 * the way out, so at rest nothing is lit and nothing is listening per-element.
 */

/*
 * Every glass panel in the app, so the light follows the pointer on every
 * page rather than only the ones built out of cards. The list is the mirror
 * of the grouped `::before` rule in `styles.css` - a class in one and not the
 * other is either an unlit panel or a listener that paints nothing.
 */
const SELECTOR =
  '.card, .action, .chat-panel, .trace, .onboarding-card, .assistant-dock';

/*
 * Anything already coloured lends the light its colour.
 *
 * `data-spot` is exact and wins, but tagging every coloured figure by hand
 * would mean touching every component that prints a signed number. These
 * classes are the app's existing vocabulary for "this text is a status", so
 * reading them covers every gain, shortfall and warning on the platform for
 * free - including ones added later.
 *
 * Ordered most specific first: `.bar-fill.negative` also carries `.bar-fill`.
 */
const TONE_CLASSES: [string, string][] = [
  ['text-positive', 'var(--positive)'],
  ['text-negative', 'var(--negative)'],
  ['text-warning', 'var(--warning)'],
  ['text-accent', 'var(--accent)'],
  ['badge-positive', 'var(--positive)'],
  ['badge-negative', 'var(--negative)'],
  ['badge-warning', 'var(--warning)'],
  ['badge-info', 'var(--info)'],
  ['badge-accent', 'var(--accent)'],
];

const TONE_SELECTOR = `[data-spot], ${TONE_CLASSES.map(([c]) => `.${c}`).join(', ')}`;

/** The colour an element lends the spotlight, or '' for the default accent. */
function tintOf(el: HTMLElement | null): string {
  if (!el) return '';
  if (el.dataset.spot) return el.dataset.spot;
  for (const [cls, colour] of TONE_CLASSES) {
    if (el.classList.contains(cls)) return colour;
  }
  return '';
}

export function initSpotlight(): () => void {
  // A coarse pointer has no hover, so the whole effect is dead weight there.
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    return () => {};
  }
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return () => {};
  }

  let frame = 0;
  let pending: { el: HTMLElement; x: number; y: number; tint: string } | null = null;
  let lit: HTMLElement | null = null;
  let tinted = '';

  const paint = () => {
    frame = 0;
    if (!pending) return;
    const { el, x, y, tint } = pending;
    pending = null;
    el.style.setProperty('--mx', `${x}px`);
    el.style.setProperty('--my', `${y}px`);
    // Only touched when it actually changes - the tint holds steady across
    // most of a drag, and rewriting it every frame would repaint for nothing.
    if (tint !== tinted) {
      tinted = tint;
      if (tint) el.style.setProperty('--spot', tint);
      else el.style.removeProperty('--spot');
    }
  };

  const clear = (el: HTMLElement) => {
    el.style.removeProperty('--mx');
    el.style.removeProperty('--my');
    el.style.removeProperty('--spot');
    el.classList.remove('is-lit');
  };

  const onMove = (event: PointerEvent) => {
    const target = event.target as Element | null;
    const el = target?.closest?.(SELECTOR) as HTMLElement | null;

    if (el !== lit) {
      if (lit) clear(lit);
      lit = el;
      tinted = '';
      if (el) el.classList.add('is-lit');
    }
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const source = target?.closest?.(TONE_SELECTOR) as HTMLElement | null;
    pending = {
      el,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      tint: tintOf(source),
    };
    if (!frame) frame = requestAnimationFrame(paint);
  };

  const onLeave = () => {
    if (lit) clear(lit);
    lit = null;
  };

  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerleave', onLeave);
  window.addEventListener('blur', onLeave);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    if (lit) clear(lit);
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerleave', onLeave);
    window.removeEventListener('blur', onLeave);
  };
}
