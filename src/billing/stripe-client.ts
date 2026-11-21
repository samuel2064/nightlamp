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
 */
export const PLAN_TIER_PRICE_ENV: Record<string, string> = {
  basic: 'STRIPE_PRICE_BASIC',
  advanced: 'STRIPE_PRICE_ADVANCED',
  white_glove: 'STRIPE_PRICE_WHITE_GLOVE',
};

export function createStripeClient(config: {
  secretKey: string;
  priceBasic?: string;
  priceAdvanced?: string;
  priceWhiteGlove?: string;
}): StripeClient {
  const stripe = new Stripe(config.secretKey);

  const provided: Record<string, string | undefined> = {
    basic: config.priceBasic,
    advanced: config.priceAdvanced,
    white_glove: config.priceWhiteGlove,
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
 * Resolves the configured Stripe price id for a plan tier. Throws an error that
 * names the missing environment variable (never the value or any secret) so a
 * misconfiguration is visible at the point of use instead of silently issuing
 * a Stripe request against a placeholder id.
 */
export function resolvePriceId(client: StripeClient, planTier: string): string {
  const priceId = client.priceIds[planTier];
  if (typeof priceId === 'string' && priceId.trim().length > 0) {
    return priceId;
  }
  if (Object.hasOwn(PLAN_TIER_PRICE_ENV, planTier)) {
    throw new Error(
      `Missing Stripe price configuration for plan tier "${planTier}": set ${PLAN_TIER_PRICE_ENV[planTier]}`,
    );
  }
  throw new Error(`Unknown plan tier: ${planTier}`);
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