#!/usr/bin/env python3
"""Voiceover for a launch video: record it yourself, or generate it with Fish Audio, ElevenLabs or macOS say.

Every route ends the same way: one clip per utterance in <project>/vo/clips/, then `build` trims and levels the
clips, finds word timings and lays them out on the timeline (vo/vo.wav + timeline.json) that the engine syncs
every caption to. An utterance is one scene's "vo" line, or several scenes chained with "join": true.

  python3 vo.py script   <project>                     print the script the voice will read
  python3 vo.py record   <project> [--line N] [--device N]
                                                       teleprompter in this terminal, one line per take
  python3 vo.py devices                                list microphones (for --device)
  python3 vo.py import   <project> take.m4a            one take of the whole script, split into lines
  python3 vo.py fish     <project> --voice <id> [--model s2.1-pro-free] [--speed 1.0]
  python3 vo.py fish-voices "calm male narrator"       search Fish Audio's public voice library
  python3 vo.py eleven   <project> --voice <id> [--model eleven_multilingual_v2] [--speed 1.0]
  python3 vo.py eleven-voices                          voices your ElevenLabs key can use
  python3 vo.py say      <project> [--voice "Reed (English (US))"] [--rate 185]
                                                       free macOS voice, good for timing drafts
  python3 vo.py auphonic <project> [--denoise dynamic] [--amount 12] [--dry-run]
                                                       master recorded takes with Auphonic (leveler, noise
                                                       reduction, voice EQ, -16 LUFS); cutting always off
  python3 vo.py build    <project>                     redo alignment + timeline (after changing pre/post/dur)

Keys: FISH_API_KEY, ELEVENLABS_API_KEY and AUPHONIC_API_KEY from the environment or a .env file in the project or skill folder.
Generated clips are cached by (voice, text), so re-running after a script edit only regenerates changed lines.
"""
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tempfile, time, warnings, wave
from difflib import SequenceMatcher
import numpy as np

warnings.filterwarnings("ignore", category=RuntimeWarning)   # faster-whisper feature extractor noise
warnings.filterwarnings("ignore", message="urllib3 v2 only supports OpenSSL")

SKILL = os.path.dirname(os.path.abspath(__file__))
SR = 48000


# ---------- plan / script ----------
def load_plan(proj):
    with open(os.path.join(proj, "plan.json")) as f:
        return json.load(f)


def spoken_text(s, brand):
    """Plan markup -> the words that are said. Mirrors spoken() in engine/player.js."""
    s = s or ""
    s = re.sub(r"\{(?:[^}]*?\.\.)?([^}]*)\}", r"\1", s)          # {11..22} -> 22
    s = s.replace("@brand", brand).replace("[", "").replace("]", "").replace("|", " ")
    s = re.sub(r"(?<![\w])[*_]|[*_](?![\w])", "", s)
    return re.sub(r"\s+", " ", s).strip()


def utterances(plan):
    """[{scenes: [i...], text, say, words_per_scene}] in script order."""
    brand = (plan.get("brand") or {}).get("name", "")
    out = []
    for i, sc in enumerate(plan["scenes"]):
        text = spoken_text(sc.get("vo"), brand)
        if not text:
            continue
        say = spoken_text(sc.get("say"), brand) if sc.get("say") else text
        if sc.get("join") and out and out[-1]["scenes"][-1] == i - 1:
            u = out[-1]
            u["scenes"].append(i); u["text"] += " " + text; u["say"] += " " + say; u["n"].append(len(text.split()))
        else:
            out.append({"scenes": [i], "text": text, "say": say, "n": [len(text.split())]})
    for k, u in enumerate(out):
        u["id"] = k
    return out


def env_key(name, proj):
    if os.environ.get(name):
        return os.environ[name]
    for d in (proj, SKILL, os.getcwd()):
        p = os.path.join(d or ".", ".env")
        if os.path.exists(p):
            for line in open(p):
                m = re.match(rf"\s*{name}\s*=\s*(.+)\s*$", line)
                if m:
                    return m.group(1).strip().strip("'\"")
    sys.exit(f"{name} is not set. Put it in your environment or in {os.path.join(SKILL, '.env')} as {name}=...")


# ---------- audio io ----------
def read_audio(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.float32).astype(np.float64)


def write_wav(path, x, sr=SR):
    x = np.asarray(x)
    if x.ndim == 1:
        x = x[:, None]
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(pcm.shape[1]); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())


def to_wav(src, dst):
    write_wav(dst, read_audio(src))


def rms_db(x, win):
    n = len(x) // win
    if n == 0:
        return np.array([-120.0])
    r = np.sqrt((x[: n * win].reshape(n, win) ** 2).mean(1) + 1e-12)
    return 20 * np.log10(r)


def trim(x, thresh=-42.0, pad=0.04):
    win = int(0.01 * SR)
    db = rms_db(x, win)
    on = np.where(db > max(thresh, db.max() - 40))[0]
    if not len(on):
        return x, 0.0
    a = max(0, on[0] * win - int(pad * SR)); b = min(len(x), (on[-1] + 1) * win + int(pad * SR))
    return x[a:b], a / SR


