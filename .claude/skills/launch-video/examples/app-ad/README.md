# App ad example (8AM WORLD spec ad)

Not included, add your own:
- `assets/app.mp4`: a phone screen recording of the app (prepare it with `python3 ../../screen.py <recording> assets/app.mp4`,
  `--blur` any span that shows other people), then set each phone scene's `in` to the second its screen appears.
- the brand: `python3 ../../brand.py . <the app's website>` (context.dev) writes `assets/brand/` and the theme.
- the music: `assets/<song>` + its `.beats.json` (`python3 tools/music.py analyze`), with `music.start` set so a drop
  lands on the first phone shot. Or set `"music": {"synth": true}`.
Silent scenes have `dur`; the hook and outro are voiced.
