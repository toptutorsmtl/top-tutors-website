#!/usr/bin/env python3
"""Sound for launch videos: a synthesized SFX kit, a license-free music bed, and the final mix.

  python3 audio.py mix <project> [--from s --to s]   voice + music (ducked under the voice) + SFX cues -> out/mix.wav
  python3 audio.py sfx                               (re)build the SFX kit in assets/sfx/
  python3 audio.py bed out.wav --dur 45 --drop 9.2   just the music bed (drop = where the beat comes in)
  python3 audio.py drop <project> [--at 70.87] [--bars 1]   cut a real track so its drop lands on the hero scene

The plan's "music" picks the bed:
  "music": {"file": "assets/track.mp3", "start": 12.0, "gain": 0.35}   your own licensed track, from 12 s in
  "music": {"file": "assets/track.m4a", "segments": [[0, 9.3], [69.0, null]]}   an edit: intro, then jump to the drop
  "music": {"synth": true, "bpm": 112, "key": 0, "gain": 0.42}        the built-in bed (default)
  "music": false                                                      voice and SFX only
By default the synth bed's beat drops on the first hero/logo scene and thins out under the last scene.
render.mjs calls `mix` automatically; SFX cues come from the engine (out/cues.json) plus each scene's "sfx".
"""
import argparse, json, os, subprocess, sys, wave
import numpy as np
from scipy.signal import butter, sosfilt

SKILL = os.path.dirname(os.path.abspath(__file__))
SFX_DIR = os.path.join(SKILL, "assets", "sfx")
SR = 48000
rng = np.random.default_rng(11)


# ---------- dsp ----------
def t_(d):
    return np.arange(int(d * SR)) / SR


def bp(x, lo, hi, o=2):
    return sosfilt(butter(o, [lo, min(hi, SR / 2 - 200)], btype="band", fs=SR, output="sos"), x)


def lp(x, f, o=2):
    return sosfilt(butter(o, min(f, SR / 2 - 200), btype="low", fs=SR, output="sos"), x)


def hp(x, f, o=2):
    return sosfilt(butter(o, f, btype="high", fs=SR, output="sos"), x)


def norm(x, db=-1.0):
    return x / (np.abs(x).max() + 1e-9) * 10 ** (db / 20)


def stereo(x, p0=0.0, p1=0.0):
    p = np.linspace(p0, p1, len(x))
    return np.stack([x * np.cos((p + 1) * np.pi / 4), x * np.sin((p + 1) * np.pi / 4)], 1)


def env(n, a, shape=2.0):
    k = max(1, int(n * a)); e = np.ones(n)
    e[:k] = np.linspace(0, 1, k) ** shape; e[k:] = np.linspace(1, 0, n - k) ** shape
    return e


def swept(d, f0, f1, q=0.6, steps=40):
    n = int(d * SR); noise = rng.standard_normal(n + SR // 10); out = np.zeros(n)
    blk = n // steps + 1; win = np.hanning(blk * 2)
    for i in range(steps):
        fc = f0 * (f1 / f0) ** (i / max(steps - 1, 1)); s = max(0, i * blk - blk // 2)
        seg = bp(noise[s: s + blk * 2], max(fc * (1 - q / 2), 20), fc * (1 + q / 2))
        e = min(n, s + len(seg)); out[s:e] += seg[: e - s] * win[: e - s]
    return out


def read_audio(path, ch=2):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", str(ch), "-ar", str(SR), "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.float32).astype(np.float64).reshape(-1, ch)


def write_wav(path, x):
    x = x if x.ndim == 2 else x[:, None]
    with wave.open(path, "wb") as w:
        w.setnchannels(x.shape[1]); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


# ---------- sfx kit ----------
def whoosh(d=0.5, f0=300, f1=5000):
    n = int(d * SR)
    return stereo(norm(swept(d, f0, f1) * env(n, 0.6) + 0.4 * swept(d, f0 / 2, f1 / 3) * env(n, 0.55, 2.6), -4), -0.6, 0.6)


def swish(d=0.2):
    return stereo(norm(swept(d, 2500, 9000, 0.9, 14) * env(int(d * SR), 0.35), -6), 0.4, -0.4)


def riser(d=1.0):
    tt = t_(d); f = 160 * 12 ** (tt / d)
    x = swept(d, 300, 8000, 1.0) * (tt / d) ** 2.4 + np.sin(2 * np.pi * np.cumsum(f) / SR) * (tt / d) ** 3 * 0.3
    x[-480:] *= np.linspace(1, 0, 480)
    return stereo(norm(x, -4), -0.3, 0.3)


def boom(d=1.8):
    tt = t_(d); f = 32 + 48 * np.exp(-tt * 9)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 2.8)
    body = lp(rng.standard_normal(len(tt)), 700) * np.exp(-tt * 12) * 0.6
    return stereo(norm(np.tanh(1.4 * (sub + body)), -2))


