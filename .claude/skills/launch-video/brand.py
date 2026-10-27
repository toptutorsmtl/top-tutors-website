#!/usr/bin/env python3
"""Pull a website's brand with context.dev and apply it to a launch-video plan.

  python3 brand.py <project> stripe.com                    logo, colours, fonts + a homepage screenshot
  python3 brand.py <project> stripe.com --pages /pricing   also screenshot these paths
  python3 brand.py <project> stripe.com --refresh          ignore context.dev's cache (fresh crawl)
  python3 brand.py <project> stripe.com --dry-run          show what would be written, change nothing

Calls: brand/retrieve (10 credits) + web/styleguide (10 credits) + one scrape screenshot per page (1 credit each),
so about 21 credits a site; the free plan is 1,000 credits a month. Responses are saved in assets/brand/ and
reused, so re-running on the same site costs nothing unless you pass --refresh.

Writes into the project:
  assets/brand/brand.json, styleguide.json   raw responses (kept so nothing is fetched twice)
  assets/brand/logo.*, mark.*                 the full logo and the square icon (light-background versions first)
  assets/brand/fonts/<family>-<weight>.*      the heading and body font files the site serves
  assets/brand/shot-home.png, shot-<page>.png screenshots for ui/cards scenes
  plan.json  brand {name, mark} and theme {accent, light, dark, ink, paper, font, fontFiles, pill...}

Key: CONTEXT_DEV_API_KEY in the environment or a .env file in the project or skill folder.

No key, but the context.dev MCP is connected in Claude? Call its brand-retrieve-unified ({"type": "by_domain"}) and
web-styleguide tools, save the responses as assets/brand/brand.json {"domain", "brand"} and styleguide.json
{"domain", "styleguide"}, then run this: it applies the saved data and takes the screenshots locally with
engine/shoot.mjs instead of the scrape endpoint.
"""
import argparse, base64, json, os, re, sys, warnings
from urllib.parse import urlparse

warnings.filterwarnings("ignore", message="urllib3 v2 only supports OpenSSL")
SKILL = os.path.dirname(os.path.abspath(__file__))
API = "https://api.context.dev/v1"


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
    return None


def need_key(key, what):
    if not key:
        sys.exit(f"{what} isn't saved yet and CONTEXT_DEV_API_KEY is not set. Add the key to {os.path.join(SKILL, '.env')} "
                 "(context.dev/dashboard/api-keys), or save the context.dev MCP responses as described in this file's header.")
    return key


def domain_of(s):
    s = s if "://" in s else "https://" + s
    return urlparse(s).netloc.lower().removeprefix("www.")


def call(method, path, key, **kw):
    import requests
    r = requests.request(method, API + path, headers={"Authorization": f"Bearer {key}"}, timeout=180, **kw)
    try:
        body = r.json()
    except ValueError:
        sys.exit(f"context.dev {path}: HTTP {r.status_code} {r.text[:200]}")
    if r.status_code >= 400:
        sys.exit(f"context.dev {path}: HTTP {r.status_code} {body.get('code') or ''} {body.get('message') or body}")
    used = (body.get("key_metadata") or {})
    if used:
        print(f"  {path}: {used.get('credits_consumed', '?')} credit(s), {used.get('credits_remaining', '?')} left")
    return body


def download(url, dst_noext):
    import requests
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    ct = r.headers.get("content-type", "")
    ext = os.path.splitext(urlparse(url).path)[1].lower()
    if not ext or len(ext) > 6:
        ext = {"image/svg+xml": ".svg", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
               "font/woff2": ".woff2", "font/woff": ".woff", "font/ttf": ".ttf", "font/otf": ".otf"}.get(ct.split(";")[0], ".bin")
    path = dst_noext + ext
    with open(path, "wb") as f:
        f.write(r.content)
    return path


