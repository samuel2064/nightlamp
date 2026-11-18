/**
 * NOC-313: Stripe catalogue dry run.
 *
 * Prints the exact object list that a future creation run would create:
 * product names, amounts, currency, billing interval and interval count, and
 * the lookup keys / env vars that would be set afterwards. Creates nothing.
 *
 * A Stripe API call is only possible when ALL of the following are present:
 *   --execute flag, STRIPE_CATALOGUE_CONFIRM=yes and STRIPE_SECRET_KEY.
 * Dry run (the default) never touches the network.
 *
 * Usage: npm run stripe:catalogue:dry-run
 */
import { BILLING_CATALOGUE, BILLING_CURRENCY, CataloguePrice, CatalogueProduct } from '../src/billing/catalogue';

export interface PlannedPrice {
  lookupKey: string;
  unitAmount: number;
  unitAmountDisplay: string;
  currency: string;
  interval: string;
  intervalCount: number;
}

export interface PlannedProduct {
  name: string;
  description: string;
  metadata: Record<string, string>;
  prices: PlannedPrice[];
}

export function formatAmount(unitAmount: number, currency: string): string {
  return `${(unitAmount / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

export function buildObjectList(
  catalogue: CatalogueProduct[] = BILLING_CATALOGUE,
  currency: string = BILLING_CURRENCY,
): PlannedProduct[] {
  return catalogue.map((product) => ({
    name: product.name,
    description: product.description,
    metadata: { ...product.metadata },
    prices: product.prices.map((price: CataloguePrice) => ({
      lookupKey: price.lookupKey,
      unitAmount: price.unitAmount,
      unitAmountDisplay: formatAmount(price.unitAmount, currency),
      currency: currency.toUpperCase(),
      interval: price.interval,
      intervalCount: price.intervalCount,
    })),
  }));
}

export function renderObjectList(
  catalogue: CatalogueProduct[] = BILLING_CATALOGUE,
  currency: string = BILLING_CURRENCY,
): string {
  const products = buildObjectList(catalogue, currency);
  const lines: string[] = [
    'DRY RUN - Nightlamp Stripe catalogue object list (no Stripe API call made)',
    `currency: ${currency.toUpperCase()}`,
    '',
  ];
  for (const product of products) {
    const meta = Object.entries(product.metadata).map(([k, v]) => `${k}=${v}`).join(',');
    lines.push(`product: ${product.name} - ${product.description}${meta ? ` [${meta}]` : ''}`);
    if (product.prices.length === 0) {
      lines.push('  (no price objects - handled outside Stripe)');
    }
    for (const price of product.prices) {
      lines.push(
        `  price: lookup_key=${price.lookupKey} amount=${price.unitAmountDisplay} ` +
        `interval=${price.interval} interval_count=${price.intervalCount}`,
      );
    }
    lines.push('');
  }
  lines.push('After a reviewed creation run, set the price env vars to the created ids:');
  lines.push('  STRIPE_PRICE_PRO_MONTHLY, STRIPE_PRICE_PRO_YEARLY, STRIPE_PRICE_TEAM_MONTHLY, STRIPE_PRICE_TEAM_YEARLY');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const confirmed = process.env.STRIPE_CATALOGUE_CONFIRM === 'yes';
  const secret = process.env.STRIPE_SECRET_KEY;

  if (execute) {
    if (!confirmed || !secret) {
      console.error('Refusing to execute: creation requires STRIPE_CATALOGUE_CONFIRM=yes and STRIPE_SECRET_KEY.');
      console.error('This task is a dry run; the CTO/CEO executes creation after the object list is reviewed.');
      process.exit(1);
    }
    console.error('Execute mode is not implemented in this dry-run deliverable (NOC-313).');
    console.error('Use the reviewed object list below to run creation deliberately.');
    process.exit(1);
  }

  console.log(renderObjectList());
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}