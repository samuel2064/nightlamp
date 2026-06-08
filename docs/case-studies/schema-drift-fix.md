# How Schema Drift Broke an AI App's Core Feature Overnight

**App:** AI-powered real estate listing generator (Bubble + GPT-4 + Zillow API)
**Issue:** Missing fields in Zillow API responses causing JSON parsing failures
**Time to detect:** 0 minutes (Nightlamp caught it instantly)
**Time to fix:** 22 minutes

---

## The Failure

A solo founder running an AI real estate content app had a working pipeline: Zillow API → Bubble backend → GPT-4 summary → published listing. It ran for weeks without issues.

At 2:03 AM, the Zillow API response format changed. A field named `price_history` was renamed to `pricing_history` with a restructured object inside. The Bubble backend's JSON parser didn't find the expected key — and threw a parsing error. Every subsequent listing generation failed.

By the time the founder woke up at 7:30 AM, the app had been broken for 5.5 hours. 23 listing generation requests had failed silently. The user got blank screens.

## The Diagnosis

Nightlamp flagged the failure immediately:

1. **Symptom match:** Unexpected/missing fields in API responses → `playbook/schema_drift.md`
2. **Schema comparison:** The Zillau API response had changed its `price_history` field structure
3. **Provider changelog:** Zillow had deployed a silent API update — no version bump, no deprecation notice

The founder hadn't touched the integration since launch. They didn't know APIs could change without warning.

## The Fix

1. Captured the raw Zillow response — confirmed the new field structure
2. Updated the Bubble backend's JSON parser to handle both old and new formats
3. Added fallback logic: check for `price_history` first, fall back to `pricing_history`
4. Re-ran the 23 failed generations — all completed successfully
5. Pinned the Zillow API version in the integration config

Total hands-on time: 22 minutes. One line of parsing logic changed.

## Prevention

The schema drift playbook now applies to every monitored app. Any unexpected API response field changes trigger immediate investigation.

We also added automatic API changelog monitoring for Zillow, Stripe, OpenAI, and 12 other common providers — so Nightlamp catches schema changes before they hit production.

## The Result

- **Before:** 5.5 hours of silent failures, 23 lost listings, no visibility
- **After:** 22-minute fix, schema drift detection enabled, 0 recurring incidents
- **Founder reaction:** "I had no idea APIs could just change. I would've spent the whole day debugging this."

---

**Third-party APIs change without warning. Nightlamp catches it before your users do.**

[Get a free app health audit →]