def pop(d=0.09):
    tt = t_(d); f = 260 + 900 * np.exp(-tt * 70)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 55) + 0.25 * hp(rng.standard_normal(len(tt)), 3000) * np.exp(-tt * 400)
    return stereo(norm(x, -4))


def click(d=0.05):
    x = np.zeros(int(d * SR))
    for at, g in ((0.0, 1.0), (0.011, 0.55)):
        k = t_(0.008); s = int(at * SR)
        x[s: s + len(k)] += bp(rng.standard_normal(len(k)), 1800, 9000) * np.exp(-k * 700) * g
    return stereo(norm(x, -5))


def ding(d=0.9):
    tt = t_(d); x = np.zeros(len(tt))
    for at, f, g in ((0.0, 1318.5, 1.0), (0.085, 1975.5, 0.8)):
        s = int(at * SR); k = tt[: len(tt) - s]
        x[s:] += g * (np.sin(2 * np.pi * f * k) + 0.3 * np.sin(2 * np.pi * f * 2.76 * k) * np.exp(-k * 12)) * np.exp(-k * 6)
    return stereo(norm(x, -7))


def key(f=3200, body=180, d=0.045):
    tt = t_(d)
    x = bp(rng.standard_normal(len(tt)), f * 0.6, f * 2.2) * np.exp(-tt * 900) + np.sin(2 * np.pi * body * tt) * np.exp(-tt * 120) * 0.4
    return stereo(norm(x, -8))


KIT = {"whoosh": whoosh, "swish": swish, "riser": riser, "boom": boom, "pop": pop, "click": click, "ding": ding,
       "key1": lambda: key(3200, 180), "key2": lambda: key(2700, 160), "key3": lambda: key(3800, 210),
       "enter": lambda: key(2200, 120, 0.09)}


def build_kit(force=False):
    os.makedirs(SFX_DIR, exist_ok=True)
    for name, fn in KIT.items():
        p = os.path.join(SFX_DIR, name + ".wav")
        if force or not os.path.exists(p):
            write_wav(p, np.clip(fn(), -1, 1))


def load_sfx(name, cache={}):
    if name not in cache:
        p = os.path.join(SFX_DIR, name + ".wav")
        if not os.path.exists(p):
            if name in KIT:
                build_kit()
            else:
                print(f"unknown sfx '{name}' (kit: {', '.join(KIT)})", file=sys.stderr); cache[name] = None; return None
        cache[name] = read_audio(p)
    return cache[name]


# ---------- music bed ----------
def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def saw(f, tt):
    ph = (f * tt) % 1.0
    return 2 * ph - 1


