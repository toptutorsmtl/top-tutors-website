# PRD: Replace Simon with two specialized Telegram bots

**Status:** Draft, ready to build
**Date:** 2026-11-11
**Owner:** me
**Working names:** **Coach** (fitness) and **Buddy** (accountability). Rename them whenever you like.

---

## 1. Summary

Simon is a single general-purpose AI bot. He is being retired and replaced by two narrow bots on Telegram. Each one gets its own BotFather token, chat, and personality:

| Bot | Job | Tone |
|---|---|---|
| **Coach** | Fitness and nutrition coach that reads my MacroFactor data (calories, macros, weight, steps, workouts) and coaches me on it | Evidence-based, direct, calm |
| **Buddy** | Accountability partner for daily commitments and personal goals | Warm, uplifting, brief, and never pushy |

## 2. Why (problems with Simon)

1. **He nags about stale topics.** After I tell him to drop something, he keeps bringing it up. Today his "memory" is loose conversation context, so "stop asking" never becomes a hard rule.
2. **His tone is too harsh.** The accountability style feels like being policed when it should feel supportive.
3. **He's a generalist.** Fitness coaching needs real data and domain depth. Accountability needs restraint and good timing. One persona does both badly.

## 3. Goals and non-goals

**Goals**
- Two separate Telegram bots, each focused on one job.
- Coach knows my real numbers from MacroFactor and keeps daily effort under about 1 minute.
- Buddy **never** brings up a topic I've dropped. This is enforced in code, not left to the prompt.
- Proactive messages have a strict budget and quiet hours.
- I'm the only user (single-user, private).

**Non-goals**
- Replacing MacroFactor. It stays the source of truth for logging food and weight.
- Multi-user support, group chats, or a web dashboard (maybe later).
- Reverse-engineering MacroFactor's backend (see §5).

---

## 4. Users and core scenarios

There is one user, me, on Telegram on my phone.

**Coach**
- "How am I doing this week?" → weekly averages, weight trend versus goal, protein adherence, and one or two concrete suggestions.
- Sunday evening → Coach sends a short weekly check-in without being asked.
- I send a screenshot of MacroFactor (dashboard, weight trend, or weekly check-in) → Coach reads the numbers, stores them, and replies with feedback.
- I send the MacroFactor `.xlsx` export → Coach imports all the history at once.
- "Is 3 days of high carbs going to mess up my cut?" → a domain answer that uses my actual data.
- *(Optional)* I send a meal photo → Coach gives a rough macro estimate as a sanity check. Logging still happens in MacroFactor.

**Buddy**
- Morning: "What are the 1–3 things that matter today?" I answer in a sentence.
- Evening: a light check-in ("How'd it go?"). Wins get celebrated and misses get no guilt.
- "Stop asking me about the podcast thing" → Buddy confirms *"Got it, dropped. I won't bring it up again."* and never does, unless I raise it myself.
- "Snooze the taxes thing till next Monday" → silent until then.
- I ignore two nudges in a row → Buddy goes quiet until I message first.

---

## 5. MacroFactor integration (research findings)

### What exists
- **There is no official public API.** The only official ways to get data out are the in-app **Data Export** (Quick and Granular export to a spreadsheet: nutrition, weight, workouts) and **Apple Health / Google Health Connect sync**. MacroFactor can write calories, macros, micronutrients, and **weight** to Apple Health.
- **The unofficial clients are now broken.** Several projects talked directly to MacroFactor's Firebase/Firestore backend: `sjawhar/macrofactor` (CLI and MCP), `zsrobinson/macrofactor`, and the Rust crate `macro-factor-api`. In **May 2026**, Stronger By Science turned on **Firebase App Check enforcement**. Every third-party login now fails with `401 Firebase App Check token is invalid`, and `sjawhar/macrofactor` is archived for that reason.
- **Building our own CLI against the backend would hit the same wall.** Getting around it would mean faking the official app's attestation. That is fragile, likely against their ToS, and could break any day. **Rejected.**

### Chosen approach (in phases)

