# Coach + Buddy: two Telegram bots that replace Simon

- **Coach** is a fitness and nutrition coach. MacroFactor syncs to Apple Health, an iPhone Shortcut forwards the numbers to this server, and Coach coaches you on them. You can also send it MacroFactor screenshots.
- **Buddy** is an accountability partner that is warm and brief. Tell it "drop it" about anything and it will **never** bring that topic up again.

Spec: [`../docs/prd-coach-and-buddy-bots.md`](../docs/prd-coach-and-buddy-bots.md). iPhone setup: [`docs/apple-health-shortcut.md`](docs/apple-health-shortcut.md).

## How it works

```
Telegram ◄─long polling─► one Node service ── Postgres (Supabase)
                           ├── Coach   (Claude + tools: metrics, goals, screenshots)
                           ├── Buddy   (Claude + tools: topics, check-ins, quiet)
                           ├── cron    (Buddy 08:30 / 21:00, Coach Sun 19:00, sync watchdog)
iPhone Shortcut ──POST──►  └── /ingest/health  (X-Ingest-Key)
```

- **Drop guarantee:** Buddy builds its unprompted messages only from topics with `status = active`. That filter runs in code (`topicsForProactive`) before the prompt is built, and the prompt includes no chat history. A test covers it.
- **Nudge budget:** at most 3 unprompted messages a day, quiet hours 22:30–08:00, and silence after 2 unanswered messages until you write first. `/quiet 4` pauses Buddy for 4 hours.
- **Data precedence:** Health sync values always win. Screenshots only fill empty fields, and zeros and blanks never erase data.

## Setup (≈30 min)

### 1. Create the two bots
In Telegram, open **@BotFather** and run this twice:
1. `/newbot`, give it a name (`Coach`) and a username ending in `bot`, and copy the token.
2. Repeat for `Buddy`.

The service sets each bot's command menu itself on startup.

### 2. Database (Supabase)
The `coach_bots` schema and a `coach_bots_app` role already exist in **supabase-toptutors**. The role can only use that schema, never the Top Tutors tables. To finish:
1. Supabase → **SQL Editor**, run once (pick your own password, letters and digits only):
   ```sql
   ALTER ROLE coach_bots_app WITH LOGIN PASSWORD 'pick-a-long-password';
   ```
2. Supabase → **Connect → Session pooler** → copy the URI. Change the user from `postgres.uenbatswdwcilpatlsta` to `coach_bots_app.uenbatswdwcilpatlsta`, and put your password in. That's `DATABASE_URL`. Also set `DB_SCHEMA=coach_bots`.

Tables are created automatically on first boot.

### 3. Deploy (Railway)
1. **New Project → Deploy from GitHub repo** → pick this repo. In **Settings**, set **Root Directory** to `bots`.
2. Railway detects Node, runs `npm install` and `npm run build`, then starts with `npm start`.
3. Add the variables from `.env.example`:
   - `TELEGRAM_TOKEN_COACH`, `TELEGRAM_TOKEN_BUDDY`
   - `ANTHROPIC_API_KEY`
   - `DATABASE_URL`
   - `INGEST_KEY`: a long random string, e.g. the output of `openssl rand -hex 24`
   - leave `ALLOWED_USER_ID` empty for now
4. Go to **Settings → Networking → Generate Domain**. That URL plus `/ingest/health` is what the Shortcut posts to. `GET /healthz` should return `{"ok":true}`.
5. Message either bot. It replies with your Telegram user id. Set `ALLOWED_USER_ID` to that id and redeploy. From then on, both bots ignore everyone else.

### 4. iPhone
Follow [`docs/apple-health-shortcut.md`](docs/apple-health-shortcut.md).

### 5. First conversations
- **Coach:** tell it your goals ("cutting at 0.5%/week, 2100 kcal, 170 g protein"), or send a screenshot of MacroFactor's targets screen.
- **Buddy:** tell it what you're working on. This is where the items worth keeping from Simon go. Just tell Buddy the ones that still matter.

## Models
Both bots default to `claude-opus-5-5`. To trade some quality for cost, set `BUDDY_MODEL=claude-haiku-5-5` (Buddy is short chat) and/or `COACH_MODEL=claude-sonnet-5-5`. Coach needs a model that can read images. Refusal fallbacks are enabled server-side (`fallbacks: "default"`).

## Local dev
```bash
cd bots
npm install
cp .env.example .env   # fill it in
npm test               # 35 tests, using in-process Postgres (PGlite); no keys needed
npx tsx --env-file=.env src/index.ts
```
Simulate the Shortcut:
```bash
curl -X POST localhost:3000/ingest/health -H "X-Ingest-Key: $INGEST_KEY" -H 'content-type: application/json' \
  -d '{"date":"2026-11-12","calories":"2140","protein_g":"168","weight":"181.2","weight_unit":"lb","test":true}'
```

## Not built yet (from the PRD)
- `.xlsx` history import (for now, send screenshots or tell Coach the numbers).
- Retiring Simon: this depends on where Simon runs today.
