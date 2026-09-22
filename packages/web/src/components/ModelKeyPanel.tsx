import { useState } from 'react';
import { Callout } from './ui';
import {
  clearModelKey,
  looksLikeGroqKey,
  readModelKey,
  writeModelKey,
} from '../lib/agent/browserKey';

/**
 * Connects a language model to the static build, using a key the visitor owns.
 *
 * The deployment ships no key and never will - a key in a public bundle is
 * readable by anyone, and it would be the publisher's account paying for every
 * stranger's questions. But Groq allows browser origins, so a visitor who has
 * their own key can run the full model path with no server in the middle.
 *
 * The copy is deliberately explicit about where the key goes. Asking someone to
 * paste a credential is a thing that has to earn trust, and the honest facts -
 * this browser only, one destination, clearable in a click - are the argument.
 */
export function ModelKeyPanel({ onChange }: { onChange: () => void }) {
  const [connected, setConnected] = useState(() => readModelKey() !== null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  function connect() {
    const trimmed = value.trim();
    if (!looksLikeGroqKey(trimmed)) {
      setError('That does not look like a Groq key - they start with "gsk_".');
      return;
    }
    writeModelKey(trimmed);
    if (readModelKey() === null) {
      setError('Your browser would not store the key. Private browsing blocks this.');
      return;
    }
    setValue('');
    setError(null);
    setOpen(false);
    setConnected(true);
    onChange();
  }

  function disconnect() {
    clearModelKey();
    setConnected(false);
    setError(null);
    onChange();
  }

  if (connected) {
    return (
      <Callout tone="positive">
        <div className="row-between wrap gap-2">
          <span>
            Connected to <b>Groq</b> (openai/gpt-oss-120b) with your own key. Answers are written by
            the model; the arithmetic still comes from the platform's engine and every figure is
            checked against it. The free tier allows 8,000 tokens a minute, so a burst of questions
            may fall back to the rule-based engine for a moment.
          </span>
          <button className="btn btn-ghost btn-sm" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      </Callout>
    );
  }

  return (
    <Callout tone="info">
      <div className="stack-sm">
        <span>
          This build has no API server, so the agent is running <b>in your browser</b> — the same
          orchestrator, the same tools, the same grounding check on every figure. It has no language
          model, so it answers with its rule-based engine: the arithmetic is identical, the wording
          is less fluent.
        </span>
        {!open ? (
          <button className="btn btn-sm" onClick={() => setOpen(true)}>
            Connect your own Groq key
          </button>
        ) : (
          <div className="stack-sm">
            <label className="field-label" htmlFor="model-key">
              Groq API key
            </label>
            <div className="row wrap gap-2">
              <input
                id="model-key"
                type="password"
                className="input-short"
                placeholder="gsk_…"
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') connect();
                }}
              />
              <button className="btn btn-primary btn-sm" onClick={connect} disabled={!value.trim()}>
                Connect
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setOpen(false);
                  setValue('');
                  setError(null);
                }}
              >
                Cancel
              </button>
            </div>
            {error && <span className="text-negative text-sm">{error}</span>}
            <span className="text-muted text-sm">
              Stored in this browser only, and sent to one place: <code>api.groq.com</code>, by your
              browser. It never reaches this site, and clearing it here or clearing your site data
              removes it. Get a free key at <code>console.groq.com</code>. Use a key you can revoke.
            </span>
          </div>
        )}
      </div>
    </Callout>
  );
}
