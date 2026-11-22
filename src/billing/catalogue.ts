/**
 * Canonical Nightlamp billing catalogue (CEO pricing decision on NOC-177).
 *
 * Amounts are in the currency's minor unit (cents); intervals are Stripe price
 * intervals. This module is the single source for the catalogue dry-run and any
 * future creation script. It is deliberately NOT wired into the request path:
 * changing live pricing requires the CTO/CEO (NOC-313).
 */

export type CatalogueTier = 'free' | 'pro' | 'team' | 'enterprise';

export interface CataloguePrice {
  /** Stable lookup key that becomes the Stripe price lookup_key (not a Stripe id). */
  lookupKey: string;
  interval: 'month' | 'year';
  intervalCount: number;
  /** Minor units (cents); 9900 = 99.00 USD. */
  unitAmount: number;
}

export interface CatalogueProduct {
  tier: CatalogueTier;
  name: string;
  description: string;
  /** Free and Enterprise sell no Stripe price objects. */
  prices: CataloguePrice[];
  metadata: Record<string, string>;
}

export const BILLING_CURRENCY = 'usd';

export const BILLING_CATALOGUE: CatalogueProduct[] = [
  {
    tier: 'free',
    name: 'Free',
    description: 'Free tier - $0/month recurring',
    prices: [
      { lookupKey: 'nightlamp_free_monthly', interval: 'month', intervalCount: 1, unitAmount: 0 },
    ],
    metadata: { tier: 'free', billing: 'free' },
  },
  {
    tier: 'pro',
    name: 'Pro',
    description: 'Pro plan - monthly or yearly (~17% off)',
    prices: [
      { lookupKey: 'nightlamp_pro_monthly', interval: 'month', intervalCount: 1, unitAmount: 9900 },
      { lookupKey: 'nightlamp_pro_yearly', interval: 'year', intervalCount: 1, unitAmount: 99000 },
    ],
    metadata: { tier: 'pro', billing: 'subscription' },
  },
  {
    tier: 'team',
    name: 'Team',
    description: 'Team plan - monthly or yearly (~17% off)',
    prices: [
      { lookupKey: 'nightlamp_team_monthly', interval: 'month', intervalCount: 1, unitAmount: 29900 },
      { lookupKey: 'nightlamp_team_yearly', interval: 'year', intervalCount: 1, unitAmount: 299000 },
    ],
    metadata: { tier: 'team', billing: 'subscription' },
  },
  {
    tier: 'enterprise',
    name: 'Enterprise',
    description: 'Enterprise plan - custom price, created per deal',
    prices: [],
    metadata: { tier: 'enterprise', billing: 'custom' },
  },
];