"""Dump every creative's spoken track as .srt (for the editor / VO booth) and as a
.md beat sheet, straight from the same BEATS the animation renders from.

    python3 export_scripts.py

Writes creatives/manim/scripts/<creative>_<lang>.srt and .md. Because both the
animation and these files come from CREATIVES, a timing change in the beat sheet
can never drift out of sync with the captions.
"""

from __future__ import annotations

from pathlib import Path

from primoris_reel import CREATIVES, TRAP_PHRASE, localize, split_accent

OUT = Path(__file__).parent / "scripts"
LANGS = ("fr", "en")


def stamp(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def spoken_beats(spec, lang):
    """(start, end, text) for every beat that actually has a line."""
    said = [(b.t, localize(b.say, lang)) for b in spec["beats"]]
    said = [(t, text) for t, text in said if text]
    out = []
    for i, (t, text) in enumerate(said):
        end = said[i + 1][0] if i + 1 < len(said) else spec["end"]
        out.append((t, min(end, spec["end"]), text))
    return out


def write_srt(spec, lang, path: Path):
    blocks = []
    for i, (start, end, text) in enumerate(spoken_beats(spec, lang), start=1):
        blocks.append(f"{i}\n{stamp(start)} --> {stamp(end)}\n{text}\n")
    path.write_text("\n".join(blocks), encoding="utf-8")


def write_md(spec, lang, name, path: Path):
    rows = [
        f"# {spec['title']}",
        "",
        f"Creative: `{name}` · language: `{lang}` · runtime: {spec['end']:.0f}s",
        f"On-screen opener: **{localize(spec['tag'], lang)}**",
        f"Signature line: **{TRAP_PHRASE[lang]}** (fires once)",
        "",
        "| Beat | Spoken | On screen |",
        "| ---: | :--- | :--- |",
    ]
    for b in spec["beats"]:
        mins, secs = divmod(int(b.t), 60)
        screen = []
        for op in b.ops:
            kind = op["op"]
            if kind in ("line", "replace"):
                body, spans = split_accent(localize(op["text"], lang))
                note = " (red: " + ", ".join(body[a:b] for a, b in spans) + ")" if spans else ""
                screen.append(f"`{body}`{note}")
            elif kind == "strike":
                screen.append(f"strike `{op['key']}` in red")
            elif kind == "circle":
                screen.append(f"ring `{op['key']}` ({op['role']})")
            elif kind == "diagram":
                screen.append(f"figure: {op['name']}")
            elif kind == "diagram_step":
                screen.append(f"figure step: {op['step']}")
            elif kind == "trap":
                screen.append(f"TRAP card — {localize(op['text'], lang)}")
            elif kind == "clear":
                screen.append("clear the paper")
        rows.append(
            f"| {mins}:{secs:02d} "
            f"| {localize(b.say, lang) or '*(no line)*'} "
            f"| {' · '.join(screen) or '*(hold)*'} |"
        )
    rows.append("")
    path.write_text("\n".join(rows), encoding="utf-8")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    written = []
    for name, spec in CREATIVES.items():
        for lang in LANGS:
            srt_path = OUT / f"{name}_{lang}.srt"
            md_path = OUT / f"{name}_{lang}.md"
            write_srt(spec, lang, srt_path)
            write_md(spec, lang, name, md_path)
            written += [srt_path, md_path]
    for p in written:
        print(p.relative_to(Path(__file__).parent.parent.parent))


if __name__ == "__main__":
    main()
