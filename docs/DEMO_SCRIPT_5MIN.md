# 5-Minute Demo Script

The presenter's script for the recorded walkthrough. Everything in `>` blockquotes is
meant to be **said out loud**; everything else is what happens on screen.

Timings are cumulative. The whole thing is 5:00 with about 20 seconds of slack.

---

## Setup before you start

| | |
|---|---|
| Run | `npm run dev` (API on 4000, web on 5173) |
| Open | <http://localhost:5173> |
| Persona | **Aarav** — he is broken in the most demonstrable ways |
| Theme | Dark |
| Check | `curl localhost:4000/api/health` should report an `engine` other than `deterministic`, so the assistant answers in real prose |

If you are presenting from the public link instead (<https://deepak17kb.github.io/BroadBridge/>),
everything below works **except section 6** — that deployment has no API server, so the assistant
is switched off and says so. Either run locally for the recording, or cut section 6 and add its
30 seconds to section 4.

---

## 0:00 — Open on the problem, not the product

Start on the onboarding screen.

> "There are three questions nobody can really answer about their own money. Where do I stand?
> What happens if I change something? And what should I actually do next?
>
> Plenty of apps show you a balance. Almost none of them reason about it, and none of them show
> their work. That's what we built — and the rule we started from is that the arithmetic is always
> visible, so you can disagree with it."

*Don't open with the architecture. Open with the user.*

---

## 0:25 — Pick a persona

> "Three synthetic personas, each broken differently. I'll take Aarav — 26, earning well, but no
> emergency buffer and a credit card at 42%."

Click **Aarav** → **Open this sample profile**. The dashboard loads.

---

## 0:40 — The headline: what the advice is worth

Point at the banner across the top.

> "Straight away, look at this banner. It is *not* his position today. It's what his position
> becomes if he follows the top two recommendations. Wellness goes 43 to 61, grade D to C,
> emergency cover 1.3 months to 6.
>
> And the engine applies those actions **in order**, crediting each one only with what it adds on
> top of the ones above it — so two overlapping tips can't both claim the same rupee."

Then point at the sentence underneath.

> "It also tells you what *doesn't* change. 'Debt is unchanged by these actions.' The headline
> number is never allowed to quietly absorb advice the platform can't actually carry out."

---

## 1:10 — The score, and why you can argue with it

Scroll to **Financial wellness**.

> "The score is five weighted pillars. The ring is the headline — each arc is one pillar, and the
> arc length is that pillar's *share* of the score, so Protection owns a quarter of the circle.
> The radar next to it shows the shape of the weakness at a glance.
>
> But the part that matters is underneath."

Point at a pillar bar's subtitle.

> "Every pillar states its own arithmetic. '1.3 months of expenses in reserve, target 6.' That
> sentence names the input and the target — which means you can check it, and disagree with it.
> And the target itself is editable."

---

## 1:45 — Goals: two things most calculators get wrong

Click **Goals**. Select **Emergency Fund**.

> "Two things here that most calculators get wrong.
>
> First — you state a target in today's money, 3.9 lakh, and the engine inflates it to the year you
> need it. You're measured against 4.20 lakh, not 3.9.
>
> Second, look at this: 'projected at 4.9% a year.' That is not his portfolio return. Money needed
> in 1.3 years can't sit in equity, so each goal is projected at a return appropriate to *its own*
> horizon. One blended rate across every goal is the usual shortcut, and it's wrong in both
> directions."

Scroll to the surplus split.

> "And the goals compete for one pool of money. The whole surplus goes to the emergency fund —
> must-have, and due soonest. Retirement is also must-have, but it's 33 years out, so urgency
> breaks the tie."

---

## 2:30 — Scenario Lab: the centrepiece

Click **Scenario Lab**.

> "This is where it gets interesting. Every number on the right is scored against 2,500 simulated
> market paths."

Click the **Survive a 35% crash** preset. Let the chart re-draw on camera.

> "One click, and the whole plan is re-simulated."

Trace the widening cone with the cursor.

> "This is a Monte Carlo fan chart. The dark line is the median. The bands are the middle 50% and
> the 10th-to-90th percentile. It *widens* with time because uncertainty compounds — and that
> widening is the point. A single-line projection is a lie told confidently.
>
> Bad run 56 lakh, typical 85, good run 1.35 crore — all in today's money."

*If you have a spare 10 seconds, drag the **Save more each month** slider and let them watch every
figure move live. That is the moment people remember.*

---

## 3:15 — The maths, briefly

Stay on the same screen.

> "Quickly, because it matters: we sample log-returns so a corpus can fall but never go negative,
> and we subtract the variance drag from the drift so the average simulated return actually matches
> the return we showed the user. Skipping that correction is the most common bug in retirement
> simulators — it silently inflates the median by several percent a year.
>
> And every run is seeded, so the same inputs always draw the same chart. A cited probability can
> be reproduced."

---

## 3:40 — Actions: ranked by a planning waterfall

Click **Next Best Actions**.

> "Ten recommendations from twelve rule checks. These are generated by a deterministic engine, not
> by a language model — two users with the same balance sheet get the same actions, every time.
>
> And they're ordered by the standard planning waterfall — protect, clear expensive debt, fund
> goals, then optimise — not by raw impact. A rupee of emergency fund is worth more than a rupee
> of alpha when there's no buffer at all."

Read the top action's reasoning aloud.

> "'Clear the credit card before investing anything extra. It costs 42% a year while your portfolio
> is only expected to earn 9.2%. Paying it down is a guaranteed 32.8% return, which no investment
> can promise.'
>
> That's reasoning, not a template. And five of these can be applied to the plan in one click."

---

## 4:15 — The assistant, and the thing that makes it trustworthy

Click **AI Assistant**. Type: **Am I on track to retire?**

While the reasoning trace fills in on the right:

> "Now the AI. Watch the panel on the right — that's the live reasoning trace. It classifies the
> question, plans a toolchain, then calls tools. And those tools aren't descriptions of
> capabilities; they are literally the same functions the dashboard calls.
>
> So when it says his retirement is 41% funded, it called the same code the dashboard did. The
> model never does arithmetic. It only narrates numbers the engine produced."

When the answer lands:

> "And after it writes, a grounding verifier pulls every figure out of the text and checks each one
> against the tool results that actually came back. A number with nothing behind it gets flagged.
>
> That's the whole architecture in one sentence: the engine decides, the model only speaks."

---

## 4:45 — Close

> "It's a TypeScript monorepo — one shared finance engine imported by both the browser and the
> server, so the number you see while dragging a slider and the number the agent quotes are
> identical by construction.
>
> It's live on GitHub Pages, it's open source, and every figure on every screen tells you what it
> assumed.
>
> All the data is synthetic, and none of it is financial advice. Happy to take questions."

---

## If you have 30 seconds of dead air

Any of these fill a gap without breaking the flow:

- **Portfolio** — "41% of his invested assets are in one stock. Company-specific risk he isn't paid
  for. Diversification score 21 out of 100, measured three ways because they fail independently."
- **Assumptions** — "Every figure the platform believes, on one page, with sliders. Move inflation
  from 6 to 8 and the entire plan re-scores. Most apps hide these."
- **Testing** — "42 automated tests, including accessibility checks that fail the build if a
  heading level is skipped."

## Questions you should expect

| Question | Short answer |
|---|---|
| "Is the data real?" | No — synthetic personas, and illustrative planning assumptions, not forecasts. Stated on screen. |
| "Does the AI make up the numbers?" | It can't. It has no arithmetic path — it calls engine functions, and a verifier checks every figure in its answer. |
| "Why is the assistant off on the live link?" | GitHub Pages serves files, not processes. The assistant needs a model key, and a public bundle can't hold a secret. |
| "What happens with no API key at all?" | It still works. The agent falls back to a rule-based engine that plans, calls the same tools and grounds every figure — it just narrates from templates. |
| "Why Monte Carlo and not a simple projection?" | Because a single expected-return line implies a certainty that doesn't exist. The fan chart shows the range honestly. |
