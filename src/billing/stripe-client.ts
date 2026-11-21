const Stripe = require('stripe');

export interface StripeClient {
  stripe: any;
  priceIds: Record<string, string>;
}

/**
 * Environment variable that must supply each plan tier's Stripe price id.
 * Configuration fails closed: an absent or whitespace-only value leaves the
 * tier unresolved and the request refuses with an error naming the variable.
 * No placeholder id is ever substituted (NOC-318).
 *
 * Maps catalogue tier+interval to env var names. Legacy aliases are resolved
 * via resolvePriceIdLegacy.
 */
export const PLAN_TIER_PRICE_ENV: Record<string, string> = {
  'pro:month': 'STRIPE_PRICE_PRO_MONTHLY',
  'pro:year': 'STRIPE_PRICE_PRO_YEARLY',
  'team:month': 'STRIPE_PRICE_TEAM_MONTHLY',
  'team:year': 'STRIPE_PRICE_TEAM_YEARLY',
};

/**
 * Legacy tier aliases mapped to catalogue tier+interval.
 * basic → Pro monthly, advanced → Team monthly, white_glove → not sold to new customers.
 */
export const LEGACY_TIER_MAP: Record<string, string> = {
  basic: 'pro:month',
  advanced: 'team:month',
  white_glove: 'white_glove',
};

/**
 * Catalogue tier names mapped to tier+interval.
 * Used for Stripe price lookup.
 */
export const CATALOGUE_TIER_MAP: Record<string, string> = {
  free: 'free',
  pro_monthly: 'pro:month',
  pro_yearly: 'pro:year',
  team_monthly: 'team:month',
  team_yearly: 'team:year',
  enterprise: 'enterprise',
};

/**
 * Returns the env var name for a given tier (catalogue or legacy).
 * For error messages, we want to show the original tier name.
 * white_glove is withdrawn from sale (CEO ratified on NOC-327) and has no
 * Stripe price configuration; it is honoured only for existing subscriptions.
 */
export function getEnvVarForTier(tier: string): string {
  if (Object.hasOwn(PLAN_TIER_PRICE_ENV, tier)) {
    return PLAN_TIER_PRICE_ENV[tier];
  }
  const legacyMapped = LEGACY_TIER_MAP[tier];
  if (legacyMapped && legacyMapped !== 'white_glove' && Object.hasOwn(PLAN_TIER_PRICE_ENV, legacyMapped)) {
    return PLAN_TIER_PRICE_ENV[legacyMapped];
  }
  // white_glove is withdrawn from sale (CEO ratified on NOC-327) and has no
  // Stripe price configuration; it is honoured only for existing subscriptions.
  // Return empty string so resolvePriceId reports "unknown plan tier" instead
  // of naming a non-existent env var.
  if (legacyMapped === 'white_glove') {
    return '';
  }
  const catalogueMapped = CATALOGUE_TIER_MAP[tier];
  if (catalogueMapped && catalogueMapped !== 'free' && catalogueMapped !== 'enterprise' && Object.hasOwn(PLAN_TIER_PRICE_ENV, catalogueMapped)) {
    return PLAN_TIER_PRICE_ENV[catalogueMapped];
  }
  return '';
}

/**
 * Maps a plan tier (catalogue, legacy, or tier+interval) to the internal
 * tier+interval key used for price lookup.
 */
export function toPriceLookupKey(planTier: string): string {
  // Check if it's already a tier+interval key
  if (Object.hasOwn(PLAN_TIER_PRICE_ENV, planTier)) {
    return planTier;
  }
  // Check legacy mapping
  const legacyMapped = LEGACY_TIER_MAP[planTier];
  if (legacyMapped && legacyMapped !== 'white_glove') {
    return legacyMapped;
  }
  // Check catalogue mapping
  const catalogueMapped = CATALOGUE_TIER_MAP[planTier];
  if (catalogueMapped && catalogueMapped !== 'free' && catalogueMapped !== 'enterprise') {
    return catalogueMapped;
  }
  // Return as-is for free/enterprise/white_glove
  return planTier;
}

export function createStripeClient(config: {
  secretKey: string;
  priceProMonthly?: string;
  priceProYearly?: string;
  priceTeamMonthly?: string;
  priceTeamYearly?: string;
}): StripeClient {
  const stripe = new Stripe(config.secretKey);

  const provided: Record<string, string | undefined> = {
    'pro:month': config.priceProMonthly,
    'pro:year': config.priceProYearly,
    'team:month': config.priceTeamMonthly,
    'team:year': config.priceTeamYearly,
  };

  const priceIds: Record<string, string> = {};
  for (const [tier, value] of Object.entries(provided)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      priceIds[tier] = value.trim();
    }
  }

  return { stripe, priceIds };
}

/**
 * Resolves the configured Stripe price id for a plan tier (catalogue, legacy, or tier+interval).
 * Throws an error that names the missing environment variable (never the value
 * or any secret) so a misconfiguration is visible at the point of use instead
 * of silently issuing a Stripe request against a placeholder id.
 */
export function resolvePriceId(client: StripeClient, planTier: string): string {
  // Map the plan tier to the internal price lookup key
  const priceLookupKey = toPriceLookupKey(planTier);

  // First try direct lookup with the mapped key
  const priceId = client.priceIds[priceLookupKey];
  if (typeof priceId === 'string' && priceId.trim().length > 0) {
    return priceId;
  }

  // Determine which env var name to report for the error
  const envVar = getEnvVarForTier(planTier);
  if (!envVar) {
    throw new Error(`Unknown plan tier: ${planTier}`);
  }

  throw new Error(
    `Missing Stripe price configuration for plan tier "${planTier}": set ${envVar}`,
  );
}

export async function createCheckoutSession(
  client: StripeClient,
  customerId: string,
  planTier: string,
  successUrl: string,
  cancelUrl: string,
): Promise<any> {
  // Fail closed before any Stripe request: an unconfigured price id refuses
  // with the missing variable named (NOC-318).
  const priceId = resolvePriceId(client, planTier);

  const session = await client.stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  return session;
}

export async function createCustomerPortalSession(
  client: StripeClient,
  customerId: string,
  returnUrl: string,
): Promise<any> {
  const session = await client.stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });

  return session;
}

export async function constructWebhookEvent(
  client: StripeClient,
  payload: string,
  signature: string,
  webhookSecret: string,
): Promise<any> {
  const event = client.stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  return event;
}