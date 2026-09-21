import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PERSONAS, type UserProfile } from '@wealth/shared';
import { ProfileProvider } from '../src/state/ProfileContext';
import { Actions } from '../src/pages/Actions';
import { Goals } from '../src/pages/Goals';
import { Portfolio } from '../src/pages/Portfolio';
import { Profile } from '../src/pages/Profile';

/**
 * Regression renders for bugs found in a full-platform bug sweep. Typing
 * behaviour is exercised in the browser; what server rendering can pin is the
 * text each field starts from and what the pages claim.
 */

function render(profile: UserProfile, Page: () => JSX.Element): string {
  return renderToString(
    <MemoryRouter>
      <ProfileProvider initialProfile={profile}>
        <Page />
      </ProfileProvider>
    </MemoryRouter>,
  );
}

const persona = (id: string): UserProfile =>
  structuredClone(PERSONAS.find((p) => p.id === id)!.profile);

test('rate fields start from the plain number, not a toFixed string that rewrites itself', () => {
  // A controlled input showing "6.0" or "42.00" is re-formatted on every
  // keystroke; these fields keep their own text and start from the number.
  const goals = render(persona('aarav'), Goals);
  assert.match(goals, /id="goal-inflation"[^>]*value="6"/, 'goal inflation reads 6, not 6.0');

  const portfolio = render(persona('aarav'), Portfolio);
  assert.match(portfolio, /aria-label="Interest rate percent"[^>]*value="42"/, 'card rate reads 42, not 42.00');
});

test('the goal and profile number fields are the self-validating kind', () => {
  const goals = render(persona('meera'), Goals);
  // NumberInput renders a "0" placeholder; the raw inputs it replaced did not.
  for (const id of ['goal-year', 'goal-stepup', 'goal-inflation']) {
    assert.match(goals, new RegExp(`id="${id}"[^>]*placeholder="0"`), `${id} keeps its own text`);
  }
  const profile = render(persona('meera'), Profile);
  for (const id of ['p-age', 'p-retire', 'p-dependents', 'p-growth']) {
    assert.match(profile, new RegExp(`id="${id}"[^>]*placeholder="0"`), `${id} keeps its own text`);
  }
});

test('the actions page no longer adds incommensurable impacts into one "upside"', () => {
  for (const p of PERSONAS) {
    const html = render(structuredClone(p.profile), Actions);
    assert.ok(!html.includes('Quantified upside'), `${p.id}: no summed upside`);
    assert.ok(html.includes('One-click actions'), `${p.id}: counts what the platform can apply`);
  }
});
