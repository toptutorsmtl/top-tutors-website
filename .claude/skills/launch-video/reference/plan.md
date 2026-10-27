# plan.json reference

```jsonc
{
  "name": "pulse-launch",            // output file name (default: folder name)
  "format": "16:9",                  // 16:9 (1920x1080) | 9:16 (1080x1920) | 1:1 | 4:5. Layouts reflow for portrait.
  "fps": 30,
  "brand": {"name": "Pulse", "mark": "assets/logo.png"},   // mark optional: replaces the glowing orb
  "theme": {"accent": "#0DDD4B", "dark": "#000000", "light": "#FDFDFD", "ink": "#0B0B0C", "paper": "#ECEDF1", "font": "Inter Tight"},
  "music": {"synth": true, "bpm": 112, "key": 0, "gain": 0.42, "drop": null, "outro": null},
           // or {"file": "assets/track.mp3", "start": 12.0, "gain": 0.35} | false
  "mix": {"vo": 1.0, "duck": 0.55, "sfx": 0.55},
  "vo": {"lead": 0.3, "pre": 0.12, "post": 0.28, "hold": 1.3, "level": -17, "denoise": true, "denoise_db": 18},
          // timeline defaults (seconds, dBFS); denoise applies to recorded takes only
          // "auphonic": {...} overrides Auphonic algorithm fields, e.g. {"denoisemethod": "speech_isolation", "loudnesstarget": -14}
  "scenes": [ ... ]
}
```

## Every scene

| field | |
|---|---|
| `type` | `text` `hero` `logo` `ui` `cards` `terminal` `chips` |
| `vo` | the line spoken in this scene, with markup. Its words drive every reveal. Omit for a silent beat (then set `dur`). |
| `text` | what's shown, if different from `vo` (markup allowed). Words are matched to the spoken words; unmatched ones are interpolated. |
| `say` | pronunciation for TTS only ("launch video" for `launch-video`, "skill dot M D"). |
| `bg` | `dark` `light` `dots` (light + dot grid) `glow` (dark + centred accent glow) `glowbottom` `lightglow` (light + accent wash from the bottom) `night` `wash` `beam` (app-ad style, see phone) |
| `out` | exit: `blur` (text default) `zoom` `slide` `fade` `cut` (ui/cards/terminal default). zoom/slide add a whoosh. |
| `pre` `post` | silence before / after this line (s) |
| `dur` | minimum scene length (s): give UI scenes room to breathe |
| `join` | `true`: voiced in one breath with the previous scene's line (one TTS request / one take), cut between them at the word gap |
| `hold` | last scene only: how long the end card stays |
| `sfx` | extra cues `[{"name": "boom", "at": 0.4, "gain": 0.6}]`. Kit: `whoosh swish riser boom pop click ding key1 key2 key3 enter` |

## Markup (in `vo`, `text`, `tagline`)

| markup | renders |
|---|---|
| `[sent them?]` | accent pill, white text (grows word by word) |
| `*organic content.*` | accent-coloured words |
| `_like mine?_` | serif italic (Instrument Serif) |
| `{11..22}` / `{$29,897}` / `{40%}` | counter pill that counts up when spoken (`{22}` counts from half) |
| `@brand` | inline mark + brand name |
| `\|` | line break |

Punctuation right after markup sticks to it: `[views].`

## text

