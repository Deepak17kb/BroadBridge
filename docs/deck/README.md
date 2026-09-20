# Presentation Deck

The deck is a 12-slide, 16:9 presentation. It is published as a private Claude
Artifact (link in the hand-off notes) which can be presented in the browser and
downloaded as PowerPoint or PDF.

The full content is recorded below so the repository is self-contained — if you
rebuild the deck in PowerPoint or Google Slides, this is the script.

**Design direction:** Source Serif 4 for display, IBM Plex Sans for text —
institutional without being stiff, which suits a fintech audience. Palette
chosen once: `#0E1A2B` dark, `#F7F8FA` light, `#2A78D6` and `#199E70` accents.
One type scale (132 / 76 / 34 / 27 / 24). Body text holds at least 4.5:1
contrast on its background.

---

## Slide order

| # | Slide | The one thing it says |
|---|---|---|
| 1 | **Cover** | AI Wealth Navigator — understand, simulate, act |
| 2 | **The problem** | Three questions nobody can answer about their own money |
| 3 | **What we built** | Balances to an auditable plan in under two minutes |
| 4 | **Innovation 1** | One finance engine, two runtimes — numbers cannot drift |
| 5 | **Innovation 2** | A four-phase agent, streamed so you can watch it work |
| 6 | **The differentiator** | Every figure traced back to the tool that produced it |
| 7 | **Business value** | Advice at the cost of software, with an audit trail |
| 8 | **Architecture** | Serverless, single origin, no API key anywhere |
| 9 | **Technical excellence** | The maths is the product, so it is tested as such |
| 10 | **UI and UX** | Form follows the data's job; the colour was computed |
| 11 | **Limits** | What we deliberately do not model |
| 12 | **Close** | Where it goes next, and the measurable outcome |

Sections, for the outline view:

1. *The problem nobody can answer about their own money* — slides 1–2
2. *What we built and the two ideas it rests on* — slides 3–6
3. *Business value, architecture and engineering rigour* — slides 7–10
4. *What we deliberately did not model, and where this goes next* — slides 11–12

---

## Mapping to the judging criteria

| Criterion | Weight | Where it is argued |
|---|---|---|
| Innovation | 25% | Slides 4, 5, 6 — the shared engine, the agent workflow, the grounding verifier |
| Business Value | 25% | Slide 7, with the compliance row as the commercial unlock |
| Technical Excellence | 20% | Slides 8, 9 — architecture decisions with their trade-offs, and the bugs the tests caught |
| UI / UX | 15% | Slide 10, plus the live demo itself |
| Presentation & Demo | 15% | Slide 3 sets up the walkthrough; `../DEMO_SCRIPT.md` is the six-minute script |

---

## Speaker notes

Each slide carries its notes in the deck itself. The short version:

1. **Cover** — Open on the user, not the stack.
2. **Problem** — Land the third card hardest. Generic advice is the failure mode this product exists to fix.
3. **What we built** — Six screens, one journey. Blue is understanding; green is acting.
4. **One engine** — Linger here. A 2,000-path, 20-year Monte Carlo is single-digit milliseconds, which is why the browser runs it live on every drag.
5. **The agent** — The narrate/calculate split makes the advice reproducible and testable, not merely cautious.
6. **Grounding** — A CI test asserts at least 95% grounding across seven question types. This is what turns fluent into auditable.
7. **Business value** — Lead with the compliance row for an enterprise audience.
8. **Architecture** — One CDK stack, one deploy command, a post-deploy smoke test against the live URLs.
9. **Technical excellence** — Every row is a wrong number that would have looked entirely plausible on screen.
10. **Design** — The palette story shows accessibility was measured with a validator, not asserted.
11. **Limits** — Do not rush. Naming the limits is what makes the rest of the numbers credible.
12. **Close** — Close on the outcome, not the feature list. Offer to show the code behind any number.

---

## Presenting it

- **1920×1080, 100% zoom.** The slides are authored on a fixed 1920×1080 canvas.
- The Artifact page has a Present mode, and downloads as `.pptx` or PDF.
- Slide 6 is the accent statement slide — the one full-colour break in the deck. Pause on it.
- The deck is private until shared from the page's Share menu.
