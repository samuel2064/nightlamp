const Stripe = require('stripe');

export interface StripeClient {
  stripe: any;
  priceIds: Record<string, string>;
}

export function createStripeClient(config: {
  secretKey: string;
  priceBasic?: string;
  priceAdvanced?: string;
  priceWhiteGlove?: string;
}): StripeClient {
  const stripe = new Stripe(config.secretKey);

  return {
    stripe,
    priceIds: {
      basic: config.priceBasic || 'price_basic',
      advanced: config.priceAdvanced || 'price_advanced',
      white_glove: config.priceWhiteGlove || 'price_white_glove',
    },
  };
}

export async function createCheckoutSession(
  client: StripeClient,
  customerId: string,
  planTier: string,
  successUrl: string,
  cancelUrl: string,
): Promise<any> {
  const priceId = client.priceIds[planTier];
  if (!priceId) {
    throw new Error(`Unknown plan tier: ${planTier}`);
  }

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