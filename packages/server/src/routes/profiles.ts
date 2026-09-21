import { Router } from 'express';
import { z } from 'zod';
import {
  buildSnapshot,
  emptyProfile,
  PERSONAS,
  personaById,
  RISK_QUESTIONS,
  scoreRisk,
  type UserProfile,
} from '@wealth/shared';
import { asyncHandler, badRequest, notFound, parseBody } from '../lib/http.js';
import { getStore } from '../store/index.js';

/**
 * Profile CRUD plus the derived snapshot.
 *
 * The profile is the single input to everything else in the platform - change a
 * number here and every projection, recommendation and chat answer changes with
 * it. There is no separate "dashboard data" to keep in sync.
 */

const holdingSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1).max(24),
  name: z.string().min(1).max(120),
  assetClass: z.enum(['equity_domestic', 'equity_international', 'debt', 'gold', 'reit', 'cash']),
  units: z.number().min(0),
  price: z.number().min(0),
  costBasis: z.number().min(0),
  expenseRatioPct: z.number().min(0).max(0.1).optional(),
  account: z.string().max(60).optional(),
  instrumentKind: z.enum(['fund', 'security', 'deposit']).optional(),
});

const liabilitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  kind: z.enum(['home_loan', 'car_loan', 'personal_loan', 'credit_card', 'education_loan', 'other']),
  outstanding: z.number().min(0),
  interestRatePct: z.number().min(0).max(1),
  emi: z.number().min(0),
  remainingMonths: z.number().int().min(0).max(600).optional(),
});

const goalSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  kind: z.enum(['retirement', 'home', 'education', 'vehicle', 'travel', 'emergency', 'wealth', 'custom']),
  targetAmountToday: z.number().min(0),
  targetYear: z.number().int().min(new Date().getUTCFullYear()).max(2150),
  currentSaved: z.number().min(0),
  monthlyContribution: z.number().min(0),
  contributionStepUpPct: z.number().min(0).max(1),
  priority: z.enum(['must_have', 'important', 'aspirational']),
  inflationOverridePct: z.number().min(0).max(0.5).optional(),
  notes: z.string().max(500).optional(),
});

export const profileSchema = z.object({
  id: z.string().min(1).max(80),
  displayName: z.string().min(1).max(80),
  email: z.string().email().optional(),
  age: z.number().int().min(16).max(100),
  retirementAge: z.number().int().min(30).max(100),
  dependents: z.number().int().min(0).max(12),
  incomeStability: z.enum(['stable', 'variable', 'uncertain']),
  // INR-only platform. The field stays so the wire shape is explicit,
  // and a literal makes a stray USD payload a 400 rather than a silent accept.
  currency: z.literal('INR'),
  cashflow: z.object({
    monthlyNetIncome: z.number().min(0),
    otherMonthlyIncome: z.number().min(0),
    monthlyExpenses: z.record(z.string().max(60), z.number().min(0)),
    annualIncomeGrowthPct: z.number().min(0).max(1),
  }),
  liquidSavings: z.number().min(0),
  holdings: z.array(holdingSchema).max(100),
  liabilities: z.array(liabilitySchema).max(50),
  goals: z.array(goalSchema).max(30),
  riskAnswers: z.record(z.string(), z.number().int().min(0).max(10)),
  assumptionOverrides: z.record(z.string(), z.any()).optional(),
  lifeInsuranceCover: z.number().min(0).optional(),
  healthInsuranceCover: z.number().min(0).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isSynthetic: z.boolean(),
});

export const router = Router();

/** Sample personas, for the "try it without typing anything" path. */
router.get(
  '/personas',
  asyncHandler(async (_req, res) => {
    res.json(
      PERSONAS.map((p) => ({
        id: p.id,
        label: p.label,
        tagline: p.tagline,
        challenge: p.challenge,
        summary: {
          age: p.profile.age,
          currency: p.profile.currency,
          monthlyIncome: p.profile.cashflow.monthlyNetIncome,
          goals: p.profile.goals.length,
          holdings: p.profile.holdings.length,
        },
      })),
    );
  }),
);

