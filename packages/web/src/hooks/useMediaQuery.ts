import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether a media query matches, kept in step as the window changes. Always
 * false when rendered on the server, where there is no window to ask.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
