/**
 * Loading placeholders, shaped like what they stand in for, so the layout does
 * not jump when the data arrives. The shimmer is off under reduced motion.
 */

export function Skeleton({
  variant = 'line',
  width,
  className = '',
}: {
  variant?: 'line' | 'title' | 'value' | 'block';
  width?: string;
  className?: string;
}) {
  return (
    <span
      className={`skeleton skeleton-${variant} ${className}`.trim()}
      style={width ? { width } : undefined}
      aria-hidden="true"
    />
  );
}

/** A card-shaped placeholder: a title, then `lines` lines or a chart block. */
export function SkeletonCard({ lines = 3, block = false }: { lines?: number; block?: boolean }) {
  return (
    <div className="card" aria-hidden="true">
      <div className="stack-sm">
        <Skeleton variant="title" />
        {block ? (
          <Skeleton variant="block" className="mt-2" />
        ) : (
          Array.from({ length: lines }, (_, i) => (
            <Skeleton key={i} width={i === lines - 1 ? '62%' : undefined} />
          ))
        )}
      </div>
    </div>
  );
}

/** A row of figure placeholders, as in a KPI strip. */
export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-4" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="stack-sm">
          <Skeleton width="55%" />
          <Skeleton variant="value" />
          <Skeleton width="70%" />
        </div>
      ))}
    </div>
  );
}

/** What a page shows while it restores a saved plan - the shape of a dashboard. */
export function PageSkeleton() {
  return (
    <div className="stack" role="status" aria-live="polite">
      <span className="sr-only">Loading your plan</span>
      <div className="stack-sm">
        <Skeleton variant="title" width="30%" />
        <Skeleton width="55%" />
      </div>
      <div className="card">
        <SkeletonStats />
      </div>
      <div className="grid grid-2">
        <SkeletonCard lines={4} />
        <SkeletonCard block />
      </div>
    </div>
  );
}