def bed(dur, bpm=112, drop=None, outro=None, transpose=0):
    """i-VI-III-VII pads and a plucked arp; kick, clap, hats and sub come in at the drop; thins at the outro."""
    n = int(dur * SR); out = np.zeros((n, 2))
    beat = 60.0 / bpm; bar = beat * 4
    drop = drop if drop is not None else min(dur * 0.2, 8 * beat)
    outro = outro if outro is not None else dur
    first_bar = drop - np.ceil(drop / bar) * bar            # a downbeat lands exactly on the drop
    chords = [(45, [57, 60, 64]), (41, [57, 60, 65]), (48, [55, 60, 64]), (43, [55, 59, 62])]
    tt_all = np.arange(n) / SR

    # sidechain pump after the drop
    pump = np.ones(n)
    k = first_bar
    while k < dur:
        if drop - 0.01 <= k < outro:
            s = int(max(0, k) * SR); e = min(n, s + int(beat * SR))
            if e > s:
                pump[s:e] = 1 - 0.55 * np.exp(-np.arange(e - s) / SR / 0.11)
        k += beat

    b = 0
    t = first_bar
    while t < dur:
        root, notes = chords[b % 4]
        s0, s1 = int(max(0, t) * SR), min(n, int((t + bar) * SR))
        if s1 > s0:
            seg_t = tt_all[s0:s1] - t
            pad = sum(saw(midi(m + transpose) * (1 + det), seg_t) for m in notes for det in (-0.004, 0.0, 0.0045)) / 9
            post = t >= drop
            pad = lp(pad, 2400 if post else 900 + 900 * max(0, t / max(drop, 1e-3)))
            e = np.minimum(1, seg_t / 0.25) * np.minimum(1, (bar - seg_t) / 0.05)
            out[s0:s1] += stereo(pad * e * 0.22)
            if post and t < outro:                         # sub bass on the beat
                sub = np.sin(2 * np.pi * midi(root - 12 + transpose) * seg_t) * 0.35
                out[s0:s1] += stereo(lp(sub * e, 200))
            # arp: 8ths through the chord
            arp = [notes[0] + 12, notes[1] + 12, notes[2] + 12, notes[0] + 24, notes[2] + 12, notes[1] + 12, notes[0] + 12, notes[2]]
            for i, m in enumerate(arp):
                ts = t + i * beat / 2
                if ts < 0 or ts >= dur:
                    continue
                a = int(ts * SR); L = min(int(0.32 * SR), n - a)
                kk = np.arange(L) / SR
                f = midi(m + transpose)
                pl = (np.sin(2 * np.pi * f * kk) + 0.35 * saw(f, kk)) * np.exp(-kk * 11)
                g = 0.11 if t < drop else 0.13
                out[a:a + L] += stereo(lp(pl, 3500) * g, 0.35 * (1 if i % 2 else -1), 0.35 * (1 if i % 2 else -1))
            # drums
            if post and t < outro:
                for q in range(4):
                    a = int((t + q * beat) * SR)
                    if a >= n:
                        break
                    L = min(int(0.28 * SR), n - a); kk = np.arange(L) / SR
                    kick = np.sin(2 * np.pi * np.cumsum(45 + 95 * np.exp(-kk * 30)) / SR) * np.exp(-kk * 9)
                    out[a:a + L] += stereo(np.tanh(kick * 1.6) * 0.5)
                    h = int((t + q * beat + beat / 2) * SR)
                    if h < n:
                        Lh = min(int(0.05 * SR), n - h)
                        out[h:h + Lh] += stereo(hp(rng.standard_normal(Lh), 7000) * np.exp(-np.arange(Lh) / SR * 90) * 0.07, 0.3, 0.3)
                    if q in (1, 3) and b % 2 == 1:
                        Lc = min(int(0.18 * SR), n - a)
                        clap = bp(rng.standard_normal(Lc), 900, 5000) * np.exp(-np.arange(Lc) / SR * 22) * 0.16
                        out[a:a + Lc] += stereo(clap)
        t += bar; b += 1
    out *= pump[:, None]
    # reverb-ish tail: a couple of filtered echoes
    for dly, g in ((0.19, 0.18), (0.37, 0.09)):
        d = int(dly * SR); out[d:] += lp(out[:-d, 0], 3000)[:, None] * g
    fade = np.minimum(1, tt_all / 0.4) * np.minimum(1, (dur - tt_all) / 1.6)
    return norm(out * fade[:, None], -3)


