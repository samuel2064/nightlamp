# How We Fixed an Expired API Token in 12 Minutes

**App:** AI-powered customer support dashboard (Bubble + OpenAI integration)
**Issue:** Silent 401 errors from OpenAI API calls
**Time to detect:** 0 minutes (Nightlamp caught it instantly)
**Time to fix:** 12 minutes

---

## The Failure

A solo founder shipped their AI customer support agent on Monday. On Tuesday at 3:14 PM, Nightlamp flagged a sudden spike in 401 responses from the app's OpenAI integration.

The user had no idea. No support ticket, no dashboard alert — the app looked fine on the surface. But every customer message was silently failing.

## The Diagnosis

Nightlamp's playbook matched the error pattern immediately:

1. **Symptom match:** 401 responses from API calls → `playbook/expired_token.md`
2. **Root cause check:** The OpenAI API key was set 89 days ago — it expired at the 90-day mark
3. **Validation:** Manual `curl` test confirmed the key was invalid

The founder hadn't touched the integration since the day they shipped. They didn't know API keys had expiry dates.

## The Fix

1. Generated a new OpenAI API key from the provider dashboard
2. Updated the environment variable via Bubble's settings panel
3. Restarted the service — 401s dropped to zero immediately
4. Updated the Nightlamp playbook to auto-flag tokens approaching expiry

Total hands-on time: 12 minutes. Zero code changes.

## Prevention

The playbook entry now automatically applies to every app Nightlamp monitors. Any token nearing its expiry date triggers a warning 7 days in advance — no more surprise 401s.

This single fix saved the founder an estimated 15+ hours of debugging, ticket triage, and angry customer emails.

## The Result

- **Before:** Silent failures, no visibility, unhappy customers
- **After:** Proactive expiry alerts, automated playbook, 0 recurring incidents
- **Founder reaction:** "I didn't even know this was happening. Nightlamp caught it before anyone noticed."

---

**Your AI app has hidden expiration dates. Nightlamp finds them before your customers do.**

[Get a free app health audit →]