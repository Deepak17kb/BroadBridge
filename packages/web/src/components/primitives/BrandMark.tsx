/**
 * The brand mark: a cartographer's north arrow.
 *
 * The product is called Navigator and every screen in it is about plotting a
 * course and holding to it, so the mark is the thing a chart uses to say
 * which way is north. It replaced a generic rising-zigzag line - the same
 * glyph a hundred other finance products use, and one that said "number went
 * up" rather than anything about this platform.
 *
 * It is filled artwork rather than a member of the stroked icon set: a mark
 * needs more weight than a 1.75px line at 18px, and the two-tone split is
 * what gives it dimension at tile size.
 */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* The shaded half, reading as the face turned away from the light. */}
      <path d="M12 2.4 5.6 21.2 12 15.7Z" fill="currentColor" fillOpacity={0.42} />
      {/* The lit half. */}
      <path d="M12 2.4 18.4 21.2 12 15.7Z" fill="currentColor" />
    </svg>
  );
}
