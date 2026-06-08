import { PlanTier, PLAN_TIERS, Subscription } from './subscription';

export interface TierLimit {
  monitors: number;
  reports: number;
  storageMb: number;
}

export class TierEnforcer {
  getLimits(tier: PlanTier | null): TierLimit {
    if (!tier || !PLAN_TIERS[tier]) {
      return { monitors: 0, reports: 0, storageMb: 0 };
    }
    const config = PLAN_TIERS[tier];
    return { monitors: config.monitors, reports: config.reports, storageMb: config.storageMb };
  }

  checkLimit(subscription: Subscription | null, metric: 'monitors' | 'reports' | 'storageMb', currentValue: number): { allowed: boolean; limit: number; current: number } {
    const limits = this.getLimits(subscription?.planTier || null);
    const limit = limits[metric];
    if (limit === 0) return { allowed: false, limit, current: currentValue };
    return { allowed: currentValue < limit, limit, current: currentValue };
  }

  isSubscriptionActive(subscription: Subscription | null): boolean {
    if (!subscription) return false;
    return subscription.status === 'active' || subscription.status === 'trialing';
  }
}