# PRD: Replace Simon with two specialized Telegram bots

**Status:** In build. Code is in `bots/`
**Date:** 2026-11-11
**Owner:** me
**Working names:** **Coach** (fitness) and **Buddy** (accountability). Rename them whenever you like.
**Decided:** iPhone. Coach's data comes in through an **Apple Health sync** (MacroFactor → Apple Health → bot), with app screenshots as the manual fallback.

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
- I log food and weigh in through MacroFactor as usual. Without me doing anything, the numbers flow into Apple Health and from there to Coach. **Coach always already knows my data.**
- Sunday evening → Coach sends a short weekly check-in without being asked.
- I send a screenshot of a MacroFactor screen (dashboard, weight trend, weekly check-in, macro targets) → Coach reads it. This is useful for things Apple Health doesn't carry, like trend weight, expenditure, or the targets MacroFactor recommends.
- I send the MacroFactor `.xlsx` export once → Coach backfills all my history.
- "Is 3 days of high carbs going to mess up my cut?" → a domain answer that uses my actual data.

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

### Chosen approach: Apple Health sync (primary) + screenshots (fallback)

```
MacroFactor ──(built-in sync)──► Apple Health ──(iPhone exporter)──► POST /ingest/health ──► Coach DB
```

Apple Health is the official, supported doorway out of MacroFactor. The bot server can't read Apple Health directly, because HealthKit only exists on the phone. So something on the iPhone has to read Health and push the data to the server.

**Pushing from the iPhone: two options**

| | **A. Health Auto Export app (recommended)** | **B. Apple Shortcuts (free)** |
|---|---|---|
| What it is | iOS app *Health Auto Export – JSON+CSV*. It has a built-in "REST API" automation that POSTs selected Health metrics as JSON to a URL on a schedule, with custom headers for auth. | A personal automation in the Shortcuts app: *Find Health Samples* for each metric → build a JSON dict → *Get Contents of URL* (POST). |
| Cost | Automations need the paid tier | Free |
| Build effort | Low. Tick the metrics, paste the URL and header. | Medium. One Find/Sum block per metric, which is fiddly to build and maintain. |
| Backfill / retries | Built in (can resend a date range) | Manual |
| Payload | Its standard JSON (`data.metrics[]` → `{name, units, data[{date, qty}]}`). **Verify against a real test export** before writing the parser. | Whatever we define |

**Decided: B (Apple Shortcuts).** The payload is a flat JSON object we define: `date, calories, protein_g, carbs_g, fat_g, fiber_g, steps, weight, weight_unit, weight_date`, all sent as text and parsed leniently on the server. Step-by-step guide: `bots/docs/apple-health-shortcut.md`.

**Metrics to sync** (only if MacroFactor writes them to Health; confirm on the permissions screen):
- Body Mass (weight). MacroFactor exports weight to Health.
- Dietary Energy, Protein, Carbohydrates, Total Fat (plus Fiber, if available).
- Steps. These usually come from the iPhone or Watch itself, not MacroFactor.
- *(Optional)* Active Energy, Workouts.

**Sync schedule:** every 1–2 hours plus whenever the app opens, resending **the last 2 days** each time. The server upserts by date, so resends are harmless, and late edits to yesterday's log still get picked up.

**iOS gotcha: Health data is locked while the phone is locked.** Background exports can't read Health while the iPhone is locked, so a sync at 3am may silently skip. To handle this:
- Use frequent syncs plus a resend window, so the next unlocked run catches up.
- For Shortcuts (option B), trigger on **"When MacroFactor is closed"**. The phone is unlocked at that moment, and I just changed data.
- Coach shows a "last synced" time on `/today`. If there has been no sync for 36h+, Coach sends **one** message: "Health sync looks stuck. Open Health Auto Export, or send me a screenshot."

