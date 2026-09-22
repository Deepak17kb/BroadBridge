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
import { Onboarding, checkAges } from '../src/pages/Onboarding';
import { MoneyInput, NumberInput, withoutLeadingZeros } from '../src/components/ui';
import { fundedAxis } from '../src/components/charts/Charts';

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

/* -------------------------------------------------------------------------- */
/* Number fields                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A field holding 0 used to keep that 0 as text, so typing "85000" into it
 * showed "085000": React leaves a number input alone when its text already
 * parses to the controlled value. Zero is now a placeholder. What typing does
 * to the field needs a DOM and was verified in the browser; these pin the parts
 * that decide it.
 */

test('a zero number field is empty with a 0 placeholder, not the text 0', () => {
  const zero = renderToString(<NumberInput value={0} onChange={() => undefined} />);
  assert.match(zero, /value=""/);
  assert.match(zero, /placeholder="0"/);

  const set = renderToString(<NumberInput value={85000} onChange={() => undefined} />);
  assert.match(set, /value="85000"/);
});

test('a money field holding zero shows the placeholder, not the text 0', () => {
  const html = renderToString(<MoneyInput value={0} currency="INR" onChange={() => undefined} />);
  assert.match(html, /value=""/);
  assert.match(html, /placeholder="0"/);
  assert.ok(!/value="0"/.test(html), 'a stored zero must not render as typed text');
});

test('leading zeros disappear as they are typed, the zero in a decimal does not', () => {
  // The reported case: a field showing 0, with 85000 typed after it.
  assert.equal(withoutLeadingZeros('085000'), '85000');
  assert.equal(withoutLeadingZeros('02'), '2');
  assert.equal(withoutLeadingZeros('0007'), '7');
  assert.equal(withoutLeadingZeros('-05'), '-5');
  // A zero the user means stays.
  assert.equal(withoutLeadingZeros('0'), '0');
  assert.equal(withoutLeadingZeros('0.5'), '0.5');
  assert.equal(withoutLeadingZeros('10'), '10');
  assert.equal(withoutLeadingZeros('8.05'), '8.05');
  assert.equal(withoutLeadingZeros(''), '');
});

/* -------------------------------------------------------------------------- */
/* Onboarding ages                                                             */
/* -------------------------------------------------------------------------- */

test('blank ages hold Continue back without a warning', () => {
  // The wizard starts both ages at 0: not entered yet, so not wrong yet.
  assert.deepEqual(checkAges({ age: 0, retirementAge: 0 }), { ready: false, problems: [] });
  assert.deepEqual(checkAges({ age: 32, retirementAge: 0 }), { ready: false, problems: [] });
  assert.deepEqual(checkAges({ age: 0, retirementAge: 60 }), { ready: false, problems: [] });
});

test('entered ages continue only when they make sense', () => {
  assert.deepEqual(checkAges({ age: 32, retirementAge: 60 }), { ready: true, problems: [] });

  const early = checkAges({ age: 45, retirementAge: 40 });
  assert.equal(early.ready, false);
  assert.deepEqual(early.problems, ['Retirement age needs to be higher than your current age.']);

  const equal = checkAges({ age: 60, retirementAge: 60 });
  assert.equal(equal.ready, false, 'retiring at the age you already are leaves nothing to plan');

  assert.deepEqual(checkAges({ age: 12, retirementAge: 60 }).problems, ['Enter an age between 16 and 100.']);
  assert.deepEqual(checkAges({ age: 30, retirementAge: 120 }).problems, ['Retirement age can be at most 100.']);
});

test('the goal list sits in an aside that sizes to its content, not the column beside it', () => {
  /*
   * Grid items stretch to the row by default, which left the card as tall as
   * the detail column - over a thousand pixels of empty card below three goals.
   *
   * The fix moved from `self-start` on the card to `sticky-aside` on the
   * column that holds it. That distinction is the point of this test: in a
   * flex column `self-start` acts on the cross axis, so leaving it on the card
   * shrank every goal to the width of its own text.
   */
  const html = render(structuredClone(PERSONAS[0]!.profile), Goals);
  assert.match(
    html,
    /<div class="stack sticky-aside"><section class="card"><header class="card-head"><div class="card-heading"><h2 class="card-title">Your goals<\/h2>/,
  );
  assert.doesNotMatch(
    html,
    /<section class="card[^"]*self-start[^"]*">[\s\S]{0,200}Your goals/,
    'self-start on the card itself would collapse its width inside the flex column',
  );
});

