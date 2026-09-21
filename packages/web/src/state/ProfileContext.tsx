import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  buildSnapshot,
  type FinancialSnapshot,
  type UserProfile,
} from '@wealth/shared';
import { api } from '../lib/api';

/**
 * The single source of client state.
 *
 * The snapshot is computed *locally* from the profile with the shared engine,
 * which is what makes every slider and input feel instant - no round trip to
 * see the effect of a change. The server is then updated in the background and
 * is authoritative for persistence, not for display.
 *
 * The same engine runs in both places, so the optimistic local number and the
 * eventual server number are identical by construction rather than by luck.
 */

const STORAGE_KEY = 'wealth-navigator/profile-id';
const THEME_KEY = 'wealth-navigator/theme';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface ProfileContextValue {
  profile: UserProfile | null;
  snapshot: FinancialSnapshot | null;
  loading: boolean;
  saveState: SaveState;
  error: string | null;
  /** Applies a change locally at once, then persists it. */
  updateProfile: (mutate: (draft: UserProfile) => void) => void;
  /** Replaces the whole profile (used by onboarding). */
  setProfile: (profile: UserProfile) => void;
  createFromPersona: (personaId?: string, displayName?: string) => Promise<UserProfile>;
  reset: () => void;
  theme: 'dark' | 'light';
  toggleTheme: () => void;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

function readTheme(): 'dark' | 'light' {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // Private browsing or blocked storage - fall through to the default.
  }
  return 'dark';
}

export function ProfileProvider({
  children,
  /**
   * Seeds the provider synchronously. Used by the smoke-render tests so pages
   * can be exercised without a network round trip; unused in the app itself.
   */
  initialProfile,
}: {
  children: ReactNode;
  initialProfile?: UserProfile;
}) {
  const [profile, setProfileState] = useState<UserProfile | null>(initialProfile ?? null);
  const [loading, setLoading] = useState(!initialProfile);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(readTheme);

  const saveTimer = useRef<number | undefined>(undefined);
  const pending = useRef<UserProfile | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Not fatal - the theme simply will not persist across reloads.
    }
  }, [theme]);

  /** Restores the last profile on load, if the server still has it. */
  useEffect(() => {
    if (initialProfile) return;
    let cancelled = false;
    (async () => {
      let storedId: string | null = null;
      try {
        storedId = localStorage.getItem(STORAGE_KEY);
      } catch {
        // No storage access; the user starts at onboarding.
      }
      if (!storedId) {
        if (!cancelled) setLoading(false);
        return;
      }
      try {
        const loaded = await api.getProfile(storedId);
        if (!cancelled) setProfileState(loaded);
      } catch {
        // The API restarts with an in-memory store in local development, so a
        // stale id is expected rather than exceptional.
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* ignore */
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialProfile]);

  /**
   * Debounced persistence. Dragging a slider produces dozens of changes a
   * second; each one updates the UI immediately but only the last one is sent.
   */
  const schedulePersist = useCallback((next: UserProfile) => {
    pending.current = next;
    setSaveState('saving');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const toSave = pending.current;
      if (!toSave) return;
      try {
        await api.saveProfile(toSave);
        setSaveState('saved');
        setError(null);
        window.setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1600);
      } catch (err) {
        // The local state stays - losing the user's edit because the network
        // blipped would be far worse than a stale server copy.
        setSaveState('error');
        setError(err instanceof Error ? err.message : 'Could not save your changes');
      }
    }, 600);
  }, []);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  const updateProfile = useCallback(
    (mutate: (draft: UserProfile) => void) => {
      setProfileState((current) => {
        if (!current) return current;
        const draft = structuredClone(current);
        mutate(draft);
        draft.updatedAt = new Date().toISOString();
        schedulePersist(draft);
        return draft;
      });
    },
    [schedulePersist],
  );

  const setProfile = useCallback((next: UserProfile) => {
    setProfileState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next.id);
    } catch {
      /* ignore */
    }
  }, []);

  const createFromPersona = useCallback(
    async (personaId?: string, displayName?: string) => {
      setLoading(true);
      try {
        const { profile: created } = await api.createProfile({ personaId, displayName });
        setProfile(created);
        setError(null);
        return created;
      } finally {
        setLoading(false);
      }
    },
    [setProfile],
  );

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setProfileState(null);
    setSaveState('idle');
  }, []);


  // Recomputed on every profile change. The engine is pure arithmetic over a
  // small object graph, so this is microseconds - cheap enough to run on each
  // keystroke and far simpler than caching it.
  const snapshot = useMemo(() => (profile ? buildSnapshot(profile) : null), [profile]);

  const value = useMemo<ProfileContextValue>(
    () => ({
      profile,
      snapshot,
      loading,
      saveState,
      error,
      updateProfile,
      setProfile,
      createFromPersona,
      reset,
      theme,
      toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    }),
    [
      profile,
      snapshot,
      loading,
      saveState,
      error,
      updateProfile,
      setProfile,
      createFromPersona,
      reset,
      theme,
    ],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used inside a ProfileProvider');
  return ctx;
}

/**
 * Convenience hook for pages that cannot render without a profile. The router
 * guards these routes, so a missing profile here is a programming error.
 */
export function useLoadedProfile(): { profile: UserProfile; snapshot: FinancialSnapshot } {
  const { profile, snapshot } = useProfile();
  if (!profile || !snapshot) throw new Error('This screen requires a loaded profile');
  return { profile, snapshot };
}
