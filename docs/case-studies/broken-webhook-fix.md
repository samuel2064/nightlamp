# How We Caught a Broken Webhook Before It Cost a Founder $2,000

**App:** No-code SaaS for automated invoice processing (Bubble + Stripe + n8n)
**Issue:** Silent 5xx errors on Stripe webhook callback
**Time to detect:** 0 minutes (Nightlamp caught it instantly)
**Time to fix:** 18 minutes

---

## The Failure

A no-code founder running an invoice automation platform processed $12k/mo through Stripe. When a customer paid, Stripe fired a webhook to the app's backend to trigger invoice generation and email delivery.

At 8:47 AM on a Thursday, Nightlamp detected a spike in 5xx responses from the app's webhook callback URL. Stripe had been retrying deliveries for 47 minutes — each one failing silently.

No customer had complained yet. But 14 invoices were never created, and 7 overdue payment reminders were never sent.

## The Diagnosis

Nightlamp's diagnostic playbook matched the pattern in under a minute:

1. **Symptom match:** 5xx responses from callback URL, failed deliveries → `playbook/broken_webhook.md`
2. **Reachability check:** The webhook endpoint was returning 502 — the n8n workflow was crash-looping
3. **Delivery log review:** Stripe's dashboard confirmed 47 minutes of retries with 100% failure rate

The webhook had been working for months. Nothing changed in the app. Something upstream broke.

## The Fix

1. Checked the n8n workflow logs — found a crash on a JSON parsing step
2. Traced it to a Stripe API payload change: Stripe had added a new required field to the `invoice.paid` event object
3. Updated the n8n workflow to handle the new field structure
4. Restarted the n8n service — webhook deliveries resumed immediately
5. Replayed the 14 failed events from Stripe's dashboard

Total hands-on time: 18 minutes. Zero code changes to the app itself.

## Prevention

The broken webhook playbook entry now auto-applies across all monitored apps. Any 5xx webhook response triggers immediate investigation — not an hour later.

We also added a Stripe API changelog check to Nightlamp's dependency scanner, so payload format changes get flagged before they cause failures.

## The Result

- **Before:** 47 minutes of silent failures, 14 lost invoices, 7 missed payment reminders
- **Cost if undetected:** Estimated $2,000+ in failed invoice collections and support churn
- **After:** 18-minute fix, all events replayed, zero customer complaints
- **Founder reaction:** "I didn't even know Stripe changed their payload. Nightlamp saved me from a really bad Friday."

---

**Your webhooks are breaking right now. You just don't know it yet.**

[Get a free app health audit →]