def clean(x, nr=18):
    """Recorded voice: cut rumble below 80 Hz and room tone (afftdn, ~12-15 dB on a laptop mic; speech within 0.5 dB)."""
    with tempfile.TemporaryDirectory() as td:
        a, b = os.path.join(td, "a.wav"), os.path.join(td, "b.wav")
        write_wav(a, x)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", a, "-af", f"highpass=f=80,afftdn=nr={nr}:nf=-50:tn=0", b], check=True)
        return read_audio(b)


def fade(x, ms=12):
    n = min(len(x) // 2, int(ms / 1000 * SR))
    if n:
        x = x.copy(); r = np.linspace(0, 1, n)
        x[:n] *= r; x[-n:] *= r[::-1]
    return x


def level(x, target=-17.0):
    """Bring speech to a steady level: active-speech RMS -> target dBFS, soft-limit peaks."""
    db = rms_db(x, int(0.05 * SR))
    act = db[db > db.max() - 25]
    cur = np.percentile(act, 80) if len(act) else -30
    y = x * 10 ** ((target - cur) / 20)
    over = np.abs(y) > 0.89
    y[over] = np.sign(y[over]) * (0.89 + 0.1 * np.tanh((np.abs(y[over]) - 0.89) / 0.1))
    return y


# ---------- clip store ----------
def vo_dir(proj, *p):
    d = os.path.join(proj, "vo", *p)
    os.makedirs(d if not os.path.splitext(d)[1] else os.path.dirname(d), exist_ok=True)
    return d


def manifest_path(proj):
    return os.path.join(proj, "vo", "clips.json")


def load_manifest(proj):
    p = manifest_path(proj)
    return json.load(open(p)) if os.path.exists(p) else {}


def save_manifest(proj, m):
    vo_dir(proj)
    json.dump(m, open(manifest_path(proj), "w"), indent=1)


def put_clip(proj, u, src_wav, provider, voice, words=None):
    """Store a clip for utterance u. words (optional): [{w,s,e}] relative to the clip from the provider."""
    dst = os.path.join(vo_dir(proj, "clips"), f"u{u['id']:02d}.wav")
    shutil.copyfile(src_wav, dst)
    m = load_manifest(proj)
    m[str(u["id"])] = {"text": u["text"], "file": os.path.relpath(dst, proj), "provider": provider, "voice": voice,
                       "words": words}
    save_manifest(proj, m)


def cached(proj, key):
    h = hashlib.sha1(key.encode()).hexdigest()[:16]
    d = vo_dir(proj, "cache")
    return os.path.join(d, h + ".wav"), os.path.join(d, h + ".json")


# ---------- providers ----------
def gen_say(proj, args):
    plan = load_plan(proj)
    man = load_manifest(proj)
    for u in utterances(plan):
        if args.missing and str(u["id"]) in man and man[str(u["id"])]["text"] == u["text"]:
            continue                                      # keep the take that's already there
        wav, meta = cached(proj, f"say|{args.voice}|{args.rate}|{u['say']}")
        if not os.path.exists(wav):
            with tempfile.TemporaryDirectory() as td:
                aiff = os.path.join(td, "x.aiff")
                subprocess.run(["say", "-v", args.voice, "-r", str(args.rate), "-o", aiff, u["say"]], check=True)
                to_wav(aiff, wav)
        put_clip(proj, u, wav, "say", args.voice)
        print(f"  u{u['id']:02d}  {u['text']}")


def gen_fish(proj, args):
    import requests
    key = env_key("FISH_API_KEY", proj)
    plan = load_plan(proj)
    for u in utterances(plan):
        wav, _ = cached(proj, f"fish|{args.voice}|{args.model}|{args.speed}|{u['say']}")
        if not os.path.exists(wav):
            body = {"text": u["say"], "reference_id": args.voice, "format": "wav", "latency": "normal",
                    "chunk_length": 300, "normalize": True, "prosody": {"speed": args.speed}}
            r = requests.post("https://api.fish.audio/v1/tts", json=body, stream=True, timeout=180,
                              headers={"Authorization": f"Bearer {key}", "model": args.model})
            if r.status_code != 200:
                sys.exit(f"Fish Audio error {r.status_code}: {r.text[:300]}")
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                for chunk in r.iter_content(65536):
                    f.write(chunk)
            to_wav(f.name, wav); os.unlink(f.name)
        put_clip(proj, u, wav, "fish", args.voice)
        print(f"  u{u['id']:02d}  {u['text']}")


def fish_voices(args):
    import requests
    key = env_key("FISH_API_KEY", None)
    r = requests.get("https://api.fish.audio/model", timeout=60, headers={"Authorization": f"Bearer {key}"},
                     params={"title": args.query, "page_size": 15, "sort_by": "task_count", "language": args.lang})
    r.raise_for_status()
    for m in r.json().get("items", []):
        print(f"{m['_id']}  {m.get('title', '')[:50]:50}  uses {m.get('task_count', 0):>8}  {','.join(m.get('languages') or [])}")


def gen_eleven(proj, args):
    import base64, requests
    key = env_key("ELEVENLABS_API_KEY", proj)
    plan = load_plan(proj)
    us = utterances(plan)
    for k, u in enumerate(us):
        wav, meta = cached(proj, f"eleven|{args.voice}|{args.model}|{args.speed}|{u['say']}")
        if not os.path.exists(wav):
            body = {"text": u["say"], "model_id": args.model,
                    "voice_settings": {"stability": args.stability, "similarity_boost": 0.75, "style": 0.0,
                                       "use_speaker_boost": True, "speed": args.speed},
                    "previous_text": us[k - 1]["say"] if k else None,
                    "next_text": us[k + 1]["say"] if k + 1 < len(us) else None}
            r = requests.post(f"https://api.elevenlabs.io/v1/text-to-speech/{args.voice}/with-timestamps",
                              params={"output_format": "mp3_44100_128"}, json=body, timeout=180,
                              headers={"xi-api-key": key})
            if r.status_code != 200:
                sys.exit(f"ElevenLabs error {r.status_code}: {r.text[:300]}")
            d = r.json()
            with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
                f.write(base64.b64decode(d["audio_base64"]))
            to_wav(f.name, wav); os.unlink(f.name)
            a = d.get("alignment") or d.get("normalized_alignment")
            words = chars_to_words(a) if a else None
            json.dump(words, open(meta, "w"))
        words = json.load(open(meta)) if os.path.exists(meta) else None
        put_clip(proj, u, wav, "eleven", args.voice, words)
        print(f"  u{u['id']:02d}  {u['text']}")


def chars_to_words(a):
    words, cur = [], None
    for ch, s, e in zip(a["characters"], a["character_start_times_seconds"], a["character_end_times_seconds"]):
        if ch.isspace():
            if cur:
                words.append(cur); cur = None
            continue
        if cur is None:
            cur = {"w": ch, "s": s, "e": e}
        else:
            cur["w"] += ch; cur["e"] = e
    if cur:
        words.append(cur)
    return words


def eleven_voices(args):
    import requests
    key = env_key("ELEVENLABS_API_KEY", None)
    r = requests.get("https://api.elevenlabs.io/v2/voices", params={"page_size": 100}, timeout=60,
                     headers={"xi-api-key": key})
    r.raise_for_status()
    for v in r.json().get("voices", []):
        lab = v.get("labels") or {}
        print(f"{v['voice_id']}  {v.get('name', '')[:28]:28}  {v.get('category', ''):12}  "
              f"{' '.join(str(x) for x in (lab.get('gender'), lab.get('accent'), lab.get('description')) if x)}")


# ---------- recording ----------
# Captured with PortAudio (sounddevice). ffmpeg's avfoundation input drops ~1 in 8 audio packets on macOS
# (10 ms holes every ~90 ms), which sounds glitchy, so it is not used for recording.
VIRTUAL = ("teams", "zoom", "blackhole", "loopback", "soundflower", "virtual", "aggregate", "obs", "krisp")


def _sd():
    try:
        import sounddevice
        return sounddevice
    except ImportError:
        sys.exit("Recording needs the sounddevice package:  pip3 install sounddevice")


def mics():
    """[(index, name)] of audio inputs."""
    sd = _sd()
    return [(i, d["name"]) for i, d in enumerate(sd.query_devices()) if d["max_input_channels"] > 0]


def pick_mic(want=None):
    """--device as a number or part of a name; default: the built-in mic, skipping virtual inputs that record silence."""
    ms = mics()
    if not ms:
        sys.exit("No microphone found.")
    if want is not None:
        if str(want).lstrip(":").isdigit():
            i = int(str(want).lstrip(":"))
            hit = [m for m in ms if m[0] == i]
        else:
            hit = [m for m in ms if str(want).lower() in m[1].lower()]
        if not hit:
            sys.exit(f"No microphone matches {want!r}. Inputs: " + ", ".join(f"{i} {n}" for i, n in ms))
        return hit[0]
    real = [m for m in ms if not any(v in m[1].lower() for v in VIRTUAL)] or ms
    return next((m for m in real if "macbook" in m[1].lower() or "built-in" in m[1].lower()), real[0])


def devices(_args=None):
    for i, name in mics():
        print(f"  {i}  {name}")
    i, name = pick_mic()
    print(f"\ndefault: {i} ({name}). Use --device N or --device \"part of the name\" for another one.")


class Mic:
    """One input stream for the whole session. Opening and closing it for every line can freeze CoreAudio
    (stopping the stream deadlocks in AudioOutputUnitStop), so it opens once and each take just gates the samples."""

    def __init__(self, sd, dev):
        self.chunks, self.over, self.live = [], 0, False

        def cb(indata, frames, t, status):
            if self.live:
                if status.input_overflow:
                    self.over += 1
                self.chunks.append(indata[:, 0].copy())
        self.stream = sd.InputStream(device=dev, channels=1, samplerate=SR, dtype="float32", latency="high", callback=cb)
        self.stream.start()

    def capture(self, start_prompt, stop_prompt):
        """Keeps audio from Enter to Enter. Returns (mono float signal at SR, overflow count)."""
        self.chunks, self.over = [], 0
        input(start_prompt)
        self.live = True
        input(stop_prompt)
        self.live = False
        return (np.concatenate(self.chunks).astype(np.float64) if self.chunks else np.zeros(0)), self.over

    def close(self):
        """Abort the stream on a side thread; if CoreAudio hangs, give up after 2 s (the takes are already saved)."""
        import threading
        th = threading.Thread(target=lambda: (self.stream.abort(), self.stream.close()), daemon=True)
        th.start(); th.join(2)
        return not th.is_alive()


def record(proj, args):
    sd = _sd()
    plan = load_plan(proj)
    us = utterances(plan)
    todo = [u for u in us if args.line is None or u["id"] == args.line]
    if getattr(args, "missing", False):
        man = load_manifest(proj)
        todo = [u for u in todo if str(u["id"]) not in man or man[str(u["id"])]["text"] != u["text"]
                or man[str(u["id"])]["provider"] != "voice"]          # draft (say/TTS) lines still need your take
        if not todo:
            print("Every line already has a take. Use --line N to redo one."); build(proj); return
    B, D, R, X = "\033[1m", "\033[2m", "\033[31m", "\033[0m"
    dev, name = pick_mic(args.device)
    print(f"{D}mic: {name} (device {dev}); pick another with --device N (see `vo.py devices`){X}")
    print(f"\n{B}Recording {len(todo)} line(s).{X} Speak like you'd say it to a friend: short, warm, a little fast.")
    print(f"{D}Quiet room, phone mic or headset ~15 cm away. Each line is its own take, so pauses don't matter.{X}")
    mic = Mic(sd, dev)
    for u in todo:
        while True:
            print(f"\n{D}line {u['id']} of {len(us) - 1}{X}\n\n    {B}{u['text']}{X}\n")
            x, over = mic.capture(f"{D}Enter = start{X} ", f"{R}● recording{X} {D}Enter = stop{X} ")
            peak = 20 * np.log10(np.abs(x).max() + 1e-12) if len(x) else -120
            if len(x) < SR * 0.3 or peak < -45:
                print(f"Nothing usable came in (peak {peak:.0f} dB). Check this terminal's microphone permission "
                      "(System Settings > Privacy & Security > Microphone) or pick another mic with --device.")
                continue
            x, _ = trim(x)
            note = f"  {D}{len(x) / SR:.1f} s · peak {peak:.0f} dB{X}"
            if peak > -1:
                note += "  (clipping: move back a little)"
            elif peak < -30:
                note += "  (quiet: move closer)"
            if over:
                note += f"  ({over} dropout(s): retake)"
            print(note)
            with tempfile.TemporaryDirectory() as td:
                out = os.path.join(td, "t.wav"); write_wav(out, x)
                while True:
                    a = input(f"{D}Enter = keep · r = retake · p = play{X} ").strip().lower()
                    if a == "p":
                        subprocess.run(["afplay", out]); continue
                    break
                if a == "r":
                    continue
                take = os.path.join(vo_dir(proj, "takes"), f"u{u['id']:02d}.wav")
                shutil.copyfile(out, take)
                put_clip(proj, u, take, "voice", "you")
                break
    closed = mic.close()
    print(f"\n{B}Done.{X} Building the timeline…")
    build(proj)
    if not closed:
        os._exit(0)   # the audio driver is stuck closing the mic; everything is saved, so leave without waiting on it


def import_take(proj, args):
    """One recording of the whole script -> one clip per utterance, cut at the gaps between utterances."""
    plan = load_plan(proj)
    us = utterances(plan)
    x = read_audio(args.file)
    words = transcribe(x)
    script = [(u["id"], w) for u in us for w in u["text"].split()]
    times = align([w for _, w in script], words, 0, len(x) / SR)
    take = os.path.join(vo_dir(proj, "takes"), "import.wav"); write_wav(take, x)
    k = 0
    bounds = []
    for u in us:
        n = len(u["text"].split())
        bounds.append((times[k]["s"], times[k + n - 1]["e"])); k += n
    for i, u in enumerate(us):
        a = bounds[i][0] - 0.12 if i == 0 else (bounds[i - 1][1] + bounds[i][0]) / 2
        b = bounds[i][1] + 0.15 if i == len(us) - 1 else (bounds[i][1] + bounds[i + 1][0]) / 2
        seg = x[max(0, int(a * SR)): int(b * SR)]
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            write_wav(f.name, seg)
        put_clip(proj, u, f.name, "voice", os.path.basename(args.file)); os.unlink(f.name)
        print(f"  u{u['id']:02d}  {a:6.2f}-{b:6.2f}  {u['text']}")
    build(proj)


# ---------- Auphonic (optional cloud mastering for recorded takes) ----------
# All takes go up as ONE production (gaps of silence between them), so the leveler and noise profile hear the whole
# read and you're billed once (Auphonic bills per production, 3 min minimum; free plan = 2 h/month). The result is
# aligned back to the input by cross-correlation and cut into the same takes, so nothing moves on the timeline.
AUPHONIC = "https://auphonic.com/api"


def file_sha(path):
    return hashlib.sha1(open(path, "rb").read()).hexdigest()[:16]


def auphonic_algorithms(plan, args):
    alg = {"leveler": True, "normloudness": True, "loudnesstarget": -16, "maxpeak": -1,
           "filtering": True, "filtermethod": args.eq,
           "denoise": args.denoise != "off", "denoisemethod": "classic" if args.denoise == "off" else args.denoise,
           "denoiseamount": args.amount,
           # cutting must stay off: the timeline needs every take at its original length
           "cutter": False, "silence_cutter": False, "filler_cutter": False, "cough_cutter": False, "music_cutter": False}
    alg.update(((plan.get("vo") or {}).get("auphonic") or {}))
    return alg


def _env(x, w):
    n = len(x) // w
    return np.log10(np.sqrt((x[: n * w].reshape(n, w) ** 2).mean(1)) + 1e-4)


def find_offset(inp, out):
    """Where inp starts inside out (samples). Coarse 10 ms envelope match, then 1 ms refinement."""
    def best(a, b, lo, hi):
        a = a - a.mean(); scores = []
        for L in range(lo, hi + 1):
            seg = b[L: L + len(a)]
            if len(seg) < len(a):
                break
            seg = seg - seg.mean()
            scores.append((float((a * seg).sum() / (np.linalg.norm(a) * np.linalg.norm(seg) + 1e-9)), L))
        return max(scores) if scores else (0.0, lo)
    c = int(0.01 * SR)
    a, b = _env(inp, c), _env(out, c)
    score, L = best(a, b, 0, max(0, len(b) - len(a)))
    f = int(0.001 * SR)
    a, b = _env(inp, f), _env(out, f)
    score, Lf = best(a, b, max(0, L * 10 - 20), L * 10 + 20)
    return Lf * f, score


def gen_auphonic(proj, args):
    import requests
    plan = load_plan(proj)
    us = utterances(plan)
    man = load_manifest(proj)
    todo = [u for u in us if str(u["id"]) in man and (args.all or man[str(u["id"])]["provider"] == "voice")]
    if not todo:
        sys.exit("No recorded takes to enhance (record or import first; --all also sends TTS clips).")
    gap = int(0.8 * SR)
    xs = [read_audio(os.path.join(proj, man[str(u["id"])]["file"])) for u in todo]
    pos, t = [], gap
    for x in xs:
        pos.append(t); t += len(x) + gap
    inp = np.zeros(t)
    for p0, x in zip(pos, xs):
        inp[p0: p0 + len(x)] = x
    alg = auphonic_algorithms(plan, args)
    d = vo_dir(proj, "auphonic")
    src = os.path.join(d, "input.wav"); write_wav(src, inp)
    key = hashlib.sha1(open(src, "rb").read() + json.dumps(alg, sort_keys=True).encode()).hexdigest()[:16]
    res = os.path.join(d, f"{key}.wav")
    secs = len(inp) / SR
    print(f"{len(todo)} take(s), {secs:.1f} s in one production (billed as {max(3.0, secs / 60):.1f} min)")
    if args.dry_run:
        print(json.dumps({"output_files": [{"format": "wav"}], "algorithms": alg}, indent=1))
        print(f"input written to {src}; nothing sent")
        return
    if os.path.exists(res):
        print("already enhanced with these takes and settings: reusing", os.path.relpath(res, proj))
    else:
        api_key = env_key("AUPHONIC_API_KEY", proj)
        H = {"Authorization": f"bearer {api_key}"}

        def data(r):
            try:
                b = r.json()
            except ValueError:
                sys.exit(f"Auphonic error {r.status_code}: {r.text[:300]}")
            if r.status_code >= 400 or b.get("status_code", 200) >= 400:
                sys.exit(f"Auphonic error {r.status_code}: {b.get('error_message') or b.get('form_errors') or r.text[:300]}")
            return b["data"]
        body = {"metadata": {"title": f"{plan.get('name') or os.path.basename(proj)} voiceover"},
                "output_files": [{"format": "wav"}], "algorithms": alg}
        uuid = data(requests.post(f"{AUPHONIC}/productions.json", json=body, headers=H, timeout=60))["uuid"]
        print(f"production {uuid}: uploading…")
        with open(src, "rb") as f:
            data(requests.post(f"{AUPHONIC}/production/{uuid}/upload.json", headers=H, files={"input_file": f}, timeout=600))
        data(requests.post(f"{AUPHONIC}/production/{uuid}/start.json", headers=H, timeout=60))
        last = None
        while True:
            st = data(requests.get(f"{AUPHONIC}/production/{uuid}/status.json", headers=H, timeout=30))
            code, name = st.get("status"), st.get("status_string", "")
            if name != last:
                print(f"  {name or code}"); last = name
            if code == 3:
                break
            if code in (2, 9, 11):
                prod = data(requests.get(f"{AUPHONIC}/production/{uuid}.json", headers=H, timeout=30))
                sys.exit(f"Auphonic production failed: {prod.get('error_message') or name}")
            time.sleep(4)
        prod = data(requests.get(f"{AUPHONIC}/production/{uuid}.json", headers=H, timeout=30))
        wav = next((o for o in prod.get("output_files", []) if o.get("format") == "wav"), None)
        if not wav or not wav.get("download_url"):
            sys.exit("Auphonic finished but returned no WAV output")
        with requests.get(wav["download_url"], params={"bearer_token": api_key}, stream=True, timeout=300) as r:
            r.raise_for_status()
            with open(res + ".part", "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
        os.replace(res + ".part", res)
        used = prod.get("used_credits")
        try:
            left = data(requests.get(f"{AUPHONIC}/user.json", headers=H, timeout=30)).get("credits")
        except SystemExit:
            left = None
        print(f"done: used {used} h of credits" + (f", {left:.2f} h left" if isinstance(left, (int, float)) else ""))
    out = read_audio(res)
    off, score = find_offset(inp, out)
    extra = len(out) - len(inp)
    if extra < -int(0.1 * SR):
        sys.exit(f"Auphonic returned {-extra / SR:.2f} s LESS audio than sent (something was cut): not using it")
    if score < 0.6:
        sys.exit(f"could not line the result up with the takes (match {score:.2f}): not using it")
    if extra > int(0.2 * SR):
        print(f"note: the result is {extra / SR:.1f} s longer than the input (Auphonic adds a jingle on the free plan); "
              f"only the takes are used, found at +{off / SR:.2f} s")
    os.makedirs(os.path.join(proj, "vo", "enhanced"), exist_ok=True)
    man = load_manifest(proj)
    for u, p0, x in zip(todo, pos, xs):
        seg = out[off + p0: off + p0 + len(x)]
        e = os.path.join(proj, "vo", "enhanced", f"u{u['id']:02d}.wav"); write_wav(e, seg)
        m = man[str(u["id"])]
        m["enhanced"] = os.path.relpath(e, proj); m["enhanced_from"] = file_sha(os.path.join(proj, m["file"]))
    save_manifest(proj, man)
    print(f"enhanced {len(todo)} take(s) (alignment match {score:.2f}) -> vo/enhanced/")


# ---------- alignment ----------
_model = None


def transcribe(x):
    """faster-whisper word timings for a mono 48 kHz signal; [] if faster-whisper isn't installed."""
    global _model
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return []
    if _model is None:
        _model = WhisperModel(os.environ.get("WHISPER_MODEL", "small.en"), device="cpu", compute_type="int8")
    with tempfile.TemporaryDirectory() as td:
        p = os.path.join(td, "a.wav")
        y = x[:: 3]                                        # 48k -> 16k
        write_wav(p, y, 16000)
        segs, _ = _model.transcribe(p, word_timestamps=True, vad_filter=False, language="en")
        return [{"w": w.word.strip(), "s": w.start, "e": w.end} for s in segs for w in s.words]


def norm(w):
    return re.sub(r"[^a-z0-9%$]", "", w.lower())


def align(script_words, heard, t0, t1):
    """Script word list -> [{w,s,e}] using heard word timings; unmatched words are interpolated."""
    a = [norm(w) for w in script_words]
    b = [norm(h["w"]) for h in heard]
    out = [None] * len(a)
    for blk in SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
        for k in range(blk.size):
            h = heard[blk.b + k]
            out[blk.a + k] = {"w": script_words[blk.a + k], "s": h["s"], "e": h["e"]}
    # replaced runs: spread the heard span over the script words (e.g. "twenty two" vs "22")
    known = [i for i, o in enumerate(out) if o]
    for i in range(len(out)):
        if out[i]:
            continue
        p = max([k for k in known if k < i], default=None)
        n = min([k for k in known if k > i], default=None)
        ps = out[p]["e"] if p is not None else (heard[0]["s"] if heard else t0)
        ns = out[n]["s"] if n is not None else (heard[-1]["e"] if heard else t1)
        lo = p if p is not None else -1
        hi = n if n is not None else len(out)
        f0, f1 = (i - lo - 1) / (hi - lo - 1), (i - lo) / (hi - lo - 1)
        out[i] = {"w": script_words[i], "s": ps + (ns - ps) * f0, "e": ps + (ns - ps) * f1, "guess": True}
    # the recogniser sometimes stamps two quick words with one start ("and I'll"): keep each one a beat after the last
    for i in range(1, len(out)):
        if out[i]["s"] < out[i - 1]["s"] + 0.07:
            out[i]["s"] = out[i - 1]["s"] + 0.07
            out[i]["e"] = max(out[i]["e"], out[i]["s"] + 0.05)
    return out


def proportional(script_words, x):
    """No recogniser: spread words over the voiced part of the clip by length."""
    win = int(0.01 * SR)
    db = rms_db(x, win)
    on = np.where(db > db.max() - 30)[0]
    a, b = (on[0] * win / SR, (on[-1] + 1) * win / SR) if len(on) else (0, len(x) / SR)
    L = np.array([len(w) + 2 for w in script_words], float)
    edges = a + (b - a) * np.concatenate([[0], np.cumsum(L) / L.sum()])
    return [{"w": w, "s": edges[i], "e": edges[i + 1] - 0.02, "guess": True} for i, w in enumerate(script_words)]


def music_beats(proj, plan):
    """Beat times of the plan's music as heard in the video (after start offset and segment edits)."""
    m = plan.get("music") or {}
    if not m.get("file"):
        return []
    bj = os.path.join(proj, m.get("beats") or os.path.splitext(m["file"])[0] + ".beats.json")
    if not os.path.exists(bj):
        print(f"no beat map at {bj} (make one with tools/music.py analyze); not snapping")
        return []
    src = json.load(open(bj))["beats"]
    segs = m.get("segments") or [[m.get("start", 0), None]]
    out, o = [], 0.0
    for a, b in segs:
        b = b if b is not None else 1e9
        out += [t - a + o for t in src if a <= t < b]
        o += b - a if b < 1e9 else 0
    return sorted(out)


# ---------- build ----------
def build(proj, _args=None):
    plan = load_plan(proj)
    us = utterances(plan)
    man = load_manifest(proj)
    missing = [u["id"] for u in us if str(u["id"]) not in man or man[str(u["id"])]["text"] != u["text"]]
    if missing:
        sys.exit(f"no clip (or an outdated one) for line(s) {missing}: re-run record/fish/eleven/say first")
    cfg = plan.get("vo") or {}
    clips = {}
    for u in us:
        m = man[str(u["id"])]
        enh = m.get("enhanced") and os.path.exists(os.path.join(proj, m["enhanced"])) and \
            m.get("enhanced_from") == file_sha(os.path.join(proj, m["file"]))
        if enh:                                           # Auphonic master of this exact take
            x = read_audio(os.path.join(proj, m["enhanced"]))
        else:
            x = read_audio(os.path.join(proj, m["file"]))
            if m.get("enhanced"):
                print(f"  u{u['id']:02d} was re-recorded after enhancing: run `vo.py auphonic` again")
            if m["provider"] == "voice" and cfg.get("denoise", True):
                x = clean(x, cfg.get("denoise_db", 18))
        x, cut = trim(x)
        x = fade(level(x, cfg.get("level", -17.0)))
        words = m.get("words")
        script = u["text"].split()
        if words:
            words = align(script, [{"w": w["w"], "s": w["s"] - cut, "e": w["e"] - cut} for w in words], 0, len(x) / SR)
        else:
            heard = transcribe(x)
            words = align(script, heard, 0, len(x) / SR) if heard else proportional(script, x)
        clips[u["id"]] = (x, words)
        flag = " (estimated timings: pip install faster-whisper for exact ones)" if all(w.get("guess") for w in words) else ""
        print(f"  u{u['id']:02d} {len(x) / SR:5.2f} s  {u['text'][:64]}{flag}")

    by_scene = {i: u for u in us for i in u["scenes"]}
    t = cfg.get("lead", 0.3)
    scenes, placed = [None] * len(plan["scenes"]), []
    i = 0
    while i < len(plan["scenes"]):
        sc = plan["scenes"][i]
        if i not in by_scene:                             # visual-only beat
            d = sc.get("dur", 1.2)
            scenes[i] = {"start": t, "end": t + d, "vo_start": t, "vo_end": t, "words": []}
            t += d; i += 1
            continue
        u = by_scene[i]
        x, words = clips[u["id"]]
        start = t
        a = start + sc.get("pre", cfg.get("pre", 0.12))
        placed.append((a, x))
        absw = [{"w": w["w"], "s": round(a + w["s"], 3), "e": round(a + w["e"], 3)} for w in words]
        k = 0
        bounds = []
        for j, n in zip(u["scenes"], u["n"]):
            ws = absw[k: k + n]; k += n
            bounds.append(ws)
        end_audio = a + len(x) / SR
        last = plan["scenes"][u["scenes"][-1]]
        t_end = end_audio + last.get("post", cfg.get("post", 0.28))
        for q, j in enumerate(u["scenes"]):
            ws = bounds[q]
            s0 = start if q == 0 else (bounds[q - 1][-1]["e"] + ws[0]["s"]) / 2 - 0.05
            e0 = t_end if q == len(u["scenes"]) - 1 else (ws[-1]["e"] + bounds[q + 1][0]["s"]) / 2 - 0.05
            scenes[j] = {"start": round(s0, 3), "end": round(e0, 3), "vo_start": ws[0]["s"], "vo_end": ws[-1]["e"], "words": ws}
        # minimum durations (dur) push everything after
        j = u["scenes"][-1]
        if plan["scenes"][j].get("dur"):
            scenes[j]["end"] = max(scenes[j]["end"], scenes[j]["start"] + plan["scenes"][j]["dur"])
        t = scenes[j]["end"]
        i = u["scenes"][-1] + 1
    hold = plan["scenes"][-1].get("hold", cfg.get("hold", 1.3))
    scenes[-1]["end"] = round(scenes[-1]["end"] + hold, 3)
    beats = music_beats(proj, plan) if cfg.get("snap") else []
    if beats:                                         # land each cut on the nearest beat it can reach
        moved = 0
        for k in range(1, len(scenes)):
            prev, cur = scenes[k - 1], scenes[k]
            lo = (prev["words"][-1]["e"] + 0.02) if prev["words"] else prev["start"] + 0.3
            hi = (cur["words"][0]["s"] + 0.06) if cur["words"] else cur["end"] - 0.3
            near = [b for b in beats if lo <= b <= hi and abs(b - cur["start"]) <= cfg.get("snap_window", 0.2)]
            if near:
                b = min(near, key=lambda b: abs(b - cur["start"]))
                moved += abs(b - cur["start"]) > 0.005
                prev["end"] = cur["start"] = round(b, 3)
        print(f"snapped {moved} cut(s) to the beat")
    dur = scenes[-1]["end"]
    track = np.zeros(int((dur + 1) * SR))
    for a, x in placed:
        s = int(a * SR); track[s: s + len(x)] += x[: len(track) - s]
    write_wav(os.path.join(vo_dir(proj), "vo.wav"), track[: int(dur * SR)])
    json.dump({"duration": round(dur, 3), "vo": "vo/vo.wav", "scenes": scenes}, open(os.path.join(proj, "timeline.json"), "w"), indent=1)
    print(f"timeline: {dur:.2f} s, {len(scenes)} scenes -> {os.path.join(proj, 'timeline.json')}")


def script(proj, _args=None):
    for u in utterances(load_plan(proj)):
        print(f"{u['id']:>3}  {u['text']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("script", "build"):
        sub.add_parser(name).add_argument("project")
    r = sub.add_parser("record"); r.add_argument("project"); r.add_argument("--line", type=int); r.add_argument("--device")
    r.add_argument("--missing", action="store_true", help="only lines that don't have a take yet")
    sub.add_parser("devices")
    im = sub.add_parser("import"); im.add_argument("project"); im.add_argument("file")
    f = sub.add_parser("fish"); f.add_argument("project"); f.add_argument("--voice", required=True)
    f.add_argument("--model", default="s2.1-pro-free"); f.add_argument("--speed", type=float, default=1.0)
    fv = sub.add_parser("fish-voices"); fv.add_argument("query", nargs="?", default=""); fv.add_argument("--lang", default="en")
    e = sub.add_parser("eleven"); e.add_argument("project"); e.add_argument("--voice", required=True)
    e.add_argument("--model", default="eleven_multilingual_v2"); e.add_argument("--speed", type=float, default=1.0)
    e.add_argument("--stability", type=float, default=0.45)
    sub.add_parser("eleven-voices")
    ap_ = sub.add_parser("auphonic"); ap_.add_argument("project")
    ap_.add_argument("--denoise", default="dynamic", choices=["dynamic", "classic", "static", "speech_isolation", "off"])
    ap_.add_argument("--amount", type=int, default=12, help="noise reduction in dB (0 = full)")
    ap_.add_argument("--eq", default="autoeq", choices=["autoeq", "hipfilter", "bwe", "studiovoice"])
    ap_.add_argument("--all", action="store_true", help="also send TTS clips, not just recorded takes")
    ap_.add_argument("--dry-run", action="store_true", help="write the upload file and show the settings; send nothing")
    s = sub.add_parser("say"); s.add_argument("project"); s.add_argument("--voice", default="Reed (English (US))"); s.add_argument("--rate", type=int, default=185)
    s.add_argument("--missing", action="store_true", help="only lines that don't have a clip yet")
    a = ap.parse_args()
    proj = os.path.abspath(a.project) if getattr(a, "project", None) else None
    {"script": lambda: script(proj), "build": lambda: build(proj), "record": lambda: record(proj, a),
     "devices": lambda: devices(), "import": lambda: import_take(proj, a), "fish": lambda: (gen_fish(proj, a), build(proj)),
     "fish-voices": lambda: fish_voices(a), "eleven": lambda: (gen_eleven(proj, a), build(proj)),
     "eleven-voices": lambda: eleven_voices(a), "say": lambda: (gen_say(proj, a), build(proj)),
     "auphonic": lambda: (gen_auphonic(proj, a), None if a.dry_run else build(proj))}[a.cmd]()


if __name__ == "__main__":
    main()
