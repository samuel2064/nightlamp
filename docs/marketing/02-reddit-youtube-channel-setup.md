# Reddit & YouTube Acquisition Channel Setup

## Reddit Acquisition Machine

### Accounts & Infrastructure
- **1 main account** (founder persona: "solo dev building in public")
- **3 "regular user" accounts** for organic seeding (1 per community, age 60+ days)
- **Tool:** Hootsuite or Buffer for scheduling (avoid footprint)

### Target Subreddits (Ranked)

| Subreddit | Strategy | Post cadence |
|-----------|----------|-------------|
| r/SaaS | Founder stories, "we monitor N apps and here's what breaks" | Tue/Thu |
| r/nocode | Platform-specific debugging tales (Bubble, Webflow, FlutterFlow) | Wed |
| r/webdev | Technical deep dives (API expiry, rate limits) | Thu |
| r/Entrepreneur | Revenue-angle: "silent failures cost you money" | Mon |
| r/startups | "We caught this before 500 users noticed" | Fri |
| r/alphaai | AI app builder community | Bi-weekly |

### Post Templates

**Template A — The "I Caught It" Story**
```
Title: I monitor AI apps for a living. Here's what broke today.
Body: Today's find: an expired OpenAI key on a customer support bot.
No errors in the UI. No support tickets. Just silent 401s.
Here's how we found it and fixed it in 12 minutes: [link/story]
```

**Template B — The Data Drop**
```
Title: We analyzed 47 AI app failures this month. Here's the breakdown:
Body: - Expired tokens: 34%
- Rate limit shifts: 22%
- Schema drift: 18%
- Broken webhooks: 15%
- Other: 11%
The common thread? Founders didn't know until we told them.
```

**Template C — The "You Might Be Broken Right Now"**
```
Title: Your no-code app might be broken right now and you don't know it.
Body: No dashboard error. No support ticket. No alert.
But your API key expired. Or your webhook endpoint changed.
Here's how to check in 30 seconds: [simple checklist]
```

### Engagement Protocol
- 15 min after posting: reply to every comment
- 2h after: DM top commenters
- 24h after: edit post with "Update: X people reached out, Y had active failures"
- Never link directly in first post — "DM me" or "link in profile"

---

## YouTube Acquisition Channel

### Channel Setup
- **Channel name:** Nightlamp Debugged
- **Tagline:** Catching what your dashboard misses
- **Banner:** Split screen — "What you see" (green dashboard) vs "What's really happening" (401 errors)
- **Custom URL:** youtube.com/@nightlampdebugged

### Content Funnel

**Top of Funnel (Shorts — 60s, daily)**
- "Your app is broken RN and you don't know it"
- "The $3K API key mistake"
- "Why your Stripe integration will fail tomorrow"
- Goal: Subscribe + follow to Instagram/Twitter

**Middle of Funnel (Deep Dives — 8-15 min, weekly)**
- Full case study walkthroughs
- "How we debugged [founder]'s [tech stack] in [minutes]"
- Playbook explanations: "What to do when your API rate limits shift"
- Goal: Email capture via "Free App Health Audit" link in description

**Bottom of Funnel (Comparison/ROI — 5-8 min, bi-weekly)**
- "Nightlamp vs. Manual Monitoring: 30-day comparison"
- "The true cost of an unnoticed failure"
- Founder interview/testimonial videos
- Goal: Free trial signup

### Production Setup
- Screen recording: OBS Studio
- Audio: Shure MV7 (or any USB mic)
- Editing: DaVinci Resolve (free)
- Thumbnails: Canva template with red/green split, bold white text
- Description template:
  ```
  [Title]

  📊 The Data
  - Time to detect: X min
  - Time to fix: X min
  - Users affected: X

  🔧 What broke: [summary]

  🛡️ How Nightlamp caught it: [summary]

  🆓 Get your free app health audit: [link]
  ─────────────────────
  Subscribe for weekly debugging stories → [link]
  ```

### Initial 4-Week Push
- Week 1-2: Record 10 shorts in one session (batch)
- Week 3: Release 1st long-form case study
- Week 4: First founder interview
- Budget: $0 (organic), 5h/week production time

### Cross-Promotion
- Every YouTube video → tweet thread
- Each tweet thread → Reddit post (48h later)
- Reddit success → case study blog → YouTube script
- Full flywheel: one debugging event creates content for every channel