# ---------- mix ----------
def mix(proj, t0=0.0, t1=None, no_music=False):
    """no_music: voice + SFX only -> out/mix-upload.wav (post that file and add the song in the app: IG/TikTok sounds)."""
    plan = json.load(open(os.path.join(proj, "plan.json")))
    if no_music:
        plan["music"] = False
    tl_path = os.path.join(proj, "timeline.json")
    tl = json.load(open(tl_path)) if os.path.exists(tl_path) else None
    dur = (t1 if t1 is not None else (tl["duration"] if tl else 30.0)) - t0
    n = int(dur * SR)
    m = plan.get("mix", {})
    out = np.zeros((n, 2))

    vo = np.zeros((n, 2))
    if tl and os.path.exists(os.path.join(proj, tl.get("vo", "vo/vo.wav"))):
        v = read_audio(os.path.join(proj, tl.get("vo", "vo/vo.wav")))[int(t0 * SR):]
        vo[: min(n, len(v))] = v[:n] * m.get("vo", 1.0)

    music = plan.get("music", {"synth": True})
    if music:
        if music.get("file"):
            x = read_audio(os.path.join(proj, music["file"]))
            if music.get("segments"):                 # music edit: [[from, to], [from, null]] joined on the beat
                parts, xf = [], int(0.04 * SR)
                for a, b in music["segments"]:
                    parts.append(x[int(a * SR): (int(b * SR) if b is not None else len(x))])
                y = parts[0]
                for p in parts[1:]:
                    k = min(xf, len(y), len(p)); r = np.linspace(0, 1, k)[:, None]
                    y = np.concatenate([y[:-k], y[-k:] * np.cos(r * np.pi / 2) + p[:k] * np.sin(r * np.pi / 2), p[k:]])
                x = y
            s = int((music.get("start", 0) if not music.get("segments") else 0) * SR + t0 * SR)
            x = x[s: s + n]
            mus = np.zeros((n, 2)); mus[: len(x)] = x
            tt = np.arange(n) / SR
            mus *= (np.minimum(1, tt / 0.3) * np.minimum(1, (dur - tt) / 1.5))[:, None]
        else:
            drop, outro = music.get("drop"), music.get("outro")
            if tl and drop is None:
                hits = [s["start"] for s, sc in zip(tl["scenes"], plan["scenes"]) if sc["type"] in ("hero", "logo")]
                drop = hits[0] if hits else None
            if tl and outro is None:
                outro = tl["scenes"][-1]["start"]
            full = bed(t0 + dur, music.get("bpm", 112), drop, outro, music.get("key", 0))
            mus = full[int(t0 * SR): int(t0 * SR) + n]
        # duck under the voice
        e = np.abs(vo[:, 0])
        win = int(0.03 * SR)
        e = np.convolve(e, np.ones(win) / win, "same")
        e = np.clip(e / (np.percentile(e[e > 1e-4], 90) + 1e-9 if (e > 1e-4).any() else 1), 0, 1)
        sm = np.zeros(n); g = 0.0
        a_up, a_dn = np.exp(-1 / (0.04 * SR)), np.exp(-1 / (0.35 * SR))
        for i in range(0, n, 64):                         # attack/release follower at 64-sample steps
            target = e[i]
            g = target + (g - target) * (a_up ** 64 if target > g else a_dn ** 64)
            sm[i:i + 64] = g
        duck = 1 - m.get("duck", 0.55) * sm
        out += mus[:n] * (music.get("gain", 0.42) * duck)[:, None]

    out += vo
    cues = []
    cp = os.path.join(proj, "out", "cues.json")
    if os.path.exists(cp):
        cues = json.load(open(cp))
    last = {}
    sg = m.get("sfx", 0.55)
    for c in cues:
        name = c["name"]
        if name.startswith("key") and c["t"] - last.get("key", -1) < 0.04:
            continue
        last["key" if name.startswith("key") else name] = c["t"]
        x = load_sfx(name)
        if x is None:
            continue
        s = int(c["t"] * SR)
        if s >= n:
            continue
        L = min(len(x), n - s)
        if s < 0:
            continue
        out[s:s + L] += x[:L] * c.get("gain", 0.5) * sg
    # soft limit
    peak = np.abs(out).max()
    if peak > 0.95:
        out = np.tanh(out / peak * 1.2) / np.tanh(1.2) * 0.95
    raw = os.path.join(proj, "out", ".mix_raw.wav")
    write_wav(raw, out)
    dst = os.path.join(proj, "out", "mix-upload.wav" if no_music else "mix.wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", raw, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", str(SR), dst], check=True)
    os.remove(raw)
    print(f"mix: {dur:.2f} s, {len(cues)} sfx cues -> {dst}")


def drop(proj, at=None, bars=1, scene_type="hero"):
    """Edit the plan's music so its drop lands on the first `scene_type` scene: intro from 0 up to a beat, then a
    jump to `bars` bars before the drop. The scene before the reveal gets a little extra hold so the splice is on
    the beat, then the timeline is rebuilt."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("vo", os.path.join(SKILL, "vo.py")); vo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(vo)
    pp = os.path.join(proj, "plan.json"); plan = json.load(open(pp))
    m = plan["music"]
    bj = os.path.join(proj, m.get("beats") or os.path.splitext(m["file"])[0] + ".beats.json")
    info = json.load(open(bj)); beats = info["beats"]; beat = info.get("beat") or float(np.median(np.diff(beats)))
    D = at if at is not None else info["drops"][0]["t"]
    run = bars * 4 * beat                                 # run-up kept before the drop
    target = next(i for i, sc in enumerate(plan["scenes"]) if sc["type"] == scene_type)
    for attempt in range(3):
        tl = json.load(open(os.path.join(proj, "timeline.json")))
        H = tl["scenes"][target]["start"]
        a = min([b for b in beats if b >= H - run - 0.01] or [H - run])
        pad = round(a + run - H, 3)
        if abs(pad) < 0.01:
            break
        prev = plan["scenes"][target - 1]
        prev["post"] = round(prev.get("post", (plan.get("vo") or {}).get("post", 0.28)) + pad, 3)
        json.dump(plan, open(pp, "w"), indent=1)
        vo.build(proj)
    m["segments"] = [[0, round(a, 3)], [round(D - run, 3), None]]
    json.dump(plan, open(pp, "w"), indent=1)
    vo.build(proj)                                        # re-snap cuts to the edited beat grid
    tl = json.load(open(os.path.join(proj, "timeline.json")))
    print(f"drop {D:.3f} s lands at {tl['scenes'][target]['start']:.3f} s on scene {target} ({scene_type}); "
          f"music = 0-{a:.2f} s, then {D - run:.2f} s onward")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    mx = sub.add_parser("mix"); mx.add_argument("project"); mx.add_argument("--from", dest="t0", type=float, default=0.0)
    mx.add_argument("--to", dest="t1", type=float)
    mx.add_argument("--no-music", action="store_true", help="voice + SFX only -> out/mix-upload.wav")
    sub.add_parser("sfx")
    bd = sub.add_parser("bed"); bd.add_argument("out"); bd.add_argument("--dur", type=float, default=40)
    bd.add_argument("--bpm", type=float, default=112); bd.add_argument("--drop", type=float); bd.add_argument("--key", type=int, default=0)
    dp = sub.add_parser("drop"); dp.add_argument("project"); dp.add_argument("--at", type=float)
    dp.add_argument("--bars", type=int, default=1); dp.add_argument("--scene", default="hero")
    a = ap.parse_args()
    if a.cmd == "drop":
        drop(os.path.abspath(a.project), a.at, a.bars, a.scene); return
    if a.cmd == "mix":
        mix(os.path.abspath(a.project), a.t0, a.t1, a.no_music)
    elif a.cmd == "sfx":
        build_kit(force=True); print("kit ->", SFX_DIR)
    else:
        write_wav(a.out, bed(a.dur, a.bpm, a.drop, None, a.key)); print(a.out)


if __name__ == "__main__":
    main()
