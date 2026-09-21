import type { ReactNode } from 'react';

/** What a section shows when it has nothing yet: what is missing, and the way forward. */
export function EmptyState({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <p className="empty-message">{message}</p>
      {action}
    </div>
  );
}