def em(letter_spacing, font_size):
    """'-1.4px' at '40px' -> '-0.035em' (engine tracking is in em)."""
    try:
        ls, fs = float(re.sub(r"[^\d.-]", "", letter_spacing or "0") or 0), float(re.sub(r"[^\d.]", "", font_size or "16") or 16)
        if "em" in (letter_spacing or ""):
            return f"{ls:.3f}em"
        return f"{ls / fs:.3f}em" if fs else None
    except ValueError:
        return None


def luminance(hexc):
    h = hexc.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def saturation(hexc):
    h = hexc.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    mx, mn = max(r, g, b), min(r, g, b)
    return 0 if mx == 0 else (mx - mn) / mx


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("site")
    ap.add_argument("--pages", default="", help="extra paths to screenshot, comma separated (e.g. /pricing,/docs)")
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--no-shots", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    proj = os.path.abspath(a.project)
    dom = domain_of(a.site)
    out = os.path.join(proj, "assets", "brand")
    os.makedirs(os.path.join(out, "fonts"), exist_ok=True)
    key = env_key("CONTEXT_DEV_API_KEY", proj)
    age = {"maxAgeMs": 0} if a.refresh else {}

    bj, sj = os.path.join(out, "brand.json"), os.path.join(out, "styleguide.json")
    cached = lambda p: os.path.exists(p) and json.load(open(p)).get("domain") == dom and not a.refresh
    print(f"{dom}:")
    if cached(bj):
        brand = json.load(open(bj))["brand"]; print("  brand: saved")
    else:
        brand = call("POST", "/brand/retrieve", need_key(key, "The brand"), json={"type": "by_domain", "domain": dom, **age})["brand"]
        json.dump({"domain": dom, "brand": brand}, open(bj, "w"), indent=1)
    if cached(sj):
        sg = json.load(open(sj))["styleguide"]; print("  styleguide: saved")
    else:
        sg = call("GET", "/web/styleguide", need_key(key, "The styleguide"), params={"domain": dom, **age})["styleguide"]
        json.dump({"domain": dom, "styleguide": sg}, open(sj, "w"), indent=1)

    # logos: prefer a light-background version; icon = mark, logo = wordmark
    logos = brand.get("logos") or []
    def pick(kind):
        c = [l for l in logos if l.get("type") == kind]
        c.sort(key=lambda l: (l.get("mode") != ("light" if sg.get("mode", "light") == "light" else "dark"),
                              not (l.get("url", "").lower().endswith(".svg")), -(l.get("resolution") or {}).get("width", 0)))
        return c[0] if c else None
    files = {}
    for kind, name in (("icon", "mark"), ("logo", "logo")):
        l = pick(kind)
        if l and not a.dry_run:
            files[name] = download(l["url"], os.path.join(out, name))

    # fonts: heading (h1) family drives the engine; download the weights the site serves
    typo = sg.get("typography") or {}
    h1 = (typo.get("headings") or {}).get("h1") or {}
    body = typo.get("p") or {}
    fam = h1.get("fontFamily") or body.get("fontFamily")
    font_files = {}
    link = (sg.get("fontLinks") or {}).get(fam) if fam else None
    if link and link.get("displayName"):
        fam = link["displayName"]                 # "rethinkSans" -> "Rethink Sans"
    if link and not a.dry_run:
        got = {}                                  # variable fonts list one file under every weight: fetch it once
        for w, url in (link.get("files") or {}).items():
            try:
                if url not in got:
                    got[url] = os.path.relpath(download(url, os.path.join(out, "fonts", f"{re.sub(r'[^A-Za-z0-9]+', '-', fam)}-{w}")), proj)
                font_files[str(w)] = got[url]
            except Exception as e:
                print(f"  font {fam} {w}: {e}")

    colors = sg.get("colors") or {}
    bg, text, accent = colors.get("background", "#FFFFFF"), colors.get("text", "#111111"), colors.get("accent")
    if not accent or saturation(accent) < 0.2:   # black/grey buttons aren't the brand colour: take the brand's own hue
        accent = next((c["hex"] for c in brand.get("colors") or [] if saturation(c["hex"]) >= 0.3), accent or "#0DDD4B")
    light_site = luminance(bg) > 0.5
    btn = ((sg.get("components") or {}).get("button") or {}).get("primary") or {}
    theme = {"accent": accent, "light": bg if light_site else "#FFFFFF", "dark": bg if not light_site else text,
             "ink": text if light_site else "#0B0B0C", "paper": text if not light_site else "#FFFFFF"}
    if fam:
        theme["font"] = fam
        if font_files:
            theme["fontFiles"] = font_files
    if h1.get("letterSpacing"):
        t = em(h1["letterSpacing"], h1.get("fontSize"))
        if t:
            theme["track"] = t
    if h1.get("fontWeight"):
        theme["weight"] = int(h1["fontWeight"])
    if btn.get("borderRadius"):
        theme["pillRadius"] = "0.6em" if re.search(r"(9{3,}|50%|[3-9]\dpx)", btn["borderRadius"]) else "0.2em"

    shots = []
    if not a.no_shots:
        pages = ["/"] + [p if p.startswith("/") else "/" + p for p in a.pages.split(",") if p.strip()]
        for pg in pages:
            nm = "home" if pg == "/" else re.sub(r"[^a-z0-9]+", "-", pg.lower()).strip("-")
            dst = os.path.join(out, f"shot-{nm}.png")
            if os.path.exists(dst) and not a.refresh:
                shots.append(dst); continue
            if a.dry_run:
                continue
            if not key:                           # no key: shoot it locally (headless Chrome, 2x, no credits)
                import subprocess
                r = subprocess.run(["node", os.path.join(SKILL, "engine", "shoot.mjs"), f"https://{dom}{pg}", dst],
                                   capture_output=True, text=True)
                if r.returncode == 0 and os.path.exists(dst):
                    shots.append(dst)
                else:
                    print(f"  screenshot {pg}: {(r.stderr or r.stdout).strip()[-200:]}")
                continue
            r = call("POST", "/web/scrape", key, json={"url": f"https://{dom}{pg}", "formats": {"screenshot": True},
                                                       "screenshotParams": {"area": "viewport", "format": "png"}})
            s = r.get("screenshot") or {}
            if s.get("success") and s.get("data"):
                open(dst, "wb").write(base64.b64decode(s["data"].split(",", 1)[1])); shots.append(dst)
            else:
                print(f"  screenshot {pg}: {s.get('error_code')} {s.get('message')}")

    name = brand.get("title") or dom
    print(f"  name   {name}\n  accent {accent}   background {bg}   text {text}   ({'light' if light_site else 'dark'} site)")
    print(f"  font   {fam or '-'} {('(' + ', '.join(sorted(font_files)) + ')') if font_files else '(no files: falls back to Inter Tight)'}")
    print(f"  logos  {', '.join(os.path.relpath(p, proj) for p in files.values()) or '-'}")
    print(f"  shots  {', '.join(os.path.relpath(p, proj) for p in shots) or '-'}")
    if a.dry_run:
        print(json.dumps(theme, indent=1)); return
    pp = os.path.join(proj, "plan.json")
    plan = json.load(open(pp)) if os.path.exists(pp) else {"name": os.path.basename(proj), "format": "16:9", "scenes": []}
    plan.setdefault("brand", {})["name"] = name
    if "mark" in files:
        plan["brand"]["mark"] = os.path.relpath(files["mark"], proj)
    plan["theme"] = {**plan.get("theme", {}), **theme}
    plan.setdefault("source", {})["brand"] = {"site": dom, "by": "context.dev"}
    json.dump(plan, open(pp, "w"), indent=1)
    print(f"plan.json: brand + theme from {dom}")


if __name__ == "__main__":
    main()