`mode`: `words` (default: each word blurs and rises in as it's spoken, the line re-centres as it grows), `type`
(typed with a caret, fresh letters flash accent), `letters` (letters resolve in random order; for big headings).
`size`: `xs s m l xl xxl` (44/60/80/100/150/240 px at 1080p) or a number. Long lines wrap into balanced lines, then shrink to fit.
`pos`: `center` `top` `bottom` `left`. `align`, `color`, `weight`, `grow: false` (no re-centring), `sub` (small line underneath, e.g. a URL).

## hero

One huge word in an accent gradient with glow (the "Meet" frame). Default `bg: glow`. A riser leads into it and a boom
lands on it; the synth music drops here.

## logo

Mark (orb, or `brand.mark`) pops in with rings on the brand word, slides left as the name writes on. `tagline`
(markup, `|` breaks) wipes in behind a glowing accent bar as it's spoken. Portrait stacks the tagline underneath.

## ui

Screenshot (`png jpg webp`) or screen recording (`mp4 mov webm`, with `in` = start second and `speed`) in a browser window.

| field | |
|---|---|
| `src` | the image/video |
| `text`, `side` | caption beside (`left` `right`) or above (`top`) the window. Portrait always puts it on top. |
| `frame` | `browser` (default, three dots) or `none`; `title` for the bar; `dark: true` for dark UIs |
| `width` | window width as a fraction of the frame |
| `cam` | `push` (default gentle push-in), `tilt` (3D tilt-up entrance), `pan` (scroll a tall screenshot inside the window), `pushleft`, `still`, or keys `[{"at": 0, "s": 1}, {"at": 2.5, "to": [x, y, w, h], "fill": 0.55}]`: `to` zooms so that rect of the screenshot fills `fill` of the frame; plain keys take `s` scale, `x` `y` (fractions of the window), `rx` `ry` (degrees) |
| `scroll` | 0–1 (scroll by the end) or keys `[{"at": 0.5, "y": 0}, {"at": 2, "y": 0.6}]` |
| `cursor` | `[{"at": 0.4, "x": 0.31, "y": 0.52}, {"at": 1.1, "x": 0.62, "y": 0.4, "click": true}]` (x/y = fractions of the screenshot) |
| `focus` | `[{"at": 1.2, "rect": [x, y, w, h], "s": 1.08}]` lifts that region out as a glowing card and dims the rest |
| `typing` | `[{"at": 0.8, "x": 0.4, "y": 0.3, "text": "Adam Client", "size": 0.013, "cps": 16}]` types into a field |
| `toasts` | `[{"at": 0.6, "title": "Call booked", "body": "Someone booked a call with you?", "icon": "📅"}]` (icon: emoji or image path; `x` = left edge as a fraction of the frame, default centred) |
| `toastY` | where the toast stack starts, fraction of the frame height (default 0.16; push it down under a `top` caption) |
| `blurBehind` | blur the window while toasts show; `glow: true` fades the accent wash in (`glowAt` s) |

Coordinates are fractions of the screenshot: open it, find the pixel, divide by its width/height.

## cards

`items: [{"src": "assets/a.png", "label": "Portfolios", "at": 0.3}]`, `layout`: `row` `fan` `grid` (`cols`) `coverflow`
(3D: the middle card faces you, the others turn toward it), `stagger` (s between cards), `text` above. Portrait stacks them vertically.

## layers

Exploded 3D view: the screenshot (`src`) tips back like a page on a table, and what was pulled from it rises off it on
dashed beams, each lifting when its `word` is spoken (a ring pulses where it came from).
`items`: `{"kind": "image", "src": "assets/mark.png"}` · `{"kind": "colors", "colors": ["#2563EB", "#FFFFFF"]}` ·
`{"kind": "font", "font": "Rethink Sans", "fontFile": "assets/font.woff2", "sample": "Aa"}`, each with `label`,
`from: [x, y]` (fraction of the screenshot), `word`, `lift` (px), or `at`. Scene: `text` (caption on top), `width`,
`rx` (tilt, 56), `rz` (turn, -26), `scale` (0.9 fits a 16:10 screenshot), `drop`, `tipAt`, `tipDur`. Good after a brand pull (brand.py).

## terminal

`cam: "tilt"` swings the window up out of 3D and keeps it slightly angled.

## phone

A screen recording (or screenshot) inside a 3D iPhone (titanium rim with depth, clean `8:00` status bar over the
recording's own, Dynamic Island, glass glare) that the camera flies around. The app-ad style's main shot.

| field | |
|---|---|
| `src`, `in`, `speed` | the recording (prepare it with `screen.py`), where to start, playback speed |
| `cam` | `rise` (up out of the dark), `hero` (slow 3D orbit, default), `flyover` (close, steep, lens blur), `closeup` (with `to: [x, y, w, h]` of the screen and `fill`), or keys `[{"at", "rx", "ry", "rz", "x", "y", "s", "blur"}]` |
| `flip` | mirror the move (alternate shots) |
| `status` | `"dark"` for dark screens, `false` to keep the recording's own status bar; `time` (default `8:00`) |
| `height` | screen height as a fraction of the frame (0.92) |
| `sparkles` | number of twinkling stars around the phone |
| `text`, `side` | optional caption left/right of the phone |

Backgrounds: solid `accent` (the brand colour), `light`, `dark` read cleanest. Also `night` (soft accent glow), `wash`
(pale accent gradient), `beam` (light cone from below). The phone is laid out at the recording's native size and scaled
by the camera, so close-ups stay sharp: give it a full-resolution recording (`screen.py` keeps it).

Plan-level `"look": "clean"`: no blur anywhere (word reveals, exits, lens blur), hard cuts between scenes, phone
presets at 60% of their angles (`amp` per scene overrides).

## app

The same idea as `terminal`, in the light Claude Code desktop look: traffic lights, a sidebar with the session
highlighted, your message typed into the "Type / for commands" box and sent as a bubble, then the reply.
`lines`: `{"cmd": "/launch-video stripe.com"}` (your message) · `{"out": "Pulled the brand", "tool": true}` (grey tool
row with ›) · `{"out": "✓ done", "accent": true}` · `{"out": "plain reply line"}`. `session` (sidebar + title),
`text` (caption on top), `scale` (UI size; 1.4 reads on a phone filming a laptop), `width`, `aspect` (0.5), `cam: "tilt"`.

## terminal

`lines`: `{"cmd": "/launch-video"}` (typed, `prompt` default `›`, `cps` 26) and `{"out": "✓ done", "accent": true}`
or `"dim": true`. Lines run in order (`pause` after each, or absolute `at`) and are compressed to fit the scene.
`title` (bar), `text` (caption above), `fontSize`, `width`.

## chips

`items: ["2.7K Clicks", "→6.5%", "129 Leads", "→", "16 Customers"]`. First word bright, the rest grey; `→x%` is an
accent arrow tile. Each chip appears when its label is spoken (else evenly); the row scrolls to follow. `at: [..]` to time by hand.