/* -------------------------------------------------------------------------- */
/* Accessibility                                                               */
/* -------------------------------------------------------------------------- */

/** Heading levels in document order. */
function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
}

test('every page has one h1 and its headings never skip a level', () => {
  // The cards used h3 titles straight under the page's h1.
  for (const persona of PERSONAS) {
    for (const [name, Page] of Object.entries(PAGES)) {
      const levels = headingLevels(render(structuredClone(persona.profile), Page as () => JSX.Element));
      const where = `${name} (${persona.id})`;
      assert.equal(levels[0], 1, `${where} starts with its h1`);
      assert.equal(levels.filter((l) => l === 1).length, 1, `${where} has exactly one h1`);
      levels.forEach((level, i) => {
        const previous = levels[i - 1];
        if (previous !== undefined) {
          assert.ok(level <= previous + 1, `${where}: an h${previous} is followed by an h${level}`);
        }
      });
    }
  }
});

/**
 * Controls with no accessible name: no aria-label or aria-labelledby, no
 * <label for> pointing at them, and no <label> around them.
 */
function unnamedControls(html: string): string[] {
  const labelled = new Set([...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]));
  const unnamed: string[] = [];
  for (const match of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = match[2]!;
    if (/type="hidden"/.test(attrs) || /aria-label(ledby)?="[^"]+"/.test(attrs)) continue;
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    if (id && labelled.has(id)) continue;
    const before = html.slice(0, match.index);
    if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue;
    unnamed.push(`<${match[1]}${attrs.slice(0, 90)}>`);
  }
  return unnamed;
}

test('every form control has an accessible name', () => {
  // 25 of the 26 money fields showed a label that was linked to nothing, so a
  // screen reader announced a bare "edit text".
  for (const persona of PERSONAS) {
    for (const [name, Page] of Object.entries(PAGES)) {
      const html = render(structuredClone(persona.profile), Page as () => JSX.Element);
      assert.deepEqual(unnamedControls(html), [], `${name} (${persona.id})`);
    }
  }
  const empty = emptyProfile('empty-user', 'New User');
  for (const [name, Page] of Object.entries(PAGES)) {
    const html = render(structuredClone(empty), Page as () => JSX.Element);
    assert.deepEqual(unnamedControls(html), [], `${name} (empty profile)`);
  }
});

test('the goal list is one tab stop, on the selected goal', () => {
  // Arrow keys move between goals (verified in the browser); Tab should reach
  // the list once, not once per goal.
  const html = render(structuredClone(PERSONAS[0]!.profile), Goals);
  const items = [...html.matchAll(/<button type="button" class="goal-item[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.ok(items.length >= 2, 'the persona has several goals');
  assert.equal(items.filter((item) => /tabindex="0"/.test(item)).length, 1);
  assert.match(items[0]!, /aria-current="true"/);
  assert.match(items[0]!, /tabindex="0"/);
  for (const item of items.slice(1)) {
    assert.match(item, /tabindex="-1"/);
    assert.doesNotMatch(item, /aria-current/);
  }
});

test('the % funded axis is 0-100% in 25% steps and stretches to fit an over-funded goal', () => {
  assert.deepEqual(fundedAxis(69), { top: 100, ticks: [0, 25, 50, 75, 100] });
  assert.deepEqual(fundedAxis(0), { top: 100, ticks: [0, 25, 50, 75, 100] });
  assert.deepEqual(fundedAxis(110).ticks, [0, 25, 50, 75, 100, 125], 'the next 25% step above the goal');
  assert.deepEqual(fundedAxis(200).ticks.at(-1), 200);

  // Far above 100% the step coarsens, the axis still starts at 0% and ends at
  // or above the goal, and it never carries more than nine labels.
  for (const dataMax of [201, 623, 1840, 9999]) {
    const { top, ticks } = fundedAxis(dataMax);
    assert.equal(ticks[0], 0);
    assert.equal(ticks.at(-1), top);
    assert.ok(top >= dataMax, `${dataMax}% fits under ${top}%`);
    assert.ok(ticks.length <= 9, `${dataMax}%: ${ticks.length} labels`);
  }
});
