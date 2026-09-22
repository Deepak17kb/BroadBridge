import { useState } from 'react';
import type { WellnessScore } from '@wealth/shared';

/**
 * The wellness score, decomposed into the five pillars that produce it.
 *
 * The ring this replaced stated the total and nothing else - a number in a
 * circle, where the circle carried no information. Here the ring *is* the
 * arithmetic: each pillar owns an arc as wide as its weight in the score
 * (Protection 25%, Cashflow 20%, and so on) and fills that arc in proportion
 * to how it scored. So a wide, empty arc is instantly legible as "the thing
 * costing you the most points", which is the question this card exists to
 * answer and which the old ring could not address at all.
 *
 * Hovering an arc pops it out of the ring and swaps the centre for that
 * pillar's own reading, so the detail is available without a legend.
 */

/** Degrees of empty space between two arcs, so the segments read as separate. */
const GAP = 3;
const THICKNESS = 13;
/** How far a hovered arc grows, as a scale factor about the centre. */
const POP = 1.055;

interface Segment {
  name: string;
  score: number;
  weight: number;
  summary: string;
  scored: boolean;
  start: number;
  sweep: number;
  tone: 'positive' | 'warning' | 'negative';
  colour: string;
}

/** A point on the circle, with 0 degrees at twelve o'clock. */
function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** The centreline of an arc, drawn clockwise, to be stroked rather than filled. */
function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const from = polar(cx, cy, r, start);
  const to = polar(cx, cy, r, end);
  const large = end - start > 180 ? 1 : 0;
  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
}

function toneFor(score: number): Segment['tone'] {
  return score >= 80 ? 'positive' : score >= 55 ? 'warning' : 'negative';
}

export function WellnessGauge({
  wellness,
  size = 208,
}: {
  wellness: WellnessScore;
  size?: number;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const cx = size / 2;
  const cy = size / 2;
  // Room for the pop, so a grown arc is not clipped by the viewBox.
  const radius = size / 2 - THICKNESS / 2 - size * (POP - 1) - 2;

  const usable = 360 - GAP * wellness.pillars.length;
  let cursor = 0;
  const segments: Segment[] = wellness.pillars.map((p) => {
    const sweep = p.weight * usable;
    const tone = toneFor(p.score);
    const seg: Segment = {
      name: p.name,
      score: p.score,
      weight: p.weight,
      summary: p.summary,
      scored: p.scored,
      start: cursor,
      sweep,
      tone,
      colour: `var(--${tone})`,
    };
    cursor += sweep + GAP;
    return seg;
  });

  const active = hovered === null ? null : segments[hovered];
  const circumference = 2 * Math.PI * radius;

  return (
    <div
      className="gauge"
      style={{ ['--gauge-size' as string]: `${size}px` }}
      onMouseLeave={() => setHovered(null)}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`Wellness score ${wellness.total} out of 100${
          wellness.dataComplete ? `, grade ${wellness.grade}` : ''
        }. ${segments
          .map((s) =>
            s.scored
              ? `${s.name} ${s.score} of 100, ${Math.round(s.weight * 100)} percent of the score`
              : `${s.name} not scored`,
          )
          .join('. ')}`}
      >
        {segments.map((s, i) => {
          const isHovered = hovered === i;
          const filled = s.scored ? (s.sweep * Math.max(0, Math.min(100, s.score))) / 100 : 0;
          // The dash runs along the whole circle, so the visible length is a
          // share of the circumference rather than of the segment.
          const fillLength = (circumference * filled) / 360;

          return (
            <g
              key={s.name}
              className={`gauge-seg${isHovered ? ' is-hovered' : ''}`}
              style={{
                transformOrigin: `${cx}px ${cy}px`,
                transform: isHovered ? `scale(${POP})` : undefined,
                /* Sets `currentColor` for this arc, which is what the hover
                   glow in the stylesheet tints itself from. */
                color: s.colour,
              }}
              onMouseEnter={() => setHovered(i)}
              /* Lends the panel's spotlight this pillar's status colour. */
              data-spot={s.colour}
            >
              {/* The pillar's full weight: the points it could have earned. */}
              <path
                d={arcPath(cx, cy, radius, s.start, s.start + s.sweep)}
                fill="none"
                stroke="var(--surface-sunken)"
                strokeWidth={THICKNESS}
                strokeLinecap="round"
              />
              {/* What it actually earned. */}
              {filled > 0.4 && (
                <path
                  className="gauge-fill"
                  d={arcPath(cx, cy, radius, s.start, s.start + s.sweep)}
                  fill="none"
                  stroke={s.colour}
                  strokeWidth={THICKNESS}
                  strokeLinecap="round"
                  strokeDasharray={`${fillLength} ${circumference}`}
                  style={{ ['--fill-len' as string]: fillLength, animationDelay: `${i * 90}ms` }}
                />
              )}
              {/* A wide invisible arc, so the thin gaps are not dead zones and
                  an unscored pillar is still hoverable. */}
              <path
                d={arcPath(cx, cy, radius, s.start, s.start + s.sweep)}
                fill="none"
                stroke="transparent"
                strokeWidth={THICKNESS + 10}
              />
            </g>
          );
        })}
      </svg>

      <div className="gauge-center" aria-hidden="true">
        {active ? (
          <div className="gauge-detail" key={active.name}>
            <div className="gauge-detail-name">{active.name}</div>
            <div className={`gauge-detail-score text-${active.tone}`}>
              {active.scored ? active.score : '—'}
            </div>
            <div className="gauge-detail-weight">{Math.round(active.weight * 100)}% of score</div>
          </div>
        ) : (
          <div className="gauge-total">
            <div className="gauge-total-value">{wellness.total}</div>
            {wellness.dataComplete && <div className="gauge-total-grade">Grade {wellness.grade}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
