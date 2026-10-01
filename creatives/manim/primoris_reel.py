"""
PRIMORIS reel engine — one Manim animation that renders every trial-reel creative.

The engine is generic: a creative is a list of BEATS, each with an absolute start
time (matching the beat sheet in PRIMORIS_Cycle02_PreProduction.md), a spoken line
and a list of visual ops. Adding a fourth creative means adding an entry to
CREATIVES, not touching the engine.

Brand signature (locked Mon Sep 7, per the pre-production doc):
    white paper, black pen, one accent colour used for exactly one thing — the
    mistake. Nothing else in frame is ever red.
    Spoken signature: "Here's the trap." / FR: "Le piège est là."

Render (9:16, 1080x1920):
    manim -qh primoris_reel.py PpmFr
    manim -qh primoris_reel.py ParaboleEn
    manim -ql primoris_reel.py AreaFr        # fast preview

Scene names: Ppm{Fr,En} ParaboleFr/En Area{Fr,En}

No LaTeX required — all maths is Pango text with unicode glyphs, which also keeps
the glyph weight closer to pen-on-paper than a TeX render.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from manim import (
    BLACK,
    DOWN,
    LEFT,
    RIGHT,
    UP,
    Create,
    FadeIn,
    FadeOut,
    Line,
    Polygon,
    Rectangle,
    Scene,
    Text,
    VGroup,
    Write,
    config,
)

# ---------------------------------------------------------------------------
# Format + brand
# ---------------------------------------------------------------------------

config.pixel_width = 1080
config.pixel_height = 1920
config.frame_rate = 30
config.frame_height = 16.0
config.frame_width = 9.0

PAPER = "#F7F5F0"  # warm white, not pure white — reads as paper on phone screens
INK = "#1B1B1B"  # pen
RED = "#D7263D"  # the mistake. Only ever the mistake.
MUTED = "#8A857C"  # tags, rules, grid

FONT = "DejaVu Sans"  # drop a handwriting TTF in and change this line

# The beat sheet for R1 asks for a *correct* step to be circled in red (0:26,
# "same bracket both times"). That contradicts the locked signature, which
# reserves red for the mistake. With this True, confirmation marks render in ink
# and red stays exclusive to errors; set False to follow the beat sheet literally.
STRICT_RED_FOR_MISTAKES_ONLY = True

STACK_TOP = 4.6  # y of the first line of working
LINE_GAP = 1.28
MAX_W = 7.7  # keep every line inside the safe area
TAG_Y = 6.7
TRAP_Y = -6.0

TRAP_PHRASE = {"en": "Here's the trap.", "fr": "Le piège est là."}


def localize(value: Any, lang: str) -> Any:
    """Fields may be a plain string (language-neutral) or {"fr": ..., "en": ...}."""
    if isinstance(value, dict):
        return value.get(lang, value.get("en", ""))
    return value


def split_accent(raw: str) -> tuple[str, list[tuple[int, int]]]:
    """Pull [[...]] markers out of a line.

    "2(x² − 6x + [[9]])" -> ("2(x² − 6x + 9)", [(14, 15)])

    The marked spans are the mistake, and they are the only thing that may be red.
    """
    out, spans = [], []
    i, cursor = 0, 0
    while i < len(raw):
        if raw.startswith("[[", i):
            end = raw.find("]]", i + 2)
            if end == -1:
                out.append(raw[i:])
                break
            inner = raw[i + 2 : end]
            spans.append((cursor, cursor + len(inner)))
            out.append(inner)
            cursor += len(inner)
            i = end + 2
        else:
            out.append(raw[i])
            cursor += 1
            i += 1
    return "".join(out), spans


# ---------------------------------------------------------------------------
# Ops — the vocabulary a creative is written in
# ---------------------------------------------------------------------------


def tag(text, run_time=0.5):
    """Small topic label, top of frame. The 'on-screen opener'."""
    return {"op": "tag", "text": text, "run_time": run_time}


def line(text, key=None, run_time=0.8, red=False, size=54):
    """A new line of working, written under the previous one."""
    return {
        "op": "line",
        "text": text,
        "key": key,
        "run_time": run_time,
        "red": red,
        "size": size,
    }


def replace(key, text, run_time=0.6, red=False, size=54):
    """Rewrite a line already on the paper, in place."""
    return {
        "op": "replace",
        "key": key,
        "text": text,
        "run_time": run_time,
        "red": red,
        "size": size,
    }


def strike(key, run_time=0.5):
    """Cross a line out in red. This is the mistake."""
    return {"op": "strike", "key": key, "run_time": run_time}


def circle(key, run_time=0.6, role="mistake", part=None):
    """Ring a line. role='mistake' is red; role='confirm' respects the brand flag."""
    return {"op": "circle", "key": key, "run_time": run_time, "role": role, "part": part}


def diagram(name, key=None, run_time=1.0, **kwargs):
    """Draw a named figure from DIAGRAMS."""
    return {
        "op": "diagram",
        "name": name,
        "key": key,
        "run_time": run_time,
        "kwargs": kwargs,
    }


def diagram_step(key, step, run_time=1.0):
    """Advance a figure already on screen to its next stage."""
    return {"op": "diagram_step", "key": key, "step": step, "run_time": run_time}


def trap(text, run_time=0.6):
    """The signature beat. Fires once per creative."""
    return {"op": "trap", "text": text, "run_time": run_time}


def clear(run_time=0.5):
    """Wipe the working, keep the tag. Used when a creative changes subject."""
    return {"op": "clear", "run_time": run_time}


def _wrap(text: str, width: int) -> str:
    """Greedy wrap, so the trap line breaks instead of shrinking to a whisper."""
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if len(trial) > width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return "\n".join(lines)


@dataclass
class Beat:
    t: float  # absolute start, seconds, from the beat sheet
    say: Any = ""  # spoken line (str or {"fr","en"}) — exported to .srt
    ops: list = field(default_factory=list)


# ---------------------------------------------------------------------------
# Diagrams — the only creative-specific drawing code
# ---------------------------------------------------------------------------


def _rect(w, h, color=INK, width=4.0):
    return Rectangle(width=w, height=h, color=color, stroke_width=width)


def similar_rects(unit=0.95, k=2):
    """R5: a small rectangle and its k-scaled copy, with a grid that can be revealed.

    Returns (group, steps) where steps maps a step name to a list of mobjects to
    fade in — the engine reveals them one diagram_step at a time.
    """
    small = _rect(unit * 1.5, unit)
    big = _rect(unit * 1.5 * k, unit * k)
    small.next_to(big, LEFT, buff=0.7).align_to(big, DOWN)

    small_lbl = Text("1", font=FONT, font_size=34, color=MUTED).move_to(small)
    grid = VGroup()
    for i in range(1, k):
        grid.add(
            Line(
                big.get_corner(DOWN + LEFT) + RIGHT * (big.width * i / k),
                big.get_corner(UP + LEFT) + RIGHT * (big.width * i / k),
                color=MUTED,
                stroke_width=2.5,
            )
        )
        grid.add(
            Line(
                big.get_corner(DOWN + LEFT) + UP * (big.height * i / k),
                big.get_corner(DOWN + RIGHT) + UP * (big.height * i / k),
                color=MUTED,
                stroke_width=2.5,
            )
        )
    counts = VGroup()
    for row in range(k):
        for col in range(k):
            cell = Text(
                str(row * k + col + 1), font=FONT, font_size=30, color=MUTED
            )
            cell.move_to(
                big.get_corner(DOWN + LEFT)
                + RIGHT * big.width * (col + 0.5) / k
                + UP * big.height * (row + 0.5) / k
            )
            counts.add(cell)

    group = VGroup(small, small_lbl, big, grid, counts)
    group.set(width=MAX_W * 0.92)
    steps = {"grid": [grid], "count": [counts]}
    for m in list(grid) + list(counts):
        m.set_opacity(0)
    return group, steps


def _iso_cube(s, color=INK, width=3.5):
    """Flat isometric cube outline of side s."""
    dx, dy = s * 0.42, s * 0.26
    front = Polygon(
        [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], color=color, stroke_width=width
    )
    top = Polygon(
        [0, s, 0], [s, s, 0], [s + dx, s + dy, 0], [dx, s + dy, 0],
        color=color, stroke_width=width,
    )
    side = Polygon(
        [s, 0, 0], [s + dx, dy, 0], [s + dx, s + dy, 0], [s, s, 0],
        color=color, stroke_width=width,
    )
    return VGroup(front, top, side)


def cubes(unit=1.0, k=2):
    """R5: one cube beside a k-scaled cube, which splits into k**3 unit cubes.

    The split is drawn as division lines across the three visible faces rather
    than as k**3 stacked outlines — overlapping outlines read as a solid blob at
    phone size, division lines read as "eight".
    """
    one = _iso_cube(unit)
    s = unit * k
    big = _iso_cube(s, width=4.5)
    dx, dy = s * 0.42, s * 0.26

    cuts = VGroup()
    for i in range(1, k):
        f = s * i / k
        # front face
        cuts.add(Line([f, 0, 0], [f, s, 0], color=MUTED, stroke_width=2.5))
        cuts.add(Line([0, f, 0], [s, f, 0], color=MUTED, stroke_width=2.5))
        # top face
        cuts.add(
            Line([f, s, 0], [f + dx, s + dy, 0], color=MUTED, stroke_width=2.5)
        )
        cuts.add(
            Line(
                [dx * i / k, s + dy * i / k, 0],
                [s + dx * i / k, s + dy * i / k, 0],
                color=MUTED,
                stroke_width=2.5,
            )
        )
        # right face
        cuts.add(
            Line([s, f, 0], [s + dx, f + dy, 0], color=MUTED, stroke_width=2.5)
        )
        cuts.add(
            Line(
                [s + dx * i / k, dy * i / k, 0],
                [s + dx * i / k, s + dy * i / k, 0],
                color=MUTED,
                stroke_width=2.5,
            )
        )
    cuts.move_to(big, aligned_edge=DOWN + LEFT)

    one_lbl = Text("1", font=FONT, font_size=30, color=MUTED)
    eight_lbl = Text("8", font=FONT, font_size=40, color=MUTED)
    big_group = VGroup(big, cuts)
    one.next_to(big_group, LEFT, buff=0.9).align_to(big_group, DOWN)
    one_lbl.next_to(one, DOWN, buff=0.22)
    eight_lbl.next_to(big_group, DOWN, buff=0.22)

    group = VGroup(one, one_lbl, big_group, eight_lbl)
    group.set(width=MAX_W * 0.86)
    for m in list(cuts) + [eight_lbl]:
        m.set_opacity(0)
    return group, {"split": [cuts, eight_lbl]}


def parabola_touching(width=6.0):
    """R3 reference figure: a parabola sitting on the x-axis (used if you cut the
    discriminant creative). Kept here so the registry already covers it."""
    axis = Line(LEFT * width / 2, RIGHT * width / 2, color=MUTED, stroke_width=2.5)
    pts = []
    for i in range(61):
        x = -1.5 + 3.0 * i / 60
        pts.append([x * (width / 6), 0.55 * (x * x) * (width / 6), 0])
    curve = VGroup(
        *[
            Line(pts[i], pts[i + 1], color=INK, stroke_width=4.0)
            for i in range(len(pts) - 1)
        ]
    )
    group = VGroup(axis, curve)
    group.set(width=min(group.width, MAX_W))
    return group, {}


DIAGRAMS: dict[str, Callable[..., tuple[VGroup, dict]]] = {
    "similar_rects": similar_rects,
    "cubes": cubes,
    "parabola_touching": parabola_touching,
}


# ---------------------------------------------------------------------------
# The creatives
# ---------------------------------------------------------------------------

CREATIVES: dict[str, dict] = {
    # matei_ppm_fr.mp4 / matei_ppm_en.mp4  ->  R1, produit-somme factoring
    "ppm": {
        "title": "R1 - Factoring when a != 1 (produit-somme)",
        "tag": {"fr": "produit-somme", "en": "factor it properly"},
        "beats": [
            Beat(0.0, "", [line("6x² + 11x − 10", key="q", size=62)]),
            Beat(
                2.0,
                {
                    "en": "Most people go straight to two brackets and guess.",
                    "fr": "La plupart des gens écrivent deux parenthèses et devinent.",
                },
                [line("(6x    )(x    ) ?", key="guess"), strike("guess")],
            ),
            Beat(
                5.0,
                {
                    "en": "Don't guess. Multiply the ends.",
                    "fr": "Ne devine pas. Multiplie les extrêmes.",
                },
                [line("6 × (−10) = −60", key="ends")],
            ),
            Beat(
                9.0,
                {
                    "en": "Now find two numbers that multiply to negative sixty and add to eleven.",
                    "fr": "Trouve deux nombres qui donnent −60 en produit et 11 en somme.",
                },
                [line("× −60     + 11", key="ps", size=50)],
            ),
            Beat(
                13.0,
                {"en": "Fifteen and minus four.", "fr": "Quinze et moins quatre."},
                [line("15 ,  −4", key="pair")],
            ),
            Beat(
                16.0,
                {
                    "en": "Split the middle term. Don't touch anything else.",
                    "fr": "Décompose le terme du milieu. Ne touche à rien d'autre.",
                },
                [line("6x² + 15x − 4x − 10", key="split", size=50)],
            ),
            Beat(
                21.0,
                {
                    "en": "Group in pairs. Factor each pair.",
                    "fr": "Regroupe par paires. Factorise chaque paire.",
                },
                [line("3x(2x + 5) − 2(2x + 5)", key="group", size=50)],
            ),
            Beat(
                26.0,
                {
                    "en": "Same bracket both times. That's how you know it worked.",
                    "fr": "La même parenthèse deux fois. C'est la preuve que ça marche.",
                },
                [circle("group", role="confirm")],
            ),
            Beat(
                29.0,
                {
                    "en": "Here's the trap - if the brackets don't match, your two numbers were wrong, not your method.",
                    "fr": "Le piège est là — si les parenthèses ne sont pas identiques, ce sont tes deux nombres qui sont faux, pas ta méthode.",
                },
                [
                    trap(
                        {
                            "en": "brackets don't match → wrong numbers, not wrong method",
                            "fr": "parenthèses différentes → mauvais nombres, pas mauvaise méthode",
                        }
                    ),
                    line("(3x − 2)(2x + 5)", key="ans", size=58),
                ],
            ),
            Beat(33.0, "", []),
        ],
        "end": 35.0,
    },
    # matei_parabole_fr.mp4 / matei_parabole_en_hook_1_short.mp4
    #   ->  R2, completing the square, vertex of the parabola
    "parabole": {
        "title": "R2 - Completing the square, the vertex without the formula",
        "tag": {"fr": "sommet sans formule", "en": "vertex without the formula"},
        "beats": [
            Beat(0.0, "", [line("y = 2x² − 12x + 5", key="q", size=60)]),
            Beat(
                2.0,
                {
                    "en": "You want the vertex. You don't need the formula.",
                    "fr": "Tu veux le sommet. Tu n'as pas besoin de la formule.",
                },
                [line({"fr": "sommet = ?", "en": "vertex = ?"}, key="goal", size=48)],
            ),
            Beat(
                5.0,
                {
                    "en": "Pull the two out of the first two terms only.",
                    "fr": "Sors le deux des deux premiers termes seulement.",
                },
                [line("y = 2(x² − 6x) + 5", key="pull", size=52)],
            ),
            Beat(
                10.0,
                {
                    "en": "Half of six is three. Three squared is nine. Put it in.",
                    "fr": "La moitié de six, trois. Trois au carré, neuf. Mets-le dedans.",
                },
                [line("2(x² − 6x + [[9]])", key="add", size=52)],
            ),
            Beat(
                15.0,
                {
                    "en": "Here's the trap. You didn't add nine. You added two times nine.",
                    "fr": "Le piège est là. Tu n'as pas ajouté neuf. Tu as ajouté deux fois neuf.",
                },
                [
                    trap(
                        {
                            "en": "not +9 — you added 2 × 9",
                            "fr": "pas +9 — tu as ajouté 2 × 9",
                        }
                    ),
                    line("[[2 × 9 = 18]]", key="over", size=52),
                    circle("over", role="mistake"),
                ],
            ),
            Beat(
                20.0,
                {
                    "en": "So take eighteen back out.",
                    "fr": "Alors retire dix-huit.",
                },
                [line("y = 2(x − 3)² + 5 − 18", key="back", size=50)],
            ),
            Beat(
                25.0,
                {
                    "en": "Vertex, three and minus thirteen.",
                    "fr": "Sommet, trois et moins treize.",
                },
                [
                    line("y = 2(x − 3)² − 13", key="vf", size=52),
                    line("(3 , −13)", key="ans", size=60),
                ],
            ),
            Beat(29.0, "", []),
        ],
        "end": 31.0,
    },
    # matei_area_fr.mp4  ->  R5, the k^2 and k^3 trap
    "area": {
        "title": "R5 - The k² and k³ trap, similar figures",
        "tag": {"fr": "figures semblables", "en": "similar figures"},
        "beats": [
            Beat(0.0, "", [diagram("similar_rects", key="fig", run_time=1.4)]),
            Beat(
                2.0,
                {
                    "en": "The sides doubled. What happened to the area?",
                    "fr": "Les côtés ont doublé. Qu'est-ce qui arrive à l'aire ?",
                },
                [
                    line("k = 2", key="k", size=56),
                    line({"fr": "aire = ?", "en": "area = ?"}, key="goal", size=48),
                ],
            ),
            Beat(
                5.0,
                {
                    "en": "Most people say doubled.",
                    "fr": "La plupart des gens disent : elle double.",
                },
                [line("× 2", key="wrong", size=56), strike("wrong")],
            ),
            Beat(
                8.0,
                {"en": "Count the squares.", "fr": "Compte les carrés."},
                [diagram_step("fig", "grid", run_time=0.8)],
            ),
            Beat(
                10.0,
                "",
                [diagram_step("fig", "count", run_time=1.0)],
            ),
            Beat(
                12.0,
                {
                    "en": "Four times. The ratio squares.",
                    "fr": "Quatre fois. Le rapport est au carré.",
                },
                [line("k² = 4", key="k2", size=58)],
            ),
            Beat(
                16.0,
                {
                    "en": "And in three dimensions it cubes.",
                    "fr": "Et en trois dimensions, il est au cube.",
                },
                [
                    clear(run_time=0.4),
                    diagram("cubes", key="cube", run_time=1.1),
                    diagram_step("cube", "split", run_time=0.9),
                    line("k³ = 8", key="k3", size=58),
                ],
            ),
            Beat(
                21.0,
                {
                    "en": "Here's the trap. Sides scale by k. Areas by k squared. Volumes by k cubed. One ratio, three different jobs.",
                    "fr": "Le piège est là. Les côtés par k. Les aires par k au carré. Les volumes par k au cube. Un seul rapport, trois rôles différents.",
                },
                [
                    trap(
                        {
                            "en": "one ratio, three different jobs",
                            "fr": "un seul rapport, trois rôles différents",
                        }
                    ),
                    line("k  ·  k²  ·  k³", key="all", size=62),
                ],
            ),
            Beat(26.0, "", []),
        ],
        "end": 28.0,
    },
}


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class PrimorisReel(Scene):
    """Renders any entry in CREATIVES. Subclasses set CREATIVE and LANG."""

    CREATIVE = "ppm"
    LANG = "en"
    SHOW_SUBTITLES = False  # burn the spoken line in; off by default (editor adds them)

    def setup(self):
        self.camera.background_color = PAPER
        self.spec = CREATIVES[self.CREATIVE]
        self.lang = self.LANG
        self.keyed: dict[str, Any] = {}
        self.diagram_steps: dict[str, dict] = {}
        self.stack: list[Any] = []
        self.next_y = STACK_TOP
        self.trap_group = None
        self.subtitle = None
        self.clock = 0.0
        self._trap_fired = False

    # -- helpers ----------------------------------------------------------

    def _text(self, raw, size, red=False):
        body, spans = split_accent(localize(raw, self.lang))
        mob = Text(
            body,
            font=FONT,
            font_size=size,
            color=RED if red else INK,
            t2c={f"[{a}:{b}]": RED for a, b in spans},
        )
        if mob.width > MAX_W:
            mob.scale_to_fit_width(MAX_W)
        return mob

    def _place_next(self, mob):
        mob.move_to([0, self.next_y, 0])
        self.next_y -= LINE_GAP

    def _play(self, *anims, run_time=1.0):
        self.play(*anims, run_time=run_time)
        self.clock += run_time

    def _wait_until(self, t):
        gap = t - self.clock
        if gap > 1e-3:
            self.wait(gap)
            self.clock = t

    # -- ops --------------------------------------------------------------

    def _op_tag(self, op):
        # uppercase + muted, so it reads as a label and never as working
        mob = Text(
            localize(op["text"], self.lang).upper(),
            font=FONT,
            font_size=30,
            color=MUTED,
        )
        if mob.width > MAX_W:
            mob.scale_to_fit_width(MAX_W)
        mob.move_to([0, TAG_Y, 0])
        self._play(FadeIn(mob, shift=DOWN * 0.15), run_time=op["run_time"])
        self.keyed["__tag__"] = mob

    def _op_line(self, op):
        mob = self._text(op["text"], op["size"], op["red"])
        self._place_next(mob)
        if op["key"]:
            self.keyed[op["key"]] = mob
        self.stack.append(mob)
        self._play(Write(mob), run_time=op["run_time"])

    def _op_replace(self, op):
        old = self.keyed.get(op["key"])
        if old is None:
            return self._op_line(op)
        new = self._text(op["text"], op["size"], op["red"]).move_to(old)
        self.keyed[op["key"]] = new
        if old in self.stack:
            self.stack[self.stack.index(old)] = new
        self._play(FadeOut(old), Write(new), run_time=op["run_time"])

    def _op_strike(self, op):
        target = self.keyed.get(op["key"])
        if target is None:
            return
        stroke = Line(
            target.get_left() + LEFT * 0.12,
            target.get_right() + RIGHT * 0.12,
            color=RED,
            stroke_width=6.0,
        )
        self.stack.append(stroke)  # so clear() takes the mark with the line
        self._play(Create(stroke), run_time=op["run_time"])

    def _op_circle(self, op):
        target = self.keyed.get(op["key"])
        if target is None:
            return
        colour = RED
        if op["role"] == "confirm" and STRICT_RED_FOR_MISTAKES_ONLY:
            colour = INK
        ring = Rectangle(
            width=target.width + 0.45,
            height=target.height + 0.45,
            color=colour,
            stroke_width=5.0,
        )
        ring.round_corners(radius=0.35).move_to(target)
        self.stack.append(ring)
        self._play(Create(ring), run_time=op["run_time"])

    def _op_diagram(self, op):
        builder = DIAGRAMS[op["name"]]
        group, steps = builder(**op["kwargs"])
        group.move_to([0, self.next_y - group.height / 2 - 0.25, 0])
        self.next_y = group.get_bottom()[1] - 0.85
        key = op["key"] or op["name"]
        self.keyed[key] = group
        self.diagram_steps[key] = steps
        self.stack.append(group)
        self._play(Create(group), run_time=op["run_time"])

    def _op_diagram_step(self, op):
        steps = self.diagram_steps.get(op["key"], {})
        mobs = steps.get(op["step"], [])
        if not mobs:
            return
        self._play(
            *[m.animate.set_opacity(1) for m in mobs], run_time=op["run_time"]
        )

    def _op_trap(self, op):
        if self._trap_fired:
            raise ValueError(
                f"{self.CREATIVE}: the trap beat must fire exactly once per creative"
            )
        self._trap_fired = True
        phrase = Text(
            TRAP_PHRASE[self.lang], font=FONT, font_size=46, color=RED, weight="BOLD"
        )
        detail = Text(
            _wrap(localize(op["text"], self.lang), 34),
            font=FONT,
            font_size=34,
            color=INK,
            line_spacing=0.7,
        )
        if detail.width > MAX_W:
            detail.scale_to_fit_width(MAX_W)
        group = VGroup(phrase, detail).arrange(DOWN, buff=0.30)
        group.move_to([0, TRAP_Y, 0])
        self.trap_group = group
        self._play(FadeIn(group, shift=UP * 0.2), run_time=op["run_time"])

    def _op_clear(self, op):
        if not self.stack:
            return
        self._play(*[FadeOut(m) for m in self.stack], run_time=op["run_time"])
        self.stack = []
        self.keyed = {
            k: v for k, v in self.keyed.items() if k == "__tag__"
        }
        self.diagram_steps = {}
        self.next_y = STACK_TOP

    OPS = {
        "tag": _op_tag,
        "line": _op_line,
        "replace": _op_replace,
        "strike": _op_strike,
        "circle": _op_circle,
        "diagram": _op_diagram,
        "diagram_step": _op_diagram_step,
        "trap": _op_trap,
        "clear": _op_clear,
    }

    # -- main -------------------------------------------------------------

    def construct(self):
        self._op_tag(tag(self.spec["tag"], run_time=0.45))

        for beat in self.spec["beats"]:
            self._wait_until(beat.t)
            if self.SHOW_SUBTITLES:
                self._set_subtitle(beat.say)
            for op in beat.ops:
                self.OPS[op["op"]](self, op)

        self._wait_until(self.spec["end"])

    def _set_subtitle(self, say):
        text = localize(say, self.lang)
        if self.subtitle is not None:
            self.remove(self.subtitle)
            self.subtitle = None
        if not text:
            return
        mob = Text(text, font=FONT, font_size=28, color=MUTED)
        if mob.width > MAX_W:
            mob.scale_to_fit_width(MAX_W)
        mob.move_to([0, -7.2, 0])
        self.subtitle = mob
        self.add(mob)


# ---------------------------------------------------------------------------
# One scene class per creative x language, so the Manim CLI can find them
# ---------------------------------------------------------------------------


def _build_scene(creative: str, lang: str) -> type:
    name = f"{creative.capitalize()}{lang.capitalize()}"
    return type(name, (PrimorisReel,), {"CREATIVE": creative, "LANG": lang})


PpmFr = _build_scene("ppm", "fr")
PpmEn = _build_scene("ppm", "en")
ParaboleFr = _build_scene("parabole", "fr")
ParaboleEn = _build_scene("parabole", "en")
AreaFr = _build_scene("area", "fr")
AreaEn = _build_scene("area", "en")

__all__ = [
    "PrimorisReel",
    "CREATIVES",
    "DIAGRAMS",
    "PpmFr",
    "PpmEn",
    "ParaboleFr",
    "ParaboleEn",
    "AreaFr",
    "AreaEn",
]
