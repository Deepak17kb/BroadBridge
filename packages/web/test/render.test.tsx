import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { PERSONAS, emptyProfile, type UserProfile } from '@wealth/shared';
import { ProfileProvider } from '../src/state/ProfileContext';
import { Dashboard } from '../src/pages/Dashboard';
import { Actions } from '../src/pages/Actions';
import { Goals } from '../src/pages/Goals';
import { Scenarios } from '../src/pages/Scenarios';
import { Portfolio } from '../src/pages/Portfolio';
import { Assistant } from '../src/pages/Assistant';
import { Assumptions } from '../src/pages/Assumptions';
import { Profile } from '../src/pages/Profile';
import { Onboarding } from '../src/pages/Onboarding';

/**
 * Smoke renders.
 *
 * Server-side rendering each page catches the whole class of bug that a
 * typecheck cannot: a property read on something that is empty at runtime, a
 * chart handed zero rows, a map over an array that does not exist yet. Effects
 * do not run under `renderToString`, so no network access is needed and the
 * test stays fast and hermetic.
 *
 * Each page is rendered against every persona *and* against an empty profile,
 * because "user who has entered nothing yet" is the state most easily broken.
 */

const PAGES = {
  Dashboard,
  Actions,
  Goals,
  Scenarios,
  Portfolio,
  Assistant,
  Assumptions,
  Profile,
} as const;

function render(profile: UserProfile, Page: () => JSX.Element): string {
  return renderToString(
    <MemoryRouter>
      <ProfileProvider initialProfile={profile}>
        <Page />
      </ProfileProvider>
    </MemoryRouter>,
  );
}

for (const persona of PERSONAS) {
  for (const [name, Page] of Object.entries(PAGES)) {
    test(`${name} renders for ${persona.id}`, () => {
      const html = render(structuredClone(persona.profile), Page as () => JSX.Element);
      assert.ok(html.length > 400, `${name} produced almost no markup`);
      // React escapes content, so a literal "undefined" or "NaN" in the output
      // is a formatting bug reaching the user rather than an artefact.
      assert.ok(!html.includes('>undefined<'), `${name} rendered a bare "undefined"`);
      assert.ok(!html.includes('NaN'), `${name} rendered NaN`);
      assert.ok(!html.includes('>Infinity<'), `${name} rendered Infinity`);
    });
  }
}

/** The hardest state to get right: nothing entered at all. */
test('every page survives a completely empty profile', () => {
  const empty = emptyProfile('empty-user', 'New User');
  for (const [name, Page] of Object.entries(PAGES)) {
    const html = render(structuredClone(empty), Page as () => JSX.Element);
    assert.ok(html.length > 200, `${name} produced almost no markup for an empty profile`);
    assert.ok(!html.includes('NaN'), `${name} rendered NaN for an empty profile`);
    assert.ok(!html.includes('>undefined<'), `${name} rendered "undefined" for an empty profile`);
  }
});

test('onboarding renders without a profile at all', () => {
  const html = renderToString(
    <MemoryRouter>
      <ProfileProvider>
        <Onboarding />
      </ProfileProvider>
    </MemoryRouter>,
  );
  assert.ok(html.includes('AI Wealth Navigator'));
  assert.ok(!html.includes('NaN'));
});

test('a profile with goals but no holdings does not break the portfolio page', () => {
  const profile = structuredClone(PERSONAS[0]!.profile);
  profile.holdings = [];
  profile.liquidSavings = 0;
  const html = render(profile, Portfolio);
  assert.ok(html.includes('No holdings recorded'));
  assert.ok(!html.includes('NaN'));
});

test('a profile with no goals does not break the goals page', () => {
  const profile = structuredClone(PERSONAS[1]!.profile);
  profile.goals = [];
  const html = render(profile, Goals);
  assert.ok(html.includes('No goals yet'));
  assert.ok(!html.includes('NaN'));
});

test('a debt-free profile does not break the portfolio page', () => {
  const profile = structuredClone(PERSONAS[2]!.profile);
  profile.liabilities = [];
  const html = render(profile, Portfolio);
  assert.ok(html.includes('Debt free'));
});