/** The risk questionnaire definition, so the client never hardcodes it. */
router.get(
  '/risk-questions',
  asyncHandler(async (_req, res) => {
    res.json(RISK_QUESTIONS);
  }),
);

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const store = await getStore();
    const profiles = await store.listProfiles();
    res.json(
      profiles.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        currency: p.currency,
        updatedAt: p.updatedAt,
      })),
    );
  }),
);

/**
 * Creates a profile, either blank or seeded from a persona.
 * Seeding rewrites the persona's id so two sessions never share state.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        personaId: z.string().optional(),
        displayName: z.string().min(1).max(80).optional(),
        id: z.string().min(1).max(80).optional(),
      }),
      req.body,
    );
    const store = await getStore();
    const id = body.id ?? `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    let profile: UserProfile;
    if (body.personaId) {
      const persona = personaById(body.personaId);
      if (!persona) throw notFound(`Persona "${body.personaId}"`);
      profile = {
        ...structuredClone(persona.profile),
        id,
        displayName: body.displayName ?? persona.profile.displayName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } else {
      profile = emptyProfile(id, body.displayName ?? 'New User');
    }

    const saved = await store.putProfile(profile);
    res.status(201).json({ profile: saved, snapshot: buildSnapshot(saved) });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const profile = await store.getProfile(req.params.id as string);
    if (!profile) throw notFound('Profile');
    res.json(profile);
  }),
);

/** Full replace. The client holds the whole profile, so PUT is the honest verb. */
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const incoming = parseBody(profileSchema, req.body) as UserProfile;
    if (incoming.id !== req.params.id) {
      throw badRequest('Profile id in the body must match the URL');
    }
    if (incoming.retirementAge <= incoming.age) {
      throw badRequest('Retirement age must be greater than current age');
    }
    const saved = await store.putProfile(incoming);
    res.json({ profile: saved, snapshot: buildSnapshot(saved) });
  }),
);

/**
 * Partial update for the interactive editors - a slider should not have to
 * round-trip the entire balance sheet.
 */
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const existing = await store.getProfile(req.params.id as string);
    if (!existing) throw notFound('Profile');

    const patch = parseBody(profileSchema.deepPartial(), req.body);
    const merged: UserProfile = {
      ...existing,
      ...(patch as Partial<UserProfile>),
      id: existing.id,
      cashflow: { ...existing.cashflow, ...(patch.cashflow ?? {}) } as UserProfile['cashflow'],
      // Arrays replace wholesale when present - merging them by index would be
      // ambiguous and would silently corrupt a deletion.
      holdings: (patch.holdings as UserProfile['holdings']) ?? existing.holdings,
      liabilities: (patch.liabilities as UserProfile['liabilities']) ?? existing.liabilities,
      goals: (patch.goals as UserProfile['goals']) ?? existing.goals,
      riskAnswers: { ...existing.riskAnswers, ...(patch.riskAnswers ?? {}) },
      updatedAt: new Date().toISOString(),
    };
    if (merged.retirementAge <= merged.age) {
      throw badRequest('Retirement age must be greater than current age');
    }
    const saved = await store.putProfile(merged);
    res.json({ profile: saved, snapshot: buildSnapshot(saved) });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    await store.deleteProfile(req.params.id as string);
    res.status(204).end();
  }),
);

/** The derived view: everything the dashboard renders, in one call. */
router.get(
  '/:id/snapshot',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const profile = await store.getProfile(req.params.id as string);
    if (!profile) throw notFound('Profile');
    res.json(buildSnapshot(profile));
  }),
);

/** Scores the risk questionnaire without persisting, for live feedback. */
router.post(
  '/:id/risk',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const profile = await store.getProfile(req.params.id as string);
    if (!profile) throw notFound('Profile');
    const body = parseBody(
      z.object({
        answers: z.record(z.string(), z.number().int().min(0).max(10)),
        persist: z.boolean().optional(),
      }),
      req.body,
    );
    const risk = scoreRisk(profile, body.answers);
    if (body.persist) {
      await store.putProfile({ ...profile, riskAnswers: body.answers });
    }
    res.json(risk);
  }),
);
