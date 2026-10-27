---
name: launch-video
description: Make a product launch video, animated in code and rendered to MP4, in one of two styles. Kinetic (default): the SaaS launch video (words appear with the voiceover, keyword pills, counters, glowing logo reveal, product UI with camera moves, cursor, notification toasts). App ad: the 3D product ad for a mobile app (a real screen recording inside a 3D iPhone the camera flies around, short text cards on the beat, light-beam words, sparkles, wordmark end card). Includes a voiceover module (record your own voice, or Fish Audio / ElevenLabs voices) and a brand pull from a website (context.dev). Use when someone wants a launch video, app launch video, product video, promo, demo ad, SaaS ad, spec ad, feature announcement, "a video like this launch video", or a Remotion/After-Effects-style motion graphic for X, LinkedIn, YouTube, Reels or TikTok.
---

# Launch videos

You write the script, design every scene as JSON, voice it, and render it. The engine is a deterministic HTML
motion-graphics player rendered frame by frame in headless Chrome, so it looks the same every render and a 40 s
video renders in about 20 s. The style is the modern SaaS launch video: one short line at a time, each word
landing exactly when it's spoken, one keyword in an accent pill, real product UI between the lines.

Paths below are relative to this skill's folder (`<skill>`). Projects live in `launches/<name>/` in the user's
working directory (`plan.json`, `assets/`, then `vo/`, `timeline.json`, `out/` are written for them).

## 0. First run

```bash
cd <skill>/engine && npm install          # playwright-core + fonts (Inter Tight, Instrument Serif, JetBrains Mono)
pip3 install numpy scipy requests sounddevice faster-whisper   # sounddevice records; faster-whisper gives exact word timings
```
Needs Google Chrome (or set `CHROME=/path/to/chrome`) and ffmpeg.

## 1. Brief: ask once, in one message

1. **What is it?** Product name and one line on what it does. Who is it for?
2. **What's true?** 3–5 things it does, in the user's words. Any real numbers (users, time saved, results)?
3. **Assets:** screenshots or screen recordings of the real product (a folder is fine), logo (optional: the
   default mark is a glowing accent orb), brand accent colour (default `#0DDD4B` green).
4. **Call to action** and link (free trial, waitlist, "comment X", download).
5. **Format:** 16:9 (X, LinkedIn, YouTube, website) or 9:16 (Reels, TikTok, Shorts). One format per video.
6. **Voice:** A) record it yourself  B) a Fish Audio voice  C) an ElevenLabs voice. (A free macOS voice is used
   for the timing draft either way.)
7. **Style:** A) kinetic (default: voiced, kinetic type over product UI) B) app ad (a phone app: 3D iPhone shots of a
   screen recording, short text cards on the beat, mostly music; see "App ad style" below).

Copy their assets into `launches/<name>/assets/`.

### App ad style (3D phone, music-driven)

Measured from a fomo spec ad (19.7 s, 1920x1080, no voiceover): dark navy text cards with a soft accent glow, one
short line each, word by word, regular weight; 3D device shots of the real app on a pale accent wash or in the dark,
camera always moving (rise out of the dark, slow orbit, low-angle close-up, flyover with lens blur); one bold all-caps
word on a light beam; sparkles around a feature; the wordmark alone on the wash to end. Cards ~0.9–1.1 s, phone
shots ~1.3–1.8 s, alternating, cuts on the beat.

1. Prepare the recording (HEVC -> H.264 at full resolution, keyframes; `--blur` only as a safety net, see 2):
   `python3 <skill>/screen.py ~/Downloads/ScreenRecording.MP4 launches/<name>/assets/app.mp4 --blur 25.8-`
   Make a 1 fps contact sheet first (`ffmpeg -i app.mp4 -vf fps=1,scale=220:-1,tile=12x4 sheet.jpg`) to find the
   second each screen starts (`in`) and which spans show other people.
2. Plan: set `"look": "clean"` (crisp: no blur on reveals, exits or the camera, hard cuts, calmer angles) and pull
   the brand with `brand.py`. Alternate `text` cards (`bg: "dark"`, `weight: 400`, no `vo`, `dur` 0.9) with `phone`
   scenes (`src`, `in`, `cam: rise|hero|closeup`, `flip` to mirror, `status: "dark"` on dark screens) on SOLID brand
   backgrounds: `accent` (the brand colour), `light`, `dark`. One caps word on `accent` (`size: 190, weight: 700`).
   End card: `"@brand"` (mark + name) on `light` with the product's own tagline as `sub`. Captions only name what's on
   screen at that moment (true by construction). Lessons from review: no gradient backgrounds (`wash`/`night`/`beam` read
   as unclean), no sparkles, never show blurred people: cut those screens instead.
3. Voice is optional: a voiced hook before the ad and an outro/CTA after it work well; silent scenes just need `dur`.
   `"vo": {"snap": true}` snaps every cut to the music's beat; set `music.drop` to the first phone shot.
Example: [examples/app-ad/plan.json](examples/app-ad/plan.json) (the 8AM WORLD spec ad; it needs a screen recording
at `assets/app.mp4`).

