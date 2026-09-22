/**
 * A model key the visitor supplies themselves.
 *
 * The static build ships no key and never will: a key baked into a public
 * bundle is readable by anyone who opens DevTools, and it would be the
 * publisher's key paying for every stranger's questions. But Groq's API sends
 * `access-control-allow-origin: *`, so a browser may call it directly - which
 * means a visitor who has their own key can use it without any server at all.
 *
 * The key is held in this browser's localStorage and sent to exactly one place,
 * `api.groq.com`, by the visitor's own browser. It is never transmitted to this
 * site, never committed, and never leaves the machine it was typed on. Clearing
 * site data removes it.
 */

const KEY = 'wealth-navigator/model-key';

export interface ModelKey {
  provider: 'groq';
  key: string;
}

/** Groq keys start `gsk_`. Checked so a mistyped paste fails here, not mid-answer. */
export function looksLikeGroqKey(value: string): boolean {
  return /^gsk_[A-Za-z0-9]{20,}$/.test(value.trim());
}

export function readModelKey(): ModelKey | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ModelKey>;
    if (parsed.provider === 'groq' && typeof parsed.key === 'string' && parsed.key) {
      return { provider: 'groq', key: parsed.key };
    }
  } catch {
    // Blocked storage, or a value written by an older build. No key is a
    // perfectly good answer - the agent runs deterministically without one.
  }
  return null;
}

export function writeModelKey(key: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ provider: 'groq', key: key.trim() }));
  } catch {
    // Over quota or blocked; the caller reports it.
  }
}

export function clearModelKey(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored, nothing to clear */
  }
}
