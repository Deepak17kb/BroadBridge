import { useState } from 'react';
import { formatPercent, RISK_BUCKETS, type RiskBucket } from '@wealth/shared';
import type { LadderRow } from './RiskLadder';

/**
 * The risk ladder as a dial, with willingness and ability marked on it.
 *
 * The scale this replaced was a row of five blocks with the bucket names cut
 * to four letters to fit ("Cons / Mode / Bala"), which is a label nobody can
 * read. A dial has room for the name in the middle instead of under every
 * segment, and the arc gives the two scores somewhere to sit that reads as a
 * position rather than a bar length.
 *
 * The segments are sized by their *real* score bands - 0-25, 25-45, 45-65,
 * 65-82, 82-100, which are not equal - so a marker at 73 lands inside the
 * segment the engine actually assigns it to. Drawing five equal fifths would
 * have put the needle in the wrong bucket for most scores.
 */

/** Where each bucket ends, matching `bucketFor` in the shared engine. */
const BAND_END: Record<RiskBucket, number> = {
  Conservative: 25,
  Moderate: 45,
  Balanced: 65,
  Growth: 82,
  Aggressive: 100,
};

/** A cool-to-warm ramp: this encodes how much risk, not whether it is good. */
const BAND_COLOUR: Record<RiskBucket, string> = {
  Conservative: 'var(--risk-1)',
  Moderate: 'var(--risk-2)',
  Balanced: 'var(--risk-3)',
  Growth: 'var(--risk-4)',
  Aggressive: 'var(--risk-5)',
};

const SWEEP = 240;
const START = -120;
const THICKNESS = 18;
const POP = 1.05;

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const from = polar(cx, cy, r, start);
  const to = polar(cx, cy, r, end);
  const large = end - start > 180 ? 1 : 0;
  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
}

/** A 0-100 score to its angle on the dial. */
const angleFor = (score: number) => START + (Math.max(0, Math.min(100, score)) / 100) * SWEEP;