### Brand from a link (context.dev)

When they give a website, pull its brand instead of asking for colours and a logo:

```bash
python3 <skill>/brand.py launches/<name> stripe.com        # logo + icon, colours, font files, homepage screenshot -> plan.json theme
```
- With `CONTEXT_DEV_API_KEY` set (env or `<skill>/.env`), it calls context.dev itself (~21 credits a site, cached in `assets/brand/`).
- With no key but the **context.dev MCP connected**, call its `brand-retrieve-unified` (`{"type": "by_domain", "domain": ...}`)
  and `web-styleguide` (`domain`) tools, save the responses as `assets/brand/brand.json` `{"domain", "brand"}` and
  `styleguide.json` `{"domain", "styleguide"}`, then run the same command: it applies the saved data and shoots the
  screenshots locally (`engine/shoot.mjs`, free).
- It sets `brand.name` from the brand data's title: check it against the site's wordmark (context.dev's title is
  "Context", its wordmark "Context.dev"). Open the logo files and the screenshot before using them.
- More screenshots of real pages: `node <skill>/engine/shoot.mjs <url> assets/<name>.png [--w 1440 --h 900 --full --scroll 600 --hide ".cookie"]`.

## 2. Script

Write the voiceover as short lines, one line per scene. The structure that works (measured from the reference
launch video, 52 s, 22 lines, ~2.6 spoken words/s, no line longer than ~9 words):

| beat | ~time | example shape |
|---|---|---|
| Hook: "you" + a concrete moment | 0–4 s | "You just got {11..22} warm leads." |
| The problem, as a question | 4–8 s | "But which video actually [sent them?]" |
| Reveal | 8–10 s | "Meet" (hero) → "Pulse." (logo lockup) |
| What it does, one line | 10–13 s | "It lets you [track conversions] from your organic content." |
| 3–5 features, each with real UI | 13–40 s | imperative or "you" lines, one idea each |
| The twist: a second audience | 40–45 s | "Own a content [agency?]" |
| Lockup + tagline | 45–49 s | logo with tagline |
| CTA | last 3 s | "Start your [free trial.] today." |

Rules:
- **Only true claims.** Counters and stats must be the user's real numbers. Never invent customers, results or
  quotes. If a hook needs a fact you don't have, ask, or write 2–3 hook options and let them pick.
- One pill per line at most, on the word that carries the line. Accent colour (`*word*`) for a softer emphasis.
- Lines say what the UI shows at that moment. If there's no UI for a feature, cut the feature or make it a text line.
- 30–60 s. Shorter is better than padded.

Show the user the script (just the lines) before building scenes. `python3 <skill>/vo.py script launches/<name>`
prints it once the plan exists.

## 3. Plan

Write `launches/<name>/plan.json`. Full reference: [reference/plan.md](reference/plan.md). Style rules (type sizes,
colours, motion, pacing): [reference/style.md](reference/style.md). Working example: [examples/launch-skill/plan.json](examples/launch-skill/plan.json).

```json
{
  "name": "pulse-launch", "format": "16:9",
  "brand": {"name": "Pulse"}, "theme": {"accent": "#0DDD4B"},
  "scenes": [
    {"type": "text", "bg": "dark", "vo": "You just got {11..22} warm leads."},
    {"type": "text", "mode": "type", "vo": "But which video actually [sent them?]"},
    {"type": "hero", "vo": "Meet"},
    {"type": "logo", "vo": "Pulse. Intelligent tracking for content funnels.", "tagline": "Intelligent tracking for|content funnels."},
    {"type": "ui", "bg": "light", "src": "assets/overview.png", "vo": "It lets you [track conversions] from your organic content.",
     "text": "It lets you [track conversions]", "side": "top", "cam": "tilt"},
    {"type": "text", "bg": "dark", "vo": "Start your [free trial.] today.", "sub": "pulse.app"}
  ]
}
```

Scene types: `text` (kinetic line), `hero` (huge glowing word), `logo` (orb/mark + name + tagline), `ui`
(screenshot or screen recording in a window: camera, cursor + clicks, focus lift, typing, toasts, scroll),
`cards` (floating screenshots), `terminal` (typed commands + output), `chips` (flow: 2.7K Clicks → 6.5% → 129 Leads),
`tags` (a line with floating chips around it), `app` (the terminal beat in the light Claude Code desktop look), `layers` (3D exploded view: a screenshot tips back and its logo,
colours and font rise off it). For depth: `cam: "tilt"` on ui/terminal, `layout: "coverflow"` on cards.
Markup in `vo`/`text`: `[pill]`, `*accent*`, `_serif italic_`, `{from..to}` counter, `@brand`, `|` line break.

Alternate backgrounds the way the reference does: dark for the hook and reveal, light for the product, dark (or
glow) for the close. Use the user's real screenshots for every feature beat; point the cursor and focus at the
exact thing the line talks about (coordinates are fractions of the screenshot, so open the image and check).

## 4. Draft board (before any voice)

