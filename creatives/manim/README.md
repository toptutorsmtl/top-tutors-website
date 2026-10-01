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

| Scene | Source creative in Drive | Beat sheet |
| :--- | :--- | :--- |
| `Ppm{Fr,En}` | `matei_ppm_fr.mp4`, `matei_ppm_en.mp4` | R1 — factoring when a ≠ 1, produit-somme |
| `Parabole{Fr,En}` | `matei_parabole_fr.mp4`, `matei_parabole_en_hook_1_short.mp4` | R2 — completing the square, the vertex without the formula |
| `Area{Fr,En}` | `matei_area_fr.mp4` | R5 — the k² and k³ trap, similar figures |

Beat text, timings and on-screen working come from the beat sheets in
`PRIMORIS_Cycle02_PreProduction.md` (sections 4 and 10), matched to the filenames.
**The mapping is an inference, not something read off the videos** — see the note at
the bottom.

## Writing a creative

A creative is a list of `Beat(t, say, ops)`. `t` is the absolute start in seconds,
straight off the beat sheet, so the animation and the `.srt` can never drift apart.
`say` and any on-screen word take either a plain string (language-neutral maths) or
`{"fr": ..., "en": ...}`.

```python
"discriminant": {
    "title": "R3 - The discriminant",
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
maps a step name to the mobjects `diagram_step` reveals.

## Brand rules the code enforces

From the signature locked Mon Sep 7 in the pre-production doc — *white paper, black
pen, one accent colour used for exactly one thing, the mistake*:

- `RED` is only ever reachable through `strike`, `circle(role="mistake")`, `[[…]]`
  and the trap phrase. Nothing else in frame can be red.
- `trap()` raises if a creative fires it more than once. The signature works because
  it lands at one beat, not whenever it fits.
- **One deliberate deviation.** R1's beat sheet asks for a *correct* step — the
  matching bracket at 0:26 — to be circled in red, which contradicts the signature.
  `STRICT_RED_FOR_MISTAKES_ONLY = True` renders that ring in ink instead. Set it to
  `False` to follow the beat sheet literally.

## On the transcripts

These beats are the **scripts**, not transcripts pulled off the audio. The five masters
in the shared `primoris` Drive folder are 320–535 MB each, `drive.google.com` is blocked
by this environment's egress policy, and the Drive connector can only return a file
inline as base64 — so the video bytes could not be reached to transcribe.

What the beats reproduce is the beat-by-beat spoken line, on-screen working and timing
that the creatives were filmed from, recovered from `PRIMORIS_Cycle02_PreProduction.md`.
Where a take improvised away from the script, these will differ.

To replace them with real transcripts: drop an audio-only export beside each master in
the same folder (`ffmpeg -i matei_area_fr.mp4 -vn -ac 1 -b:a 32k matei_area_fr.m4a` —
about 150 KB for 30 seconds). That is small enough to come through the connector, and
the beats can then be regenerated from the actual audio.
