# PRIMORIS trial-reel animation

One Manim animation that renders every trial-reel creative. Adding a creative means
adding an entry to `CREATIVES` in `primoris_reel.py` — the engine does not change.

## What's here

| File | What it is |
| :--- | :--- |
| `primoris_reel.py` | The engine, the diagram registry, and the three creatives |
| `export_scripts.py` | Dumps each creative's spoken track as `.srt` + a `.md` beat sheet |
| `scripts/` | Generated output of the above — six languages × creatives |

## Render

```bash
pip install manim                    # needs libcairo2-dev, libpango1.0-dev, ffmpeg
manim -qh primoris_reel.py ParaboleFr
python3 export_scripts.py            # regenerate scripts/ after any beat edit
```

Scene names are `{Ppm,Parabole,Area}{Fr,En}`. Output lands in
`media/videos/primoris_reel/1920p30/` (gitignored).

The file pins `config.pixel_width/height/frame_rate`, so every quality flag renders
**1080×1920 @ 30fps** — `-ql` only trades render speed, never output format. That is
deliberate: a reel that renders at a preview size by accident is a reel that gets
uploaded at a preview size.

No LaTeX needed. All maths is Pango text with unicode glyphs (`x²`, `−`, `×`, `k³`),
which keeps glyph weight closer to pen-on-paper than a TeX render anyway.

## The creatives

| Scene | Source creative in Drive | Problem |
| :--- | :--- | :--- |
| `Ppm{Fr,En}` | `matei_ppm_fr.mp4`, `matei_ppm_en.mp4` | Convert 0.72 g/L to ppm |
| `Area{Fr,En}` | `matei_area_fr.mp4` | Find the dimensions of a rectangle with sides x + 2 and x − 2 and area 21 m² |
| `Parabole{Fr,En}` | `matei_parabole_fr.mp4`, `matei_parabole_en_hook_1_short.mp4` | Shade the region where f(x) ≥ x² − 3x + 2 |

The maths, checked:

- **ppm** — 0.72 g/L ÷ 1000 g/L × 10⁶ = **720 ppm**, i.e. 720 mg/L. The step that
  carries the whole conversion is that one litre of a dilute aqueous solution weighs
  1000 g; the animation says that out loud rather than hiding it in a shortcut.
- **area** — (x+2)(x−2) = 21 → x² = 25 → x = ±5. x = −5 gives a side of −3 m and is
  rejected, so x = 5 and the dimensions are **7 m × 3 m**.
- **parabole** — boundary (x−1)(x−2), roots 1 and 2. `≥` means a solid boundary.
  Testing the origin: 0 ≥ 2 is false, so the origin is outside and the region is the
  one **on and above the curve**.

**A reading to confirm on the parabola creative.** `f(x) ≥ x² − 3x + 2` names `f`
without defining it. The animation treats f(x) as the height — that is, it shades
`y ≥ x² − 3x + 2` — and says so on screen at 0:02. If `f` was meant to be a second,
given function, this is the region between two curves instead and the beats change.

## Writing a creative

A creative is a list of `Beat(t, say, ops)`. `t` is the absolute start in seconds,
straight off the beat sheet, so the animation and the `.srt` can never drift apart.
`say` and any on-screen word take either a plain string (language-neutral maths) or
`{"fr": ..., "en": ...}`.

```python
"discriminant": {
    "title": "The discriminant",
    "tag": {"fr": "combien de solutions ?", "en": "how many solutions?"},
    "beats": [
        Beat(0.0, "", [line("x² − 6x + 9 = 0", key="q", size=60)]),
        Beat(2.0, {"en": "...", "fr": "..."}, [line("b² − 4ac", key="disc")]),
        Beat(12.0, {"en": "...", "fr": "..."},
             [line("0 solutions", key="wrong"), strike("wrong"),
              line("Δ = 0 → 1 solution", key="right")]),
        Beat(17.0, {"en": "...", "fr": "..."},
             [trap({"en": "Δ = 0 is one solution, not none",
                    "fr": "Δ = 0, c'est une solution, pas aucune"})]),
    ],
    "end": 24.0,
},
```

Then add the scene classes:

```python
DiscriminantFr = _build_scene("discriminant", "fr")
DiscriminantEn = _build_scene("discriminant", "en")
```

### Ops

| Op | Does |
| :--- | :--- |
| `line(text, key=…)` | Writes a new line of working under the previous one |
| `replace(key, text)` | Rewrites a line already on the paper, in place |
| `strike(key)` | Crosses a line out in red — this is the mistake |
| `circle(key, role=…)` | Rings a line. `role="mistake"` is red, `role="confirm"` is ink |
| `diagram(name, key=…)` | Draws a figure from `DIAGRAMS` |
| `diagram_step(key, step)` | Advances a figure already on screen |
| `trap(text)` | The signature beat. Raises if a creative fires it twice |
| `clear()` | Wipes the working, keeps the tag |
| `tag(text)` | The on-screen opener, top of frame |

Wrap any substring in `[[ ]]` to put just that part in red:
`line("2(x² − 6x + [[9]])")` reddens the nine and nothing else.

New figures go in `DIAGRAMS` as a function returning `(VGroup, steps)`, where `steps`
maps a step name to the mobjects `diagram_step` reveals; a `_hide_on_<step>` key lists
mobjects that step removes. Hide anything a step reveals with `_hide(...)` rather than
`set_opacity(0)`, so a translucent fill comes back at its own opacity instead of 1.
Two figures ship: `labelled_rect` and `parabola_region`.

Layout is fitted, not fixed: the renderer counts the lines and figures a creative uses
and tightens the line gap so the working always clears the trap card. A long creative
compresses instead of overlapping.

## Brand rules the code enforces

From the signature locked Mon Sep 7 in the pre-production doc — *white paper, black
pen, one accent colour used for exactly one thing, the mistake*:

- `RED` is only ever reachable through `strike`, `circle(role="mistake")`, `[[…]]`
  and the trap phrase. Nothing else in frame can be red.
- `trap()` raises if a creative fires it more than once. The signature works because
  it lands at one beat, not whenever it fits.
- `circle(role="confirm")` — the ring round a correct final answer — renders in **ink**,
  not red, because of `STRICT_RED_FOR_MISTAKES_ONLY = True`. Set it to `False` if you
  ever want a correct step ringed in red; the rest of the signature still holds.

## Where the content came from

The three problems are the ones the creatives in the shared `primoris` Drive folder
teach, given directly rather than transcribed. The video bytes could not be read from
here — the masters are 320–535 MB, `drive.google.com` is blocked by this environment's
egress policy, and the Drive connector only returns files inline as base64.

So the *spoken* lines below are written to the problems, not lifted off the audio. If
you want them to match the takes word for word, drop an audio-only export beside each
master (`ffmpeg -i matei_area_fr.mp4 -vn -ac 1 -b:a 32k matei_area_fr.m4a`, about 150 KB
for 30 seconds). That is small enough to come through the connector and the beats can be
rewritten from the real audio.