**What Apple Health does *not* carry:** MacroFactor's **trend weight**, **expenditure (TDEE)** estimate, and **recommended macro targets**. Those live only in the app. Coach handles this two ways:
- Coach computes its own trend weight (an exponentially smoothed moving average, like MacroFactor's) and its own rough expenditure estimate from intake and weight change.
- Coach **asks for one screenshot of the weekly check-in screen** with the Sunday check-in, so it has MacroFactor's official expenditure and targets.

### All ingestion paths

| Path | Role | Daily effort |
|---|---|---|
| **Apple Health → webhook** | **Primary.** Daily weight, calories, macros, steps. | **Zero** |
| **Screenshots** | Fallback when the sync is stuck. Also the source of MacroFactor-only numbers (trend weight, expenditure, targets). | ~15 s, weekly |
| **`.xlsx` export** | One-time history backfill at setup, and for repairs. | Once |
| ~~Direct Firestore~~ | Rejected (App Check). | — |

**Data precedence (same date):** Health > xlsx > screenshot for raw logged values. Screenshots are the only source for MacroFactor's own computed values.

---

## 6. Functional requirements

### 6.1 Coach

| ID | Requirement |
|---|---|
| C1 | **`POST /ingest/health`** receives the Apple Health payload. It authenticates with a secret header (`X-Ingest-Key`), parses each metric, aggregates per day (sums intake and steps, takes the latest weight), and upserts into `daily_metrics`. It logs the raw payload to `health_raw` for debugging, and records `last_synced_at`. |
| C2 | Accept MacroFactor **screenshots**. Classify them (dashboard, weight trend, weekly check-in, macro targets, food log, other), extract structured data, **reply with what was extracted** so I can correct it, and save it. |
| C3 | Accept `.xlsx`/`.csv` exports and import history by date (idempotent upsert). |
| C4 | Answer questions using the last N days of data plus goals. Always pull from the DB with tools, never from memory. |
| C5 | Weekly check-in (default Sunday 7pm). Covers 7-day average calories and protein versus targets, the trend-weight change, rate versus goal, and **one** actionable suggestion. Ends by asking for a weekly check-in screenshot (optional). |
| C6 | Sync-health watchdog: no sync for 36h+ → **one** soft message per stale period. |
| C7 | Store goals: phase (cut, maintain, bulk), target rate, calorie and macro targets, target weight. Editable by chat ("I'm switching to maintenance") or from a targets screenshot. |
| C8 | Coach computes its own trend weight and a rough expenditure estimate from the synced data, so it doesn't depend on screenshots. |

*Out of scope:* meal-photo macro estimates. Logging stays in MacroFactor.

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
- **LLM:** Claude API through the SDK tool runner, with server-side refusal fallbacks. Both bots default to Opus 5.5 (`claude-opus-5-5`) and can be switched per bot with `COACH_MODEL` / `BUDDY_MODEL` (e.g. Haiku 5.5 for Buddy to cut cost). All DB reads and writes go through tools.
- **Memory = structured state, not chat logs.** Store the last ~20 messages plus a rolling summary for conversation context. Durable facts (goals, topics, metrics) live in tables. This is what fixes the Simon problem.
- **Security:** each bot replies only to my Telegram user ID (`ALLOWED_USER_ID`) and ignores everyone else silently. Secrets live in env vars only.

### Data model (first pass)

```sql
-- shared
messages(id, bot, role, content, created_at)
conversation_summary(bot, summary, updated_at)

-- coach
daily_metrics(date PK, weight_kg, calories, protein_g, carbs_g, fat_g, fiber_g,
              steps, active_kcal, source /* health|xlsx|screenshot */, updated_at)
mf_snapshots(id, date, trend_weight_kg, expenditure_kcal, target_calories, target_protein_g,
             target_carbs_g, target_fat_g, source /* screenshot|xlsx */, created_at)  -- MacroFactor-only values
health_raw(id, received_at, payload_json)  -- keep ~30 days for debugging the parser
sync_state(source PK, last_synced_at)
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

### 8b. Setup: Apple Health sync (iPhone)

1. **MacroFactor:** turn on Apple Health in the app's integrations / data sources settings, with **export** enabled for nutrition and weight. Then in iOS **Settings → Health → Data Access & Devices → MacroFactor**, check that it is allowed to *write* Dietary Energy, Protein, Carbs, Fat, and Body Mass.
2. Log one meal and one weigh-in, then confirm they appear in the **Health** app (Browse → Nutrition / Body Measurements).
3. Install **Health Auto Export – JSON+CSV** and give it read access to those metrics plus Steps.
4. Create an automation there: type **REST API**, URL `https://<bot-server>/ingest/health`, format JSON, header `X-Ingest-Key: <secret>`, the metrics above, aggregated **daily**, time range "since last sync" or the last 2 days, and the most frequent schedule available.
5. Run it manually once. Coach should reply in Telegram with "✅ Synced: 82.4 kg, 2,150 kcal, 165 g protein…". Use the `health_raw` table to adjust the parser to the real field names.
6. Send Coach the MacroFactor `.xlsx` export once to backfill history.

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
| M2 | **Coach v1** | Apple Health → `/ingest/health` sync runs with zero touch (§8b). `/today`, `/week`, goals, and the weekly check-in work. The sync watchdog is in place. |
| M3 | Coach v1.1 | Screenshot ingestion (MacroFactor-only values), xlsx backfill, own trend weight and expenditure estimate. |
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
2. **Should Coach and Buddy share anything?** The default is fully separate. One option is for Buddy to get a read-only line like "gym 3/4 this week" from Coach.
3. **Workouts:** are they logged in MacroFactor Workouts or somewhere else? If MacroFactor Workouts writes them to Apple Health, add the Workouts type to the sync.
4. Final **names and avatars** for the two bots.
5. Confirm the **timezone** (assumed America/Toronto) and the check-in times.

*Resolved:* iPhone → Apple Health sync is the primary path, built with Apple Shortcuts. "Photos" means MacroFactor app screenshots only.

---

### Sources
- MacroFactor data export: https://help.macrofactorapp.com/en/articles/356-export-your-data
- MacroFactor Apple Health / Health Connect: https://help.macrofactorapp.com/en/articles/65-connect-health-connect-apple-health-or-fitbit
- Weight export to Apple Health (v2.9.3 notes): https://macrofactor.com/version-2-9-3/
- Nutrition export to Apple Health / Google Fit: https://macrofactor.com/mm-march-2022/
- Unofficial client, archived after App Check (May 2026): https://github.com/sjawhar/macrofactor
- Other unofficial clients: https://github.com/zsrobinson/macrofactor · https://crates.io/crates/macro-factor-api
- Health Auto Export (App Store): https://apps.apple.com/app/id1115567069
- Health Auto Export REST API / JSON format wiki: https://github.com/Lybron/health-auto-export/wiki
- Example receiver for Health Auto Export payloads: https://github.com/irvinlim/apple-health-ingester
