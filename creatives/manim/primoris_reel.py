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
TRAP_Y = -6.0          # the trap card floats up if the working runs long
TRAP_TOP = -4.5        # working must stay above this
DIAGRAM_RESERVE = 3.7  # vertical room a figure is assumed to want

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


def labelled_rect(width_label="x + 2", height_label="x − 2", area_label="A = 21 m²",
                  solved_width="7 m", solved_height="3 m"):
    """A rectangle carrying algebraic side labels, which can resolve to numbers.

    steps: 'answer' swaps the expressions for the solved dimensions.
    """
    box = _rect(4.2, 1.9)
    w_lbl = Text(width_label, font=FONT, font_size=40, color=INK)
    h_lbl = Text(height_label, font=FONT, font_size=40, color=INK)
    a_lbl = Text(area_label, font=FONT, font_size=38, color=MUTED)
    w_lbl.next_to(box, DOWN, buff=0.25)
    h_lbl.next_to(box, RIGHT, buff=0.3)
    a_lbl.move_to(box)

    w_ans = Text(solved_width, font=FONT, font_size=42, color=INK).move_to(w_lbl)
    h_ans = Text(solved_height, font=FONT, font_size=42, color=INK).move_to(h_lbl)

    group = VGroup(box, w_lbl, h_lbl, a_lbl, w_ans, h_ans)
    group.set(width=MAX_W * 0.9)
    _hide(w_ans, h_ans)
    return group, {"answer": [w_ans, h_ans], "_hide_on_answer": [w_lbl, h_lbl]}


def _hide(*mobs):
    """Hide a mobject for later reveal, remembering the opacity it wants back.

    set_opacity(1) would flatten a translucent fill, so the reveal has to restore
    the value the builder chose, not assume 1.
    """
    for m in mobs:
        m._reveal_opacity = m.get_fill_opacity() if m.get_fill_opacity() else 1.0
        m.set_opacity(0)