```bash
node <skill>/engine/render.mjs launches/<name> --board     # one frame per scene -> out/board.jpg (timing estimated)
node <skill>/engine/render.mjs launches/<name> --still 4.2  # exact frame -> out/stills/
```
Look at the board yourself (Read the jpg) and fix layout problems before showing it. Show the user.

## 5. Voice

Each route writes one clip per line to `vo/clips/`, then builds `vo/vo.wav` and `timeline.json` (word-level timings
every caption syncs to). Clips are cached by text and voice: after a script edit only changed lines regenerate.

```bash
python3 <skill>/vo.py say    launches/<name>                    # free macOS draft voice (timing only)
python3 <skill>/vo.py record launches/<name>                    # A: teleprompter, one take per line
python3 <skill>/vo.py record launches/<name> --line 4           #    redo one line
python3 <skill>/vo.py import launches/<name> take.m4a           #    or one take recorded anywhere (phone, QuickTime)
python3 <skill>/vo.py auphonic launches/<name>                  #    then master the takes with Auphonic (optional)
python3 <skill>/vo.py fish-voices "energetic male narrator"     # B: search Fish Audio's public voices
python3 <skill>/vo.py fish   launches/<name> --voice <id>       #    default model s2.1-pro-free (Fish's free tier)
python3 <skill>/vo.py eleven-voices                             # C: voices this ElevenLabs key can use
python3 <skill>/vo.py eleven launches/<name> --voice <voice_id> #    exact word timings come from the API
```
- **Recording** runs in the user's own terminal (it needs the microphone and Enter presses), so give them the
  command; don't run it yourself. They speak each line after pressing Enter, Enter again to stop, then keep/retake/play.
  If no audio arrives, the terminal app needs microphone permission (System Settings > Privacy > Microphone);
  `vo.py devices` lists mics for `--device N` (it skips virtual inputs like Teams/Zoom by default).
- **Mastering a recorded voice (optional, recommended):** `python3 <skill>/vo.py auphonic launches/<name>` sends every
  take to [Auphonic](https://auphonic.com) as one production: adaptive leveler, dynamic noise reduction (12 dB), voice
  AutoEQ (includes a de-esser), -16 LUFS. Cutting is always off and the result is split back into the same takes, so
  the timeline doesn't move; then it rebuilds. Without it, takes still get a local high-pass + denoise. Billing: one
  production per run, 3 min minimum; the free plan is 2 h/month and adds an Auphonic jingle to its output (the voice
  track keeps only the takes; paid or one-time credits have no jingle). `--dry-run` shows the settings without sending.
  Re-run it after re-recording any line; `build` warns when an enhanced take is stale.
- **Keys:** `FISH_API_KEY` / `ELEVENLABS_API_KEY` / `AUPHONIC_API_KEY` (auphonic.com/accounts/settings/#api-key) in the environment or in `<skill>/.env`. Ask the user to add them
  themselves; never ask them to paste a key into chat. Generating spends their credits: say roughly how many characters
  the script is (`vo.py script` × line length) before running.
- Pacing knobs per scene: `pre` (silence before the line, default 0.12 s), `post` (after, 0.28 s), `dur` (minimum
  scene length, for UI that needs time: keep it to what the animation needs, ~2.2–2.6 s for a terminal; extra
  `dur` is dead air), `join: true` (say this line in one breath with the previous scene's,
  for natural intonation across a visual cut). Then `vo.py build` re-lays the timeline without regenerating.

## 6. Render

```bash
node <skill>/engine/render.mjs launches/<name>          # -> out/<name>.mp4 (1080p30, voice + music + SFX) and out/<name>-review.mp4 (720p)
node <skill>/engine/render.mjs launches/<name> --draft  # half size, 15 fps
```
Music: the default is a synthesized, license-free bed whose beat drops on the first hero/logo scene and thins out on
the last scene. For a real track: `"music": {"file": "assets/track.mp3", "start": 12.0, "gain": 0.35}` (it must be
licensed for ads). `"music": false` for voice + SFX only. SFX (pops on pills, keys on typing, clicks, dings, whooshes,
riser + boom into the reveal) come from the scenes automatically; add more with a scene's `"sfx": [{"name": "boom", "at": 0.4}]`.

Check the render before delivering: pull frames around every scene change
(`ffmpeg -ss <t> -t 3 -i out/<name>.mp4 -vf fps=5,scale=480:-1,tile=4x4 strip.jpg`) and look for text collisions,
cursors pointing at the wrong thing, and captions that run ahead of or behind the voice.

## 7. Deliver

Give the user `out/<name>.mp4`, the script, and what's left (e.g. swap the draft voice for theirs). Posting:
- X / LinkedIn: upload the 16:9 file natively; first line of the post = the hook.
- Reels / TikTok: render with `"format": "9:16"` (layouts reflow), or film the 16:9 video playing full-screen on a
  laptop in a dark room, handheld and vertical, with a one-line caption on top. That over-the-shoulder version reads
  as "look what this made" and suits a "comment X and I'll send it" CTA.