export function RiskDial({
  bucket,
  willingness,
  ability,
  ladder = [],
  size = 260,
}: {
  bucket: RiskBucket;
  willingness: number;
  ability: number;
  /** Optional: lets a hovered segment show what that mix returns and costs. */
  ladder?: LadderRow[];
  size?: number;
}) {
  const [hovered, setHovered] = useState<RiskBucket | null>(null);

  /*
   * The drawing is wider than it is tall.
   *
   * A 240-degree arc leaves its gap at the bottom, so the lower sixth of a
   * square viewBox is always empty - and paying for that height squeezed the
   * ring itself. Cropping the box to the arc's real extent lets the same
   * component draw a noticeably larger dial in less vertical space.
   */
  const height = Math.round(size * 0.78);
  const cx = size / 2;
  const cy = size / 2;
  /*
   * Room outside the arc for the score labels. The binding constraint is a
   * label at the far left or right, where it runs horizontally away from the
   * dial: at a 30px inset "Ability" on a near-zero score overshot the box.
   */
  const radius = size / 2 - THICKNESS / 2 - size * (POP - 1) - 34;

  const bindingIsWillingness = willingness <= ability;
  const lower = Math.min(willingness, ability);
  const higher = Math.max(willingness, ability);

  let from = 0;
  const segments = RISK_BUCKETS.map((b) => {
    const seg = { bucket: b, start: angleFor(from), end: angleFor(BAND_END[b]) };
    from = BAND_END[b];
    return seg;
  });

  const active = hovered ?? bucket;
  const activeRow = ladder.find((r) => r.bucket === active);

  return (
    <div className="dial" style={{ ['--dial-size' as string]: `${size}px` }} onMouseLeave={() => setHovered(null)}>
      <svg
        width={size}
        height={height}
        viewBox={`0 0 ${size} ${height}`}
        role="img"
        aria-label={`Risk profile ${bucket}. Willingness ${Math.round(willingness)}, ability ${Math.round(ability)} out of 100. The plan follows the lower of the two.`}
      >
        {segments.map((s) => {
          const isHovered = hovered === s.bucket;
          const isActive = s.bucket === bucket;
          return (
            <g
              key={s.bucket}
              className={`dial-seg${isHovered ? ' is-hovered' : ''}${isActive ? ' is-active' : ''}`}
              style={{
                transformOrigin: `${cx}px ${cy}px`,
                transform: isHovered ? `scale(${POP})` : undefined,
                color: BAND_COLOUR[s.bucket],
              }}
              onMouseEnter={() => setHovered(s.bucket)}
              data-spot={BAND_COLOUR[s.bucket]}
            >
              <path
                d={arcPath(cx, cy, radius, s.start + 1.2, s.end - 1.2)}
                fill="none"
                stroke={BAND_COLOUR[s.bucket]}
                strokeWidth={THICKNESS}
                strokeLinecap="butt"
              />
              {/* A wider invisible arc, so the gaps are not dead zones. */}
              <path
                d={arcPath(cx, cy, radius, s.start, s.end)}
                fill="none"
                stroke="transparent"
                strokeWidth={THICKNESS + 12}
              />
            </g>
          );
        })}

        {/* The span between the two scores: the disagreement the plan resolves. */}
        <path
          d={arcPath(cx, cy, radius - THICKNESS / 2 - 7, angleFor(lower), angleFor(higher))}
          fill="none"
          stroke="var(--text-subtle)"
          strokeWidth={2}
          strokeLinecap="round"
          opacity={0.45}
        />

        <Marker
          cx={cx}
          cy={cy}
          r={radius}
          score={higher}
          label={bindingIsWillingness ? 'Ability' : 'Willing'}
          binding={false}
        />
        <Marker
          cx={cx}
          cy={cy}
          r={radius}
          score={lower}
          label={bindingIsWillingness ? 'Willing' : 'Ability'}
          binding
        />
      </svg>

      {/*
        * Only the bucket name sits inside the ring - it is the one string
        * short enough to fit the arc's inner circle. The detail line used to
        * live here too and ran straight through the segments on both sides.
        */}
      <div className="dial-center" aria-hidden="true">
        <div className="dial-bucket" key={active}>
          {active}
        </div>
      </div>

      <div className="dial-detail" aria-hidden="true">
        {hovered && activeRow ? (
          <>
            <strong>{active}</strong> returns{' '}
            <span className="num">{formatPercent(activeRow.expectedReturnPct)}</span> a year for a{' '}
            <span className="num">{formatPercent(activeRow.volatilityPct)}</span> typical swing
          </>
        ) : hovered ? (
          <>
            <strong>{active}</strong> — hover a band to price it
          </>
        ) : (
          <>
            The plan follows the lower of the two, so it uses <strong>{bucket}</strong>.
          </>
        )}
      </div>

      <dl className="dial-legend">
        <div className={bindingIsWillingness ? 'is-binding' : undefined}>
          <dt>
            <span className={`dial-key${bindingIsWillingness ? ' is-binding' : ''}`} />
            Willingness
          </dt>
          <dd className="num">{Math.round(willingness)}</dd>
        </div>
        <div className={bindingIsWillingness ? undefined : 'is-binding'}>
          <dt>
            <span className={`dial-key${bindingIsWillingness ? '' : ' is-binding'}`} />
            Ability
          </dt>
          <dd className="num">{Math.round(ability)}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * A dot on the arc with its score printed just outside it.
 *
 * The dot alone said "somewhere around here"; the number is what makes the
 * dial readable as a position. It is placed along the same radius the dot
 * sits on, so the label follows the mark around the arc instead of needing a
 * leader line, and it is anchored by which side of the dial it lands on -
 * otherwise a label on the left would run back over the ring.
 */
function Marker({
  cx,
  cy,
  r,
  score,
  label,
  binding,
}: {
  cx: number;
  cy: number;
  r: number;
  score: number;
  label: string;
  binding: boolean;
}) {
  const angle = angleFor(score);
  const p = polar(cx, cy, r, angle);
  const text = polar(cx, cy, r + 20, angle);
  const anchor = angle < -8 ? 'end' : angle > 8 ? 'start' : 'middle';

  return (
    <g className={`dial-mark${binding ? ' is-binding' : ''}`}>
      <circle cx={p.x} cy={p.y} r={binding ? 8 : 6.5} />
      <text x={text.x} y={text.y} textAnchor={anchor} className="dial-mark-value">
        {Math.round(score)}
      </text>
      <text x={text.x} y={text.y + 11} textAnchor={anchor} className="dial-mark-label">
        {label}
      </text>
    </g>
  );
}