| Phase | Method | Daily effort | Build effort | Notes |
|---|---|---|---|---|
| **v1** | **Screenshot ingestion.** I send screenshots of MacroFactor screens and Claude vision extracts the numbers. | ~15 s, only when I feel like it | Low | Works on day one with no dependencies. Coach can *ask* for a screenshot when data is stale. |
| **v1** | **`.xlsx` export ingestion.** I send the export file to Coach and it parses and upserts by date. | ~30 s, weekly | Low | Covers historical backfill and corrects any OCR mistakes. Exact column names get pinned from a real export file. |
| **v1.1** | **Apple Health push (if iPhone).** MacroFactor syncs to Apple Health, and a daily iOS Shortcut automation (or the *Health Auto Export* app's REST automation) POSTs the day's weight, calories, macros, and steps to `POST /ingest/health` on the bot server. | **Zero** | Medium | Fully automatic. The endpoint is protected by a shared secret header. |
| ~~—~~ | ~~Direct Firestore~~ | — | — | Rejected (App Check). |

If I'm on **Android**, v1.1 becomes a Health Connect export path, which needs research. Screenshots and xlsx still work in the meantime.

**Data precedence:** Health push > xlsx > screenshot. A row from a more reliable source overwrites a less reliable one for the same date.

---

## 6. Functional requirements

### 6.1 Coach

| ID | Requirement |
|---|---|
| C1 | Accept photos/screenshots. Classify them (MacroFactor dashboard, weight trend, food log, weekly check-in, meal photo, other), extract structured data, **show what was extracted**, and save it. |
| C2 | Accept `.xlsx`/`.csv` documents and import nutrition, weight, and workouts by date (idempotent upsert). |
| C3 | `POST /ingest/health` webhook for the automated push (v1.1). |
| C4 | Answer questions using the last N days of data plus goals. Always pull from the DB with tools, never from memory. |
| C5 | Weekly check-in (default Sunday 7pm). Covers 7-day average calories and protein versus targets, the trend-weight change, rate versus goal, and **one** actionable suggestion. |
| C6 | Stale-data nudge: if there's no data for 3+ days, send **one** soft message asking for a screenshot or export. Never more than one per stale period. |
| C7 | Store goals: phase (cut, maintain, bulk), target rate, calorie and macro targets, target weight. Editable by chat ("I'm switching to maintenance"). |
| C8 | Meal-photo macro estimate (optional, v1.1). Clearly labeled as an estimate. |

**Commands:** `/today` · `/week` · `/goals` · `/sync` (how to send data) · `/quiet` · `/help`

### 6.2 Buddy

| ID | Requirement |
|---|---|
| B1 | **Topic registry.** Every thing Buddy tracks (goal, habit, commitment, recurring concern) is a row with `status ∈ {active, snoozed, dropped, done}`. |
| B2 | **The drop guarantee.** When I say anything like "drop it", "stop asking about X", or "not relevant anymore", the LLM calls `drop_topic(id)`. Buddy confirms in one line. **Proactive messages are generated only from topics where `status = active`. That filter runs in code *before* the prompt is built.** Dropped topics never enter a proactive prompt. |
| B3 | Dropped topics come back **only** if I raise them myself. Buddy can then ask "Want me to start tracking this again?" |
| B4 | Snooze: `snooze_topic(id, until)`. A snoozed topic is invisible until its date. |
| B5 | Morning prompt (default 8:30) and evening check-in (default 21:00). Both are skippable, and Buddy adapts if I don't use them. |
| B6 | **Nudge budget:** max 3 proactive messages a day, quiet hours 22:30–08:00, at most 1 follow-up per topic per day. |
| B7 | **Back-off:** after 2 unanswered proactive messages, stop all proactive messages until I send something. |
| B8 | Light streaks and wins log. Celebrates consistency and never shames a miss. |
| B9 | `/topics` lists active and snoozed items so I can see what Buddy thinks I care about, with inline buttons for Drop, Snooze, and Done. |

**Commands:** `/topics` · `/drop` · `/snooze` · `/quiet [hours]` · `/checkin` · `/help`

**Buddy persona rules (system prompt):** warm, short (1–3 sentences by default), curious more than corrective, never lectures, and never repeats a reminder in the same day. Follows the user's lead on what matters. When unsure whether a topic is still relevant, Buddy **asks once** and accepts the answer.

---

## 7. Architecture

```
Telegram ──► Bot server (one service, two bot instances)
               ├── Coach handler ── Claude (vision + tools) ──┐
               ├── Buddy handler ── Claude (tools) ───────────┤
               ├── Scheduler (cron, America/Toronto)          ├── Postgres
               └── POST /ingest/health (shared-secret auth) ──┘
```

- **One repo, one deployed service, two bots.** A shared core (LLM client, DB, scheduler, auth) holds the plumbing, and each bot has its own folder with its persona, tools, and commands. Each bot has its own `TELEGRAM_TOKEN_*`.
- **Stack (default; change it if Simon's stack is worth reusing):** TypeScript + **grammY**, or Python + **aiogram**. Postgres via **Supabase**, hosted on **Railway** (always-on, cron-friendly). Use webhooks in prod and long polling locally.
- **LLM:** Claude API. Coach uses Sonnet 5.5 (`claude-sonnet-5-5`), which is needed for screenshot vision and data reasoning. Buddy can run on Haiku 5.5 (`claude-haiku-5-5`) for cheap, fast chat, with an upgrade to Sonnet if the tone suffers. Both use tool use. All DB reads and writes go through tools.
- **Memory = structured state, not chat logs.** Store the last ~20 messages plus a rolling summary for conversation context. Durable facts (goals, topics, metrics) live in tables. This is what fixes the Simon problem.
- **Security:** each bot replies only to my Telegram user ID (`ALLOWED_USER_ID`) and ignores everyone else silently. Secrets live in env vars only.

### Data model (first pass)

```sql
-- shared
messages(id, bot, role, content, created_at)
conversation_summary(bot, summary, updated_at)

-- coach
daily_metrics(date PK, weight_kg, trend_weight_kg, calories, protein_g, carbs_g, fat_g,
              steps, source /* health|xlsx|screenshot */, updated_at)
workouts(id, date, name, details_json, source)
coach_goals(id, phase, target_rate_pct_per_week, calories, protein_g, carbs_g, fat_g,
            target_weight_kg, effective_from)

-- buddy
topics(id, title, kind /* goal|habit|commitment|concern */, status /* active|snoozed|dropped|done */,
       snooze_until, created_at, dropped_at, last_mentioned_at)
checkins(id, date, type /* morning|evening */, content, created_at)
nudge_log(id, topic_id, sent_at, answered bool)
```

---

## 8. Setup: BotFather (×2)

For each bot:
1. In Telegram, open **@BotFather** and send `/newbot`.
2. Set the display name (e.g. "Coach") and a username that ends in `bot` (e.g. `yourname_coach_bot`).
3. Copy the token into `.env` as `TELEGRAM_TOKEN_COACH` or `TELEGRAM_TOKEN_BUDDY`.
4. `/setcommands` → paste that bot's command list from §6.
5. `/setdescription` and `/setuserpic` (optional, but it makes the two bots easy to tell apart).
6. Send the bot a message, then read your user ID from the logs and set `ALLOWED_USER_ID`.

---

## 9. Retiring Simon

1. **Export:** dump whatever Simon knows that's still useful (active goals, commitments).
2. **Migrate:** seed Buddy's `topics` with the **still-relevant** items only. Review the list by hand and drop the stale ones now.
3. **Parallel run (optional, ~3 days):** mute Simon in Telegram while the new bots run.
4. **Kill:** stop Simon's process and hosting, revoke his token in BotFather (`/revoke` or `/deletebot`), and remove his env vars and cron jobs.

---

## 10. Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold | Both bots created in BotFather. The repo, DB schema, and deploy pipeline exist, and both bots answer "hi" only to me. |
| M1 | **Buddy v1** | Topic registry, drop/snooze/done, morning and evening check-ins, nudge budget, and back-off all work. The drop guarantee has a test. |
| M2 | **Coach v1** | Screenshot and xlsx ingestion, `/today`, `/week`, goals, and the weekly check-in work. |
| M3 | Coach v1.1 | Apple Health → webhook automation runs daily with zero touch. Meal-photo estimates are added. |
| M4 | Simon retired | §9 complete. |

**Suggested scope for the first build session:** M0 + M1, then start M2. Buddy has no external dependencies, so it ships fastest.

---

## 11. Success criteria (after 2 weeks)

- **Zero** times a dropped topic is raised proactively. This is a hard requirement, covered by a unit test that builds a proactive prompt with a dropped topic and asserts it's absent.
- No more than 3 proactive messages a day from Buddy and no more than 2 a week from Coach (excluding replies).
- Coach has data for at least 6 of 7 days a week, with about 1 minute of my time a day or less.
- I still *want* to open both chats after 2 weeks.

---

## 12. Open questions (answer before or at the start of the build)

1. **Where does Simon live now** (stack, host, DB)? Reuse his infrastructure or start fresh?
2. **iPhone or Android?** This decides the v1.1 automation path (Apple Health Shortcut vs. Health Connect).
3. **Should Coach and Buddy share anything?** The default is fully separate. One option is for Buddy to get a read-only line like "gym 3/4 this week" from Coach.
4. **Workouts:** are they logged in MacroFactor Workouts or somewhere else?
5. **"Photos" for Coach:** screenshots of the app (assumed), meal photos, and/or progress photos? Progress photos are private body images; if wanted, store them encrypted or not at all.
6. Final **names and avatars** for the two bots.
7. Confirm the **timezone** (assumed America/Toronto) and the check-in times.

---

### Sources
- MacroFactor data export: https://help.macrofactorapp.com/en/articles/356-export-your-data
- MacroFactor Apple Health / Health Connect: https://help.macrofactorapp.com/en/articles/65-connect-health-connect-apple-health-or-fitbit
- Weight export to Apple Health (v2.9.3 notes): https://macrofactor.com/version-2-9-3/
- Nutrition export to Apple Health / Google Fit: https://macrofactor.com/mm-march-2022/
- Unofficial client, archived after App Check (May 2026): https://github.com/sjawhar/macrofactor
- Other unofficial clients: https://github.com/zsrobinson/macrofactor · https://crates.io/crates/macro-factor-api
