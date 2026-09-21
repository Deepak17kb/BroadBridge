import { ASSET_CLASSES } from '../assumptions.js';
import type { AllocationWeights, AssetClass, Holding, NextBestAction, UserProfile } from '../types.js';

/**
 * The machine-applicable half of an action.
 *
 * Four of the twelve rules carry a `apply` mutation - the rest recommend
 * something no software can do on the user's behalf (buy a policy, refinance a
 * loan, open an account). This module is what turns those four into an actual
 * edit, and it lives in the engine rather than in the React page because two
 * callers need identical behaviour: the "Apply to my plan" button, and the
 * impact calculation that reports what applying them would be worth. If those
 * two ever diverged, the platform would promise one outcome and deliver another.
 */

export type ActionMutation = NonNullable<NextBestAction['apply']>;

export interface MutationContext {
  /** Target weights for `rebalance_to_target`, normally `snapshot.recommendedAllocation`. */
  recommendedAllocation: AllocationWeights;
}

/**
 * Applies one mutation to a profile **in place**.
 *
 * Callers own the copying: the UI mutates a draft it already cloned, and the
 * impact calculation clones once per step so it can measure each action's
 * marginal contribution.
 */
export function applyActionMutation(
  draft: UserProfile,
  mutation: ActionMutation,
  ctx: MutationContext,
): void {
  switch (mutation.type) {
    case 'increase_goal_contribution': {
      const goal = draft.goals.find((g) => g.id === mutation.goalId);
      if (goal) goal.monthlyContribution += mutation.amount;
      break;
    }

    case 'set_goal_contributions': {
      // A reallocation, not a top-up: goals absent from the list are left alone,
      // and a goal the optimiser starved is set down to what it was given.
      const byId = new Map(mutation.allocations.map((a) => [a.goalId, a.monthly] as const));
      for (const goal of draft.goals) {
        const next = byId.get(goal.id);
        if (next !== undefined) goal.monthlyContribution = Math.max(0, next);
      }
      break;
    }

    case 'set_emergency_fund':
      // Never reduces the buffer: the action is "top up to the target", and a
      // user who already holds more than the target should not be trimmed to it.
      draft.liquidSavings = Math.max(draft.liquidSavings, mutation.amount);
      break;

    case 'set_allocation':
    case 'rebalance_to_target': {
      /*
       * Rebalancing is modelled by restating the holdings at the target weights
       * with the total value held fixed. Real trades have costs and tax
       * consequences the engine deliberately does not pretend to know - which
       * is why the impact this produces is reported as gross, and said to be.
       */
      const weights =
        mutation.type === 'set_allocation' ? mutation.weights : ctx.recommendedAllocation;
      const fromCash =
        mutation.type === 'set_allocation'
          ? Math.min(Math.max(0, mutation.fundFromCash ?? 0), draft.liquidSavings)
          : 0;
      draft.liquidSavings -= fromCash;
      const investable = draft.holdings.reduce((acc, h) => acc + h.units * h.price, 0) + fromCash;
      if (investable <= 0) break;

      const byClass = new Map<AssetClass, Holding[]>();
      for (const h of draft.holdings) byClass.set(h.assetClass, [...(byClass.get(h.assetClass) ?? []), h]);

      draft.holdings = ASSET_CLASSES.filter((ac) => (weights[ac] ?? 0) > 0.001).map((ac) => {
        const target = (weights[ac] ?? 0) * investable;
        const current = byClass.get(ac) ?? [];
        const value = current.reduce((acc, h) => acc + h.units * h.price, 0);
        const cost = current.reduce((acc, h) => acc + h.costBasis, 0);
        // Average cost: a sale keeps the cost of what remains, a purchase adds
        // at market. Carrying one holding's cost basis for the whole class
        // misstated the unrealised gain after every rebalance.
        const costBasis = target <= value && value > 0 ? cost * (target / value) : cost + (target - value);

        const only = current.length === 1 ? current[0] : undefined;
        if (only && only.instrumentKind !== 'security') {
          return { ...only, units: 1, price: target, costBasis };
        }
        /*
         * Several holdings, or a single stock, become one diversified position.
         * Restating a class through its last holding made that holding stand
         * for the whole class - so "trim the employer stock and realign" left
         * the stock at 42% of the portfolio instead of removing it.
         */
        const feeBase = current.filter((h) => typeof h.expenseRatioPct === 'number');
        const feeValue = feeBase.reduce((acc, h) => acc + h.units * h.price, 0);
        const blendedFee =
          feeValue > 0
            ? feeBase.reduce((acc, h) => acc + h.units * h.price * (h.expenseRatioPct ?? 0), 0) / feeValue
            : 0.002;
        return {
          // Deterministic, not `Date.now()`: the impact calculation applies
          // these repeatedly and has to produce the same profile each time.
          id: `h-${ac}-rebalanced`,
          symbol: ac.toUpperCase().slice(0, 8),
          name: `${ac.replace(/_/g, ' ')} allocation`,
          assetClass: ac,
          units: 1,
          price: target,
          costBasis: current.length ? costBasis : target,
          instrumentKind: 'fund' as const,
          expenseRatioPct: blendedFee,
        };
      });
      break;
    }
  }
}

/** True when an action can be carried out by the platform rather than by the user. */
export function isApplicable(action: NextBestAction): boolean {
  return action.apply !== undefined;
}
