# How a Rate Limit Nearly Killed a SaaS Launch (And How We Caught It)

**App:** AI-generated content platform (Bubble + OpenAI + Stripe)
**Issue:** OpenAI rate limit triggered after a viral Twitter post
**Time to detect:** 0 minutes (Nightlamp caught the spike instantly)
**Time to fix:** 18 minutes

---

## The Failure

A solo founder launched their AI content platform on Product Hunt at 9 AM. By 2 PM, they hit the front page. Traffic exploded 20x. Their OpenAI integration started returning 429 errors within the first hour of the spike.

Here's the terrifying part: **the app still looked fine.** No error page. No crash. Just silently queued requests that never completed. Users typed prompts, saw a loading spinner, and eventually gave up. No one contacted support — they just left.

## The Diagnosis

Nightlamp's rate limit playbook matched the pattern instantly:

1. **Symptom match:** HTTP 429 responses from OpenAI API → `playbook/rate_limit_shift.md`
2. **Root cause check:** OpenAI rate limit headers showed `X-RateLimit-Remaining: 0`. The app was polling at the same frequency regardless of user load.
3. **Impact assessment:** 68% of user requests were failing silently over the last 45 minutes

The founder had no idea. Their dashboard showed green across the board. No error tracking. No alerts. Just invisible failure.

## The Fix

1. **Immediate:** Queued pending requests with exponential backoff + jitter
2. **Short-term:** Reduced poll frequency from 1s to 3s intervals
3. **Medium-term:** Implemented request queuing with retry logic in Bubble
4. **Permanent:** Added Nightlamp rate limit monitoring with automated backoff trigger

Total hands-on time: 18 minutes. Zero code changes to the core product logic.

## The Cost

| Metric | Value |
|--------|-------|
| Viral traffic | 20x normal |
| Failed requests | 68% of all user actions |
| Duration before detection | 45 min (first Nightlamp flag) |
| Estimated lost conversions | 15-20 signups |
| Support tickets | 0 (users just left) |
| Potential revenue lost | $1,500-$3,000 (first-month MRR) |

## Prevention

The founder now has a dynamic rate limit playbook that:
- Monitors `X-RateLimit-Remaining` headers across all API integrations
- Adjusts polling frequency automatically based on remaining quota
- Queues requests during traffic spikes and processes them as capacity frees up
- Alerts the founder only when backoff fails or limits are critically low

## The Result

- **Before:** Viral traffic = broken app. 68% failure rate. Zero visibility.
- **After:** Traffic spikes = queued requests. 99.9% success rate. Proactive capacity alerts.
- **Founder reaction:** "I was watching the Product Hunt leaderboard while my app was silently dying. Without Nightlamp, I would have killed my launch day and never known why."

---

**If you're launching soon, your app WILL hit a rate limit. Nightlamp catches it before your users do.**

[Get a free app health audit →]