def parabola_region(a=1.0, b=-3.0, c=2.0, x_lo=-0.6, x_hi=3.6):
    """Axes + y = ax² + bx + c, with steps for the dashed/solid boundary, the
    test point at the origin, and the shaded solution region.

    Built from primitives rather than Axes.plot so nothing reaches for LaTeX.
    """
    sx, sy = 1.05, 0.42
    y_lo, y_hi = -1.2, 3.6

    def P(x, y):
        return [x * sx, y * sy, 0]

    def f(x):
        return a * x * x + b * x + c

    x_axis = Line(P(x_lo, 0), P(x_hi, 0), color=MUTED, stroke_width=2.5)
    y_axis = Line(P(0, y_lo), P(0, y_hi), color=MUTED, stroke_width=2.5)

    xs = [x_lo + (x_hi - x_lo) * i / 80 for i in range(81)]
    pts = [P(x, min(max(f(x), y_lo), y_hi)) for x in xs]
    solid = VGroup(
        *[
            Line(pts[i], pts[i + 1], color=INK, stroke_width=5.0)
            for i in range(len(pts) - 1)
        ]
    )
    # a dashed copy of the same curve: the wrong boundary for a non-strict inequality
    dashed = VGroup(
        *[
            Line(pts[i], pts[i + 1], color=INK, stroke_width=5.0)
            for i in range(0, len(pts) - 1)
            if (i // 3) % 2 == 0
        ]
    )

    roots = VGroup()
    for r, label in ((1, "1"), (2, "2")):
        dot = Rectangle(width=0.13, height=0.13, color=INK, stroke_width=0)
        dot.set_fill(INK, opacity=1).move_to(P(r, 0))
        txt = Text(label, font=FONT, font_size=28, color=MUTED)
        txt.next_to(dot, DOWN, buff=0.18)
        roots.add(dot, txt)

    origin_dot = Rectangle(width=0.17, height=0.17, color=RED, stroke_width=0)
    origin_dot.set_fill(RED, opacity=1).move_to(P(0, 0))
    origin_lbl = Text("(0 , 0)", font=FONT, font_size=26, color=RED)
    origin_lbl.next_to(origin_dot, LEFT, buff=0.22)
    test = VGroup(origin_dot, origin_lbl)

    # region on and above the curve
    shade_pts = [P(x, min(max(f(x), y_lo), y_hi)) for x in xs]
    shade = Polygon(
        *shade_pts, P(x_hi, y_hi), P(x_lo, y_hi), color=INK, stroke_width=0
    )
    shade.set_fill(INK, opacity=0.13)

    group = VGroup(shade, x_axis, y_axis, dashed, solid, roots, test)
    group.set(width=MAX_W * 0.88)
    _hide(shade, solid, test, *roots)
    return group, {
        "roots": [roots],
        "solid": [solid],
        "test": [test],
        "shade": [shade],
        "_hide_on_solid": [dashed],
    }


DIAGRAMS: dict[str, Callable[..., tuple[VGroup, dict]]] = {
    "labelled_rect": labelled_rect,
    "parabola_region": parabola_region,
}


# ---------------------------------------------------------------------------
# The creatives
# ---------------------------------------------------------------------------

CREATIVES: dict[str, dict] = {
    # matei_ppm_fr.mp4 / matei_ppm_en.mp4
    #   "Convert 0.72 g/L to ppm"
    "ppm": {
        "title": "Convert 0.72 g/L to ppm",
        "tag": {"fr": "conversion en ppm", "en": "convert to ppm"},
        "beats": [
            Beat(
                0.0,
                "",
                [
                    line(
                        {"fr": "0,72 g/L  →  ppm ?", "en": "0.72 g/L  →  ppm ?"},
                        key="q",
                        size=58,
                    )
                ],
            ),
            Beat(
                2.0,
                {
                    "en": "Most people see 'per million' and just multiply by ten to the six.",
                    "fr": "La plupart des gens voient « par million » et multiplient par dix puissance six.",
                },
                [
                    line(
                        {"fr": "0,72 × 10⁶ = 720 000", "en": "0.72 × 10⁶ = 720 000"},
                        key="wrong",
                        size=52,
                    ),
                    strike("wrong"),
                ],
            ),
            Beat(
                6.0,
                {
                    "en": "ppm is a mass ratio. You need the mass of the solution too.",
                    "fr": "Le ppm est un rapport de masses. Il te faut aussi la masse de la solution.",
                },
                [
                    line(
                        {
                            "fr": "ppm = m(soluté) / m(solution) × 10⁶",
                            "en": "ppm = m(solute) / m(solution) × 10⁶",
                        },
                        key="def",
                        size=42,
                    )
                ],
            ),
            Beat(
                11.0,
                {
                    "en": "One litre of water weighs a thousand grams. That's the piece nobody writes down.",
                    "fr": "Un litre d'eau pèse mille grammes. C'est le morceau que personne n'écrit.",
                },
                [
                    line(
                        {"fr": "1 L d'eau  =  1000 g", "en": "1 L of water  =  1000 g"},
                        key="dens",
                        size=48,
                    )
                ],
            ),
            Beat(
                16.0,
                {
                    "en": "Nought point seven two, over a thousand.",
                    "fr": "Zéro virgule sept deux, sur mille.",
                },
                [
                    line(
                        {
                            "fr": "0,72 / 1000 = 0,00072",
                            "en": "0.72 / 1000 = 0.00072",
                        },
                        key="ratio",
                        size=50,
                    )
                ],
            ),
            Beat(
                20.0,
                {
                    "en": "Times ten to the six. Seven hundred and twenty.",
                    "fr": "Fois dix puissance six. Sept cent vingt.",
                },
                [
                    line(
                        {
                            "fr": "0,00072 × 10⁶ = 720",
                            "en": "0.00072 × 10⁶ = 720",
                        },
                        key="ans",
                        size=54,
                    ),
                    circle("ans", role="confirm"),
                ],
            ),
            Beat(
                25.0,
                {
                    "en": "Here's the trap — ppm is milligrams per litre. Convert the grams, don't scale the litres.",
                    "fr": "Le piège est là — le ppm, c'est des milligrammes par litre. Convertis les grammes, ne touche pas aux litres.",
                },
                [
                    trap(
                        {
                            "en": "ppm = mg/L — so g/L × 1000, done",
                            "fr": "ppm = mg/L, donc g/L × 1000 suffit",
                        }
                    ),
                    line(
                        {
                            "fr": "720 ppm = 720 mg/L",
                            "en": "720 ppm = 720 mg/L",
                        },
                        key="same",
                        size=50,
                    ),
                ],
            ),
            Beat(30.0, "", []),
        ],
        "end": 32.0,
    },
    # matei_area_fr.mp4
    #   "Find the dimensions of the rectangle with sides x+2 and x-2 and area 21 m2"
    "area": {
        "title": "Find the dimensions — sides x + 2 and x − 2, area 21 m²",
        "tag": {"fr": "trouve les dimensions", "en": "find the dimensions"},
        "beats": [
            Beat(
                0.0,
                "",
                [
                    diagram(
                        "labelled_rect",
                        key="fig",
                        run_time=1.4,
                        area_label={"fr": "A = 21 m²", "en": "A = 21 m²"},
                    )
                ],
            ),
            Beat(
                3.0,
                {
                    "en": "Area is length times width. Write that down before anything else.",
                    "fr": "L'aire, c'est longueur fois largeur. Écris ça avant tout le reste.",
                },
                [line("(x + 2)(x − 2) = 21", key="eq", size=52)],
            ),
            Beat(
                7.0,
                {
                    "en": "That's a difference of squares. Don't expand it the long way.",
                    "fr": "C'est une différence de carrés. Ne développe pas terme par terme.",
                },
                [line("x² − 4 = 21", key="dos", size=52)],
            ),
            Beat(
                11.0,
                {"en": "So x squared is twenty-five.", "fr": "Donc x au carré vaut vingt-cinq."},
                [line("x² = 25", key="sq", size=54)],
            ),
            Beat(
                14.0,
                {
                    "en": "x is five. And minus five — a square root gives you both.",
                    "fr": "x vaut cinq. Et moins cinq — une racine carrée en donne deux.",
                },
                [line("x = ± 5", key="pm", size=54)],
            ),
            Beat(
                18.0,
                {
                    "en": "But minus five makes a side of minus three metres. A rectangle can't have that.",
                    "fr": "Mais moins cinq donne un côté de moins trois mètres. Un rectangle ne peut pas avoir ça.",
                },
                [
                    line(
                        {
                            "fr": "x = −5  →  côté = [[−3 m]]",
                            "en": "x = −5  →  side = [[−3 m]]",
                        },
                        key="bad",
                        size=46,
                    ),
                    strike("bad"),
                ],
            ),
            Beat(
                23.0,
                {"en": "So x is five.", "fr": "Donc x vaut cinq."},
                [
                    line("x = 5", key="x", size=54),
                    diagram_step("fig", "answer", run_time=0.8),
                ],
            ),
            Beat(
                27.0,
                {
                    "en": "Here's the trap — x is not the answer. They asked for the dimensions, not for x.",
                    "fr": "Le piège est là — x n'est pas la réponse. On demande les dimensions, pas x.",
                },
                [
                    trap(
                        {
                            "en": "x is not a side. Finish the question.",
                            "fr": "x n'est pas un côté. Termine la question.",
                        }
                    ),
                    line("7 m × 3 m = 21 m²", key="ans", size=52),
                    circle("ans", role="confirm"),
                ],
            ),
            Beat(32.0, "", []),
        ],
        "end": 34.0,
    },
    # matei_parabole_fr.mp4 / matei_parabole_en_hook_1_short.mp4
    #   "Shade the region where f(x) >= x^2 - 3x + 2"
    "parabole": {
        "title": "Shade the region where f(x) ≥ x² − 3x + 2",
        "tag": {"fr": "hachure la bonne région", "en": "shade the correct region"},
        "beats": [
            Beat(0.0, "", [line("f(x) ≥ x² − 3x + 2", key="q", size=54)]),
            Beat(
                2.0,
                {
                    "en": "f of x is the height, so this is every point on or above the curve.",
                    "fr": "f de x, c'est la hauteur : donc tous les points sur la courbe ou au-dessus.",
                },
                [line("y ≥ x² − 3x + 2", key="read", size=50)],
            ),
            Beat(
                6.0,
                {
                    "en": "Boundary first. Factor it to find where it crosses.",
                    "fr": "La frontière d'abord. Factorise pour trouver où elle coupe.",
                },
                [line("(x − 1)(x − 2) = 0", key="fac", size=48)],
            ),
            Beat(
                10.0,
                {"en": "One and two.", "fr": "Un et deux."},
                [
                    diagram("parabola_region", key="fig", run_time=1.4),
                    diagram_step("fig", "roots", run_time=0.6),
                ],
            ),
            Beat(
                14.0,
                {
                    "en": "Greater than or equal. The curve itself is in the region — solid, never dashed.",
                    "fr": "Plus grand ou égal. La courbe fait partie de la région — trait plein, jamais pointillé.",
                },
                [diagram_step("fig", "solid", run_time=0.8)],
            ),
            Beat(
                19.0,
                {
                    "en": "Now, which side? The symbol does not tell you. Test a point. Take the origin.",
                    "fr": "Maintenant, quel côté ? Le symbole ne te le dit pas. Teste un point. Prends l'origine.",
                },
                [
                    diagram_step("fig", "test", run_time=0.6),
                    line("0 ≥ 0² − 3(0) + 2", key="sub", size=44),
                ],
            ),
            Beat(
                24.0,
                {
                    "en": "Zero is not greater than two. False — so the origin is out, and you shade the other side.",
                    "fr": "Zéro n'est pas plus grand que deux. Faux — l'origine est exclue, tu hachures l'autre côté.",
                },
                [
                    line("[[0 ≥ 2]]", key="false", size=50),
                    strike("false"),
                    diagram_step("fig", "shade", run_time=1.0),
                ],
            ),
            Beat(
                29.0,
                {
                    "en": "Here's the trap — 'greater than' does not mean up the page. One test point settles it every time.",
                    "fr": "Le piège est là — « plus grand » ne veut pas dire vers le haut de la page. Un point test règle ça à tous les coups.",
                },
                [
                    trap(
                        {
                            "en": "the symbol picks no side — the test point does",
                            "fr": "le symbole ne choisit pas le côté — le point test, oui",
                        }
                    )
                ],
            ),
            Beat(33.0, "", []),
        ],
        "end": 35.0,
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
        self.line_gap = self._fit_line_gap()
        self.keyed: dict[str, Any] = {}
        self.diagram_steps: dict[str, dict] = {}
        self.stack: list[Any] = []
        self.next_y = STACK_TOP
        self.trap_group = None
        self.subtitle = None
        self.clock = 0.0
        self._trap_fired = False

    # -- layout -----------------------------------------------------------

    def _fit_line_gap(self):
        """Tighten the line gap so the longest creative still clears the trap card.

        A creative that outgrows the frame is a layout bug the renderer should
        absorb, not something the author has to count by hand. clear() resets the
        run, so only the deepest stretch between clears matters.
        """
        lines = diagrams = run_lines = run_diagrams = 0
        for beat in self.spec["beats"]:
            for op in beat.ops:
                if op["op"] == "clear":
                    run_lines = run_diagrams = 0
                elif op["op"] == "line":
                    run_lines += 1
                elif op["op"] == "diagram":
                    run_diagrams += 1
                lines = max(lines, run_lines)
                diagrams = max(diagrams, run_diagrams)
        usable = STACK_TOP - TRAP_TOP - DIAGRAM_RESERVE * diagrams
        return min(LINE_GAP, usable / max(lines, 1))

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
        self.next_y -= self.line_gap

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
        # figure labels may be bilingual too, same as any other on-screen word
        kwargs = {
            k: localize(v, self.lang) if isinstance(v, (str, dict)) else v
            for k, v in op["kwargs"].items()
        }
        group, steps = builder(**kwargs)
        group.move_to([0, self.next_y - group.height / 2 - 0.25, 0])
        self.next_y = group.get_bottom()[1] - 0.85
        key = op["key"] or op["name"]
        self.keyed[key] = group
        self.diagram_steps[key] = steps
        self.stack.append(group)
        self._play(Create(group), run_time=op["run_time"])

    def _op_diagram_step(self, op):
        steps = self.diagram_steps.get(op["key"], {})
        show = steps.get(op["step"], [])
        hide = steps.get(f"_hide_on_{op['step']}", [])
        if not show and not hide:
            return
        self._play(
            *[
                m.animate.set_opacity(getattr(m, "_reveal_opacity", 1.0))
                for m in show
            ],
            *[FadeOut(m) for m in hide],
            run_time=op["run_time"],
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
        y = min(TRAP_Y, self.next_y - group.height / 2 - 0.45)
        group.move_to([0, max(y, -7.4 + group.height / 2), 0])
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
