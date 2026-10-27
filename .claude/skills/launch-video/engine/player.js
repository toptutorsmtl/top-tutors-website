// Launch-video engine: a deterministic motion-graphics player.
//
// render.mjs loads player.html, calls __load(data) once, then __seek(t) for every frame and screenshots the page.
// Nothing animates on its own: every style is a pure function of t, so any frame can be rendered in any order.
//
// data = { plan, timeline|null, base }   base = file:// URL of the project folder (assets resolve against it)
(() => {
  const FORMATS = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350] };
  const SIZES = { xs: 44, s: 60, m: 80, l: 100, xl: 150, xxl: 240 };
  const WPS = 2.7;               // speaking rate used to estimate a timeline before there is a voiceover
  const REVEAL = 0.34;           // word reveal length (s)
  const LEAD = 0.06;             // words start revealing this much before they are spoken
  let W, H, S, P, BASE, stage, theme, brand, scenes = [], videos = [];

  // ---------- helpers ----------
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const prog = (t, t0, d) => (d <= 0 ? (t >= t0 ? 1 : 0) : clamp((t - t0) / d));
  const lerp = (a, b, k) => a + (b - a) * k;
  const E = {
    lin: (k) => k,
    out3: (k) => 1 - (1 - k) ** 3,
    out5: (k) => 1 - (1 - k) ** 5,
    in3: (k) => k ** 3,
    inout3: (k) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2),
    back: (k) => { const c = 1.5; return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2; },
  };
  const el = (tag, cls, parent, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  };
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9%$]/g, "");
  const url = (src) => (/^(https?:|file:|data:)/.test(src) ? src : BASE + src);
  const isVideo = (src) => /\.(mp4|mov|webm|m4v)$/i.test(src || "");
  const hexA = (hex, a) => {
    const n = parseInt(hex.replace("#", ""), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const shade = (hex, f) => {   // f > 0 lightens towards white, f < 0 darkens
    const n = parseInt(hex.replace("#", ""), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(f > 0 ? v + (255 - v) * f : v * (1 + f)));
    return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  };
  const tf = (o) => {
    let s = `translate(${(o.x || 0).toFixed(2)}px,${(o.y || 0).toFixed(2)}px)`;
    if (o.persp) s += ` perspective(${o.persp}px)`;
    if (o.rx) s += ` rotateX(${o.rx.toFixed(3)}deg)`;
    if (o.ry) s += ` rotateY(${o.ry.toFixed(3)}deg)`;
    if (o.rz) s += ` rotate(${o.rz.toFixed(3)}deg)`;
    if (o.s != null && o.s !== 1) s += ` scale(${o.s.toFixed(4)})`;
    if (o.sx != null) s += ` scaleX(${o.sx.toFixed(4)})`;
    return s;
  };
  let blurK = 1;   // "look": "clean" sets 0: no reveal/exit/lens blur anywhere, everything stays crisp
  const setFx = (e, op, blur) => {
    blur *= blurK;
    e.style.opacity = op.toFixed(3);
    e.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";
  };
  // keyframes [{at, ...props}] -> props at time t (inout3 between keys)
  function keyAt(keys, t, props) {
    const out = {};
    for (const p of props) {
      const ks = keys.filter((k) => k[p] != null);
      if (!ks.length) continue;
      if (t <= ks[0].at) { out[p] = ks[0][p]; continue; }
      if (t >= ks[ks.length - 1].at) { out[p] = ks[ks.length - 1][p]; continue; }
      for (let i = 0; i < ks.length - 1; i++) {
        if (t >= ks[i].at && t <= ks[i + 1].at) {
          const k = E[ks[i + 1].ease || "inout3"](prog(t, ks[i].at, ks[i + 1].at - ks[i].at));
          out[p] = lerp(ks[i][p], ks[i + 1][p], k);
        }
      }
    }
    return out;
  }

  // ---------- markup ----------
  // [pill words]  *accent*  _serif italic_  {11..22} counter pill  @brand inline logo  | line break
  function parse(str) {
    const lines = [];
    for (const raw of String(str || "").split("|")) {
      const s = raw.trim(), groups = [];
      const plain = (txt, cls) => {
        const parts = txt.split(/(\s+)/);
        let glue = !/^\s/.test(txt) && groups.length && !groups[groups.length - 1].spaced;
        for (const p of parts) {
          if (!p) continue;
          if (/^\s+$/.test(p)) { if (groups.length) groups[groups.length - 1].spaced = true; glue = false; continue; }
          if (glue) { groups[groups.length - 1].after = (groups[groups.length - 1].after || "") + p; glue = false; continue; }
          groups.push({ kind: "word", words: [{ text: p, cls }] });
        }
      };
      let i = 0;
      while (i < s.length) {
        const c = s[i], prevSpace = i === 0 || /\s/.test(s[i - 1]);
        const close = (ch) => s.indexOf(ch, i + 1);
        if (c === "[" && close("]") > 0) {
          const j = close("]");
          groups.push({ kind: "pill", words: s.slice(i + 1, j).split(/\s+/).filter(Boolean).map((text) => ({ text, cls: "inpill" })) });
          i = j + 1; if (i < s.length && /\s/.test(s[i])) groups[groups.length - 1].spaced = true;
        } else if ((c === "*" || c === "_") && prevSpace && close(c) > 0) {
          const j = close(c);
          plain(s.slice(i + 1, j), c === "*" ? "accent" : "serif");
          i = j + 1; if (i < s.length && /\s/.test(s[i])) groups[groups.length - 1].spaced = true;
        } else if (c === "{" && close("}") > 0) {
          const j = close("}"), inner = s.slice(i + 1, j);
          const [a, b] = inner.includes("..") ? inner.split("..") : [null, inner];
          const m = b.match(/^([^\d-]*)(-?[\d,.]+)(.*)$/) || ["", "", "0", ""];
          const to = parseFloat(m[2].replace(/,/g, "")), from = a != null ? parseFloat(a.replace(/[^\d.-]/g, "")) : Math.round(to * 0.5);
          groups.push({ kind: "count", words: [{ text: b, cls: "inpill count" }], from, to, pre: m[1], suf: m[3],
            commas: m[2].includes(","), dec: (m[2].split(".")[1] || "").length });
          i = j + 1; if (i < s.length && /\s/.test(s[i])) groups[groups.length - 1].spaced = true;
        } else if (s.startsWith("@brand", i)) {
          groups.push({ kind: "brand", words: brand.name.split(/\s+/).map((text) => ({ text, cls: "" })) });
          i += 6; if (i < s.length && /\s/.test(s[i])) groups[groups.length - 1].spaced = true;
        } else {
          let j = i + 1;
          while (j < s.length && !(s[j] === "[" || s[j] === "{" || s.startsWith("@brand", j) ||
            ((s[j] === "*" || s[j] === "_") && /\s/.test(s[j - 1])))) j++;
          plain(s.slice(i, j));
          i = j;
        }
      }
      lines.push(groups);
    }
    return lines;
  }
  const spoken = (str) => parse(str).flat().flatMap((g) => g.words.map((w) => w.text));

  // display tokens -> {s, e} spoken times (scene-local). Exact sequential matches first, gaps interpolated.
  function mapTimes(tokens, words, t0, t1) {
    const N = tokens.length, M = words.length, out = new Array(N).fill(null);
    let j = 0;
    for (let k = 0; k < N; k++) {
      const a = norm(tokens[k]);
      for (let q = j; q < Math.min(M, j + 4); q++) {
        const b = norm(words[q].w);
        if (a && b && (a === b || (a.length > 3 && b.startsWith(a)) || (b.length > 3 && a.startsWith(b)))) { out[k] = words[q]; j = q + 1; break; }
      }
    }
    for (let k = 0; k < N; k++) {
      if (out[k]) continue;
      let p = k - 1; while (p >= 0 && !out[p]) p--;
      let n = k + 1; while (n < N && !out[n]) n++;
      const ps = p >= 0 ? out[p].e : (M ? words[0].s : t0), pi = p;
      const ns = n < N ? out[n].s : (M ? words[M - 1].e : t1), ni = n;
      const f = (k - pi) / (ni - pi);
      const s = lerp(ps, ns, f - 0.5 / (ni - pi)), e = lerp(ps, ns, f + 0.5 / (ni - pi));
      out[k] = { s: Math.max(t0, s), e: Math.max(s + 0.05, e), guess: true };
    }
    return out;
  }

  // ---------- text block ----------
  // A block of kinetic lines laid out absolutely so a centred line can re-centre as each word grows in.
  function TextBlock(parent, str, o) {
    const fs0 = (SIZES[o.size] || o.size || SIZES.l) * S;
    const lines = parse(str);
    const root = el("div", "abs", parent);
    root.style.color = o.color;
    root.style.setProperty("--track", o.track ?? theme.track ?? "-0.045em");
    const weight = o.weight || theme.weight || 500;
    const toks = [], pills = [], groupsAll = [], carets = [];
    const meas = el("span", "abs tok", root);
    meas.style.visibility = "hidden";
    const measure = (text, cls, fs, w) => {
      meas.className = "abs tok " + (cls || "");
      meas.style.fontSize = fs + "px"; meas.style.fontWeight = w;
      meas.textContent = text; return meas.getBoundingClientRect().width;
    };
    // fit: shrink the font until the longest line fits the region
    const lineWidth = (groups, fs) => {
      let w = 0;
      groups.forEach((g, gi) => {
        const inner = g.kind === "pill" || g.kind === "count";
        const f = inner ? fs * 0.9 : fs;
        g.words.forEach((wd, wi) => { w += measure(wd.text, wd.cls, f, inner ? 600 : weight); if (wi < g.words.length - 1) w += measure(" ", "", f, weight); });
        if (inner) w += fs * 0.4;
        if (g.kind === "brand") w += fs * 1.0;
        if (g.after) w += measure(g.after, "", fs, weight);
        if (gi < groups.length - 1) w += measure(" ", "", fs, weight) * (inner ? 1.4 : 1);
      });
      return w;
    };
    let fs = fs0;
    if (o.wrap !== false) {   // too long for one line: break into balanced lines
      for (let li = lines.length - 1; li >= 0; li--) {
        const T = lineWidth(lines[li], fs0);
        if (T <= o.region.w * 1.25 || lines[li].length < 2) continue;
        const k = Math.ceil(T / (o.region.w * 0.92)), target = T / k;
        const parts = [[]]; let acc = 0;
        for (const g of lines[li]) {
          const gw = lineWidth([g], fs0) + measure(" ", "", fs0, weight);
          if (acc > 0 && acc + gw / 2 > target && parts.length < k) { parts.push([]); acc = 0; }
          parts[parts.length - 1].push(g); acc += gw;
        }
        lines.splice(li, 1, ...parts);
      }
    }
    const widest = Math.max(...lines.map((g) => lineWidth(g, fs0)));
    if (widest > o.region.w) fs = Math.max(fs0 * 0.45, fs0 * (o.region.w / widest));
    const lh = fs * (o.lineHeight || 1.2), sp = measure(" ", "", fs, weight);

    lines.forEach((groups, li) => {
      groups.forEach((g, gi) => {
        const inner = g.kind === "pill" || g.kind === "count";
        const f = inner ? fs * 0.9 : fs;
        const gr = { kind: g.kind, toks: [], g, li, padL: 0, padR: 0, gapAfter: 0 };
        if (inner) {
          gr.padL = gr.padR = fs * 0.2;
          gr.bg = el("div", "abs pill", root);
          gr.bg.style.height = fs * 1.08 + "px";
          if (theme.pillRadius) gr.bg.style.fontSize = fs + "px";   // a brand's em radius is relative to the line
          pills.push(gr);
        }
        if (g.kind === "brand") {
          gr.padL = fs * 1.0;
          if (brand.mark) {   // the brand's own mark inline, like the logo scene
            gr.orb = el("img", "abs", root); gr.orb.src = url(brand.mark); gr.orb.style.objectFit = "contain";
          } else {
            gr.orb = el("div", "abs orb", root);
            gr.orb.style.boxShadow = `0 0 ${fs * 0.5}px ${hexA(theme.accent, 0.55)}`;
          }
          gr.orb.style.width = gr.orb.style.height = fs * 0.78 + "px";
        }
        g.words.forEach((wd, wi) => {
          const e = el("span", "abs tok " + (wd.cls || ""), root);
          e.style.fontSize = f + "px"; e.style.fontWeight = inner ? 600 : weight;
          e.style.lineHeight = lh + "px";
          e.textContent = wd.text;
          const tk = { e, text: wd.text, w: measure(wd.text, wd.cls, f, inner ? 600 : weight), li, gr, i: toks.length,
            gap: wi < g.words.length - 1 ? measure(" ", "", f, weight) : 0 };
          if (o.mode === "type") {
            e.textContent = "";
            tk.chars = [...wd.text].map((ch) => { const c = el("span", "", e); c.textContent = ch; return c; });
            tk.prefix = [0]; let acc = "";
            for (const ch of wd.text) { acc += ch; tk.prefix.push(measure(acc, wd.cls, f, inner ? 600 : weight)); }
          }
          if (o.mode === "letters") {
            e.textContent = "";
            tk.chars = [...wd.text].map((ch) => { const c = el("span", "", e); c.style.display = "inline-block"; c.textContent = ch; return c; });
          }
          if (g.kind === "count") tk.count = g;
          gr.toks.push(tk); toks.push(tk);
        });
        if (g.after) {
          gr.afterEl = el("span", "abs tok", root);
          gr.afterEl.style.fontSize = fs + "px"; gr.afterEl.style.lineHeight = lh + "px"; gr.afterEl.style.fontWeight = weight;
          gr.afterEl.textContent = g.after; gr.afterW = measure(g.after, "", fs, weight);
        }
        gr.gapAfter = gi < groups.length - 1 ? sp * (inner ? 1.35 : 1) : 0;
        groupsAll.push(gr);
      });
    });
    const fullW = Math.max(...lines.map((g) => lineWidth(g, fs)));
    meas.remove();
    if (o.mode === "type") {
      const c = el("div", "abs caret", root);
      c.style.width = Math.max(2, fs * 0.055) + "px"; c.style.height = fs * 1.0 + "px";
      carets.push(c);
    }
    const nLines = lines.length, blockH = nLines * lh;
    const top0 = o.vpos === "top" ? o.region.y : o.vpos === "bottom" ? o.region.y + o.region.h - blockH : o.region.y + (o.region.h - blockH) / 2;
    const rnd = (k) => { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

    function update(lt, times, exitK = 0) {
      // per-token reveal 0..1
      const rev = toks.map((tk) => {
        if (o.mode === "letters" || o.static) return 1;
        const tm = times[tk.i] || { s: 0, e: 0.3 };
        if (o.mode === "type") return prog(lt, tm.s, Math.max(0.08, tm.e - tm.s));
        return E.out3(prog(lt, tm.s - LEAD, REVEAL));
      });
      const grow = o.grow !== false && o.mode !== "letters";
      let caretX = null, caretY = 0, typing = false;
      for (let li = 0; li < nLines; li++) {
        const grs = groupsAll.filter((g) => g.li === li);
        // pass 1: widths at this instant
        const xs = []; let x = 0;
        for (const gr of grs) {
          const first = rev[gr.toks[0].i], last = rev[gr.toks[gr.toks.length - 1].i];
          const a = grow ? first : 1;
          gr.x0 = x; x += gr.padL * (grow ? E.out3(Math.min(1, first * 1.6)) : 1);
          for (const tk of gr.toks) {
            const r = rev[tk.i];
            const w = o.mode === "type" ? tk.prefix[Math.round(r * tk.chars.length)] : tk.w;
            xs[tk.i] = x; x += (grow ? (o.mode === "type" ? w + (r >= 1 ? tk.gap : 0) : (tk.w + tk.gap) * r) : tk.w + tk.gap);
            tk.cw = w;
          }
          if (gr.afterEl) { gr.afterX = x; x += gr.afterW * (grow ? last : 1); }
          x += gr.padR * (grow ? E.out3(Math.min(1, first * 1.6)) : 1);
          gr.x1 = x;
          x += gr.gapAfter * (grow ? (o.mode === "type" ? (last >= 1 ? 1 : 0) : last) : 1);
          gr.a = a;
        }
        const lineW = x - (grs.length ? grs[grs.length - 1].gapAfter * (grow ? rev[grs[grs.length - 1].toks.slice(-1)[0].i] : 1) : 0);
        const left = o.align === "left" ? o.region.x : o.align === "right" ? o.region.x + o.region.w - lineW : o.region.x + (o.region.w - lineW) / 2;
        const y = top0 + li * lh;
        // pass 2: place
        for (const gr of grs) {
          if (gr.bg) {
            const k = E.back(Math.min(1, rev[gr.toks[0].i] * 1.4));
            gr.bg.style.width = Math.max(0, gr.x1 - gr.x0) + "px";
            gr.bg.style.transform = tf({ x: left + gr.x0, y: y + (lh - fs * 1.08) / 2, s: lerp(0.6, 1, k) });
            gr.bg.style.opacity = clamp(rev[gr.toks[0].i] * 2).toFixed(3);
          }
          if (gr.orb) {
            const k = E.back(rev[gr.toks[0].i]);
            gr.orb.style.transform = tf({ x: left + gr.x0 + fs * 0.05, y: y + (lh - fs * 0.78) / 2, s: k });
          }
          for (const tk of gr.toks) {
            const r = rev[tk.i];
            const inner = gr.kind === "pill" || gr.kind === "count";
            const yy = y + (inner ? fs * 0.02 : 0);
            if (o.mode === "type") {
              const n = Math.round(r * tk.chars.length);
              tk.chars.forEach((c, ci) => {
                c.style.display = ci < n ? "inline" : "none";
                const age = lt - ((times[tk.i] || { s: 0 }).s + (ci / tk.chars.length) * ((times[tk.i] || { e: 0.3 }).e - (times[tk.i] || { s: 0 }).s));
                c.style.color = !inner && age < 0.28 ? theme.accent : "";
              });
              tk.e.style.transform = tf({ x: left + xs[tk.i], y: yy });
              if (r > 0 && r < 1) typing = true;
              if (r > 0) { caretX = left + xs[tk.i] + tk.cw + fs * 0.06; caretY = y; }
            } else if (o.mode === "letters") {
              tk.e.style.transform = tf({ x: left + xs[tk.i], y: yy });
              const t0 = (times[0] || { s: 0 }).s;
              tk.chars.forEach((c, ci) => {
                const k = E.out3(prog(lt, t0 - 0.1 + rnd(tk.i * 31 + ci) * 0.55, 0.45));
                c.style.transform = `translateY(${((1 - k) * fs * 0.18).toFixed(2)}px)`;
                setFx(c, k, (1 - k) * 16 * S);
              });
            } else {
              const k = r;
              tk.e.style.transform = tf({ x: left + xs[tk.i], y: yy + (1 - k) * fs * 0.22, s: lerp(0.96, 1, k) });
              setFx(tk.e, clamp(k * 1.25), (1 - k) * 14 * S);
            }
            if (tk.count) {
              const g = tk.count, tm = times[tk.i] || { s: 0 };
              const k = E.out5(prog(lt, tm.s - LEAD, 0.9));
              let v = lerp(g.from, g.to, k);
              v = g.dec ? v.toFixed(g.dec) : Math.round(v).toString();
              if (g.commas) v = Number(v).toLocaleString("en-US", { minimumFractionDigits: g.dec, maximumFractionDigits: g.dec });
              tk.e.textContent = g.pre + v + g.suf;
              tk.e.style.width = tk.w + "px";
            }
          }
          if (gr.afterEl) {
            const r = rev[gr.toks[gr.toks.length - 1].i];
            gr.afterEl.style.transform = tf({ x: left + gr.afterX, y });
            setFx(gr.afterEl, o.mode === "type" ? (r >= 1 ? 1 : 0) : clamp(r * 1.25), o.mode === "type" ? 0 : (1 - r) * 14 * S);
          }
        }
      }
      for (const c of carets) {
        const on = typing || Math.floor(lt * 2.2) % 2 === 0;
        c.style.opacity = caretX == null || exitK > 0 ? 0 : on ? 1 : 0;
        if (caretX != null) c.style.transform = tf({ x: caretX, y: caretY + (lh - fs) / 2 });
      }
      setFx(root, 1 - exitK, exitK * 14 * S);
    }
    return { root, toks, update, fs, lh, height: blockH, top: top0, width: fullW, count: toks.length, pills,
      // pills and counters pop, typed characters tick
      cues(times) {
        const c = [];
        for (const gr of pills) c.push({ t: (times[gr.toks[0].i] || { s: 0 }).s - 0.02, name: "pop", gain: 0.5 });
        if (o.mode === "type") toks.forEach((tk) => {
          const tm = times[tk.i] || { s: 0, e: 0.3 };
          tk.text.split("").forEach((_, ci) => c.push({ t: tm.s + (ci / tk.text.length) * (tm.e - tm.s), name: "key" + (1 + ((tk.i + ci) % 3)), gain: 0.22 }));
        });
        return c;
      } };
  }

  // ---------- backgrounds ----------
  function paintBg(bg, kind) {
    const a = theme.accent;
    const k = kind || "dark";
    bg.style.background = k.startsWith("light") || k === "dots" ? theme.light : theme.dark;
    if (k === "dots") bg.style.backgroundImage = `radial-gradient(circle, ${theme.dotColor} ${1.4 * S}px, transparent ${1.8 * S}px)`, bg.style.backgroundSize = `${30 * S}px ${30 * S}px`;
    const glow = el("div", "layer", bg);
    if (k === "glow") glow.style.background = `radial-gradient(ellipse 65% 55% at 50% 50%, ${hexA(a, 0.42)}, transparent 70%)`;
    else if (k === "glowbottom") glow.style.background = `radial-gradient(ellipse 80% 55% at 50% 115%, ${hexA(a, 0.6)}, transparent 70%)`;
    else if (k === "lightglow") glow.style.background = `linear-gradient(to top, ${hexA(a, 0.42)} 0%, ${hexA(a, 0.12)} 28%, transparent 55%)`;
    else if (k === "beam") glow.style.background = `radial-gradient(ellipse 16% 80% at 50% 108%, ${hexA(shade(a, 0.35), 0.85)}, transparent 70%), radial-gradient(ellipse 55% 55% at 50% 112%, ${hexA(a, 0.45)}, transparent 72%)`;
    else if (k === "night") glow.style.background = `radial-gradient(ellipse 60% 55% at 50% 58%, ${hexA(a, 0.2)}, transparent 72%)`;
    else if (k === "wash") { bg.style.background = `linear-gradient(to bottom, ${shade(a, 0.55)} 0%, ${shade(a, 0.82)} 55%, #ffffff 100%)`; glow.style.display = "none"; }
    else if (k === "accent") { bg.style.background = a; glow.style.display = "none"; }   // solid brand colour
    else glow.style.display = "none";
    return glow;
  }
  const isLight = (k) => (k || "dark").startsWith("light") || k === "dots" || k === "wash";

  // ---------- scene builders ----------
  // each returns { update(lt, dur), cues(dur), tokens? } ; ctx = { root (layer), sc (plan scene), words (local) }
  const B = {};

  B.text = (ctx) => {
    const sc = ctx.sc, light = isLight(sc.bg);
    const color = sc.color || (light ? theme.ink : theme.paper);
    const portrait = H > W;
    const region = sc.pos === "top" ? { x: W * 0.07, y: H * 0.1, w: W * 0.86, h: H * 0.2 }
      : sc.pos === "bottom" ? { x: W * 0.07, y: H * 0.7, w: W * 0.86, h: H * 0.2 }
      : sc.pos === "left" ? { x: W * 0.08, y: 0, w: W * (portrait ? 0.84 : 0.5), h: H }
      : { x: W * 0.07, y: 0, w: W * 0.86, h: H };
    const tb = TextBlock(ctx.root, sc.text ?? sc.vo, { size: sc.size || "l", color, mode: sc.mode, align: sc.align || (sc.pos === "left" ? "left" : "center"),
      vpos: sc.pos === "top" ? "top" : sc.pos === "bottom" ? "bottom" : "center", region, weight: sc.weight, grow: sc.grow });
    let sub = null;
    if (sc.sub) sub = TextBlock(ctx.root, sc.sub, { size: sc.subSize || "xs", color: light ? "#7a7b80" : "#8d8e94", align: "center", static: true,
      region: { x: region.x, y: tb.top + tb.height + 26 * S, w: region.w, h: 80 * S }, vpos: "top", weight: 500, track: "-0.02em" });
    const times = ctx.times(tb.toks.map((t) => t.text));
    return {
      update(lt, dur, exitK) {
        tb.update(lt, times, exitK);
        if (sub) { const last = times[times.length - 1] || { e: 0 }; const k = E.out3(prog(lt, last.e, 0.4)); sub.update(lt, [], exitK); setFx(sub.root, k * (1 - exitK), (1 - k) * 8 * S); }
      },
      cues: () => tb.cues(times),
    };
  };

  B.hero = (ctx) => {
    const sc = ctx.sc, word = sc.text ?? sc.vo;
    const g = el("div", "layer", ctx.root);
    const glow = el("div", "abs", g), main = el("div", "abs", g);
    const fs = (SIZES[sc.size] || 300) * S * (H > W ? 0.8 : 1);
    for (const d of [glow, main]) {
      d.style.fontSize = fs + "px"; d.style.fontWeight = 600; d.style.letterSpacing = "-0.055em"; d.style.whiteSpace = "pre";
      d.style.lineHeight = "1";
    }
    const letters = [...word.replace(/[.!?]$/, "")];
    const mk = (parent, glowy) => letters.map((ch) => {
      const s = el("span", "", parent); s.textContent = ch; s.style.display = "inline-block";
      if (glowy) s.style.color = theme.accent;
      else {
        s.style.backgroundImage = `linear-gradient(180deg, ${shade(theme.accent, 0.55)} 0%, ${theme.accent} 45%, ${shade(theme.accent, -0.45)} 100%)`;
        s.style.webkitBackgroundClip = "text"; s.style.backgroundClip = "text"; s.style.color = "transparent";
      }
      return s;
    });
    const L = mk(main), G = mk(glow, true);
    glow.style.filter = `blur(${46 * S}px)`; glow.style.opacity = 0.75;
    let bw = 0, bh = 0;
    const times = ctx.times([word]);
    return {
      update(lt, dur, exitK) {
        if (!bw) { bw = main.offsetWidth; bh = main.offsetHeight; }
        const t0 = times[0].s - 0.12;
        const s = lerp(1.0, 1.05, prog(lt, t0, dur));
        for (const d of [main, glow]) d.style.transform = tf({ x: (W - bw) / 2, y: (H - bh) / 2 - fs * 0.04, s });
        L.forEach((c, i) => {
          const k = E.out3(prog(lt, t0 + i * 0.055, 0.5));
          c.style.transform = `translateY(${((1 - k) * fs * 0.16).toFixed(1)}px)`;
          setFx(c, k, (1 - k) * 24 * S);
          G[i].style.transform = c.style.transform; G[i].style.opacity = k;
        });
        setFx(g, 1 - exitK, exitK * 20 * S);
        ctx.glow.style.opacity = E.out3(prog(lt, t0, 0.8)).toFixed(3);
      },
      cues: () => [{ t: times[0].s - 1.0, name: "riser", gain: 0.55 }, { t: times[0].s - 0.08, name: "boom", gain: 0.8 }],
    };
  };

  B.logo = (ctx) => {
    const sc = ctx.sc, portrait = H > W;
    let fs = (SIZES[sc.size] || 150) * S * (portrait ? 0.75 : 1);
    const g = el("div", "layer", ctx.root);
    const rings = [0, 1, 2].map(() => { const r = el("div", "abs ring", g); return r; });
    const orbD = 260 * S;
    let mark;
    if (brand.mark) { mark = el("img", "abs", g); mark.src = url(brand.mark); mark.style.objectFit = "contain"; }
    else { mark = el("div", "abs orb", g); mark.style.boxShadow = `0 0 ${80 * S}px ${hexA(theme.accent, 0.6)}`; }
    mark.style.width = mark.style.height = orbD + "px";
    for (const r of rings) {
      r.style.width = r.style.height = orbD + "px";
      r.style.background = `radial-gradient(circle, transparent 46%, ${hexA(theme.accent, 0.3)} 60%, ${hexA(theme.accent, 0.1)} 66%, transparent 70%)`;
    }
    const lightBg = isLight(sc.bg);
    const name = el("div", "abs", g);
    name.style.fontSize = fs + "px"; name.style.fontWeight = 600; name.style.letterSpacing = "-0.05em"; name.style.color = lightBg ? theme.ink : theme.paper;
    name.style.whiteSpace = "pre"; name.style.lineHeight = "1";
    const letters = [...brand.name].map((ch) => { const s = el("span", "", name); s.textContent = ch; s.style.display = "inline-block"; return s; });
    {   // shrink the lockup (mark + name) to fit
      const maxW = W * (portrait || !sc.tagline ? 0.84 : 0.5), lw = fs * 1.12 + name.offsetWidth;
      if (lw > maxW) { fs *= maxW / lw; name.style.fontSize = fs + "px"; }
    }
    const nWords = brand.name.split(/\s+/).length;
    let tag = null, bar = null, trail = null;
    const tagStr = sc.tagline || "";
    const spokenAll = spoken(sc.vo || brand.name);
    if (tagStr) {
      tag = TextBlock(g, tagStr, { size: sc.tagSize || 46, color: lightBg ? "#6B6F76" : theme.paper, align: "left", vpos: "top", weight: 500, track: "-0.025em",
        region: { x: 0, y: 0, w: W * 0.36, h: 200 * S } });
      bar = el("div", "abs", g); trail = el("div", "abs", g);
      bar.style.background = theme.accent; bar.style.boxShadow = `0 0 ${24 * S}px ${theme.accent}, 0 0 ${60 * S}px ${hexA(theme.accent, 0.7)}`;
    }
    const times = ctx.times(spokenAll);
    const tb = times[0].s;                               // brand is spoken here
    const tagTimes = tag ? ctx.times(tag.toks.map((t) => t.text), nWords) : [];
    let nameW = 0;
    return {
      update(lt, dur, exitK) {
        if (!nameW) nameW = name.offsetWidth;
        const appear = E.back(prog(lt, tb - 0.3, 0.5));
        const lock = E.inout3(prog(lt, tb + 0.35, 0.6));
        const small = fs * 0.82;
        const gap = fs * 0.3;
        const lockW = small + gap + nameW;
        const tagW = tag ? tag.width : 0;
        const tagK = tag ? E.inout3(prog(lt, (tagTimes[0] || { s: dur }).s - 0.35, 0.55)) : 0;
        const stack = portrait && tag;
        const total = lockW + (tag && !stack ? (gap * 1.6 + tagW) * tagK : 0);
        const lx = (W - total) / 2, cy = H / 2 - (stack ? fs * 0.45 * tagK : 0);
        // mark: centre -> left of the lockup
        const d = lerp(orbD, small, lock);
        const mx = lerp(W / 2, lx + small / 2, lock), my = cy;
        mark.style.width = mark.style.height = d + "px";
        mark.style.transform = tf({ x: mx - d / 2, y: my - d / 2, s: appear });
        mark.style.opacity = clamp(appear * 2).toFixed(3);
        rings.forEach((r, i) => {
          const k = prog(lt, tb - 0.25 + i * 0.16, 1.5);
          r.style.transform = tf({ x: W / 2 - orbD / 2, y: cy - orbD / 2, s: lerp(0.6, 4.2, E.out3(k)) });
          r.style.opacity = (k > 0 && k < 1 ? (1 - k) * (1 - lock * 0.6) : 0).toFixed(3);
        });
        // name letters reveal as the mark slides left
        const nx = lx + small + gap;
        name.style.transform = tf({ x: nx, y: cy - fs * 0.52 });
        letters.forEach((c, i) => {
          const k = E.out3(prog(lt, tb + 0.5 + i * 0.035, 0.4));
          c.style.transform = `translateX(${((1 - k) * -fs * 0.25).toFixed(1)}px)`;
          setFx(c, k, (1 - k) * 12 * S);
        });
        if (tag) {
          const bx = lx + lockW + gap * 0.8;
          const bh = fs * 0.95;
          const sweep = E.inout3(prog(lt, (tagTimes[0] || { s: dur }).s - 0.15, 0.7));
          bar.style.width = Math.max(3, 6 * S) + "px"; bar.style.height = bh + "px";
          bar.style.transform = tf({ x: bx, y: cy - bh / 2 });
          bar.style.opacity = stack ? 0 : tagK.toFixed(3);
          trail.style.height = bh + "px";
          trail.style.width = (tagW * 0.9 * sweep) + "px";
          trail.style.background = `linear-gradient(90deg, ${hexA(theme.accent, 0.55)}, ${hexA(theme.accent, 0.12)} 55%, transparent)`;
          trail.style.filter = `blur(${10 * S}px)`;
          trail.style.transform = tf({ x: bx, y: cy - bh / 2 });
          trail.style.opacity = stack ? 0 : (tagK * lerp(1, 0.55, prog(lt, (tagTimes[0] || { s: dur }).s + 0.6, 1))).toFixed(3);
          tag.root.style.left = "0px";
          const tagRegion = stack ? { x: (W - tagW) / 2, y: cy + fs * 0.75 } : { x: bx + gap * 0.9, y: cy - tag.height / 2 };
          tag.root.style.transform = tf({ x: tagRegion.x, y: tagRegion.y - tag.top });
          tag.update(lt, tagTimes.length ? tagTimes : tag.toks.map(() => ({ s: dur, e: dur })), 0);
          tag.root.style.opacity = (tagK * (1 - exitK)).toFixed(3);
        }
        setFx(g, 1 - exitK, exitK * 14 * S);
      },
      cues: () => [{ t: tb - 0.32, name: "boom", gain: 0.6 }, { t: tb + 0.33, name: "swish", gain: 0.45 },
        ...(tag && tagTimes[0] ? [{ t: tagTimes[0].s - 0.2, name: "swish", gain: 0.5 }] : [])],
    };
  };

  // screenshot or screen recording in a window, with camera, cursor, focus, typing and toasts
  B.ui = (ctx) => {
    const sc = ctx.sc, light = isLight(sc.bg), portrait = H > W;
    const media = ctx.media(sc.src);
    const iw = media.w, ih = media.h;
    const side = sc.text ? (portrait ? "top" : sc.side || "left") : "none";
    let ww, wx, wy, region;
    const frame = sc.frame || "browser";
    const barH = frame === "browser" ? 44 * S : 0;
    if (side === "left") { ww = W * (sc.width || 0.6); wx = W * 0.43; region = { x: W * 0.07, y: 0, w: W * 0.32, h: H }; }
    else if (side === "right") { ww = W * (sc.width || 0.6); wx = W - W * 0.43 - ww; region = { x: W * 0.61, y: 0, w: W * 0.32, h: H }; }
    else if (side === "top") { ww = W * (sc.width || (portrait ? 0.92 : 0.7)); wx = (W - ww) / 2; region = { x: W * 0.07, y: H * (portrait ? 0.1 : 0.07), w: W * 0.86, h: H * (portrait ? 0.16 : 0.15) }; }
    else { ww = W * (sc.width || (portrait ? 0.92 : 0.78)); wx = (W - ww) / 2; }
    const ch = ww * (ih / iw);                       // full screenshot height at window width
    let viewH = ch;                                    // visible part (tall screenshots scroll inside the window)
    if (side === "top") { wy = region.y + region.h + H * 0.03; viewH = Math.min(ch, H * 0.95 - wy - barH); }
    else if (ch + barH > H * 0.86) { wy = H * 0.07; viewH = H * 0.86 - barH; }
    else wy = (H - ch - barH) / 2;
    const wh = viewH + barH, scrollMax = ch - viewH;

    const wrap = el("div", "abs", ctx.root);
    wrap.style.width = ww + "px"; wrap.style.height = wh + "px";
    const win = el("div", "win" + (sc.dark ? " dark" : "") + (frame === "none" ? " none" : ""), wrap);
    win.style.width = ww + "px"; win.style.height = wh + "px";
    if (frame === "browser") {
      const bar = el("div", "bar", win); bar.style.height = barH + "px";
      [0, 1, 2].forEach((i) => { const d = el("div", "dot", bar); d.style.width = d.style.height = 12 * S + "px"; d.style.left = (20 + i * 20) * S + "px"; d.style.top = (barH - 12 * S) / 2 + "px"; });
      if (sc.title) { const t = el("div", "title", bar, esc(sc.title)); t.style.fontSize = 15 * S + "px"; t.style.lineHeight = barH + "px"; }
    }
    const content = el("div", "content", win);
    content.style.top = barH + "px"; content.style.width = ww + "px"; content.style.height = viewH + "px";
    const scroller = el("div", "abs", content);       // everything in screenshot coordinates moves with the scroll
    scroller.style.width = ww + "px"; scroller.style.height = ch + "px";
    const m = media.make(scroller); m.style.width = ww + "px"; m.style.height = ch + "px";

    // focus: lift a region of the screenshot out as a floating card
    const veil = el("div", "veil", scroller); veil.style.opacity = 0;
    if (sc.dark) veil.style.background = "#000";
    const focus = (sc.focus || []).map((f) => {
      const [fx, fy, fw, fh] = f.rect;
      const d = el("div", "focus", scroller);
      Object.assign(d.style, { left: fx * ww + "px", top: fy * ch + "px", width: fw * ww + "px", height: fh * ch + "px",
        backgroundImage: `url("${url(sc.src)}")`, backgroundSize: `${ww}px ${ch}px`, backgroundPosition: `${-fx * ww}px ${-fy * ch}px` });
      d.style.opacity = 0;
      return { d, f };
    });
    // typing into fields
    const typing = (sc.typing || []).map((ty) => {
      const d = el("div", "abs tok", scroller);
      d.style.fontSize = (ty.size || 0.012) * ww + "px"; d.style.color = ty.color || (sc.dark ? "#fff" : "#111");
      d.style.fontWeight = 500; d.style.letterSpacing = "-0.01em";
      d.style.transform = tf({ x: ty.x * ww, y: ty.y * ch });
      return { d, ty };
    });
    // cursor
    let cur = null, ripple = null;
    const path = sc.cursor || [];
    if (path.length) {
      cur = el("div", "cursor", scroller);
      const cs = (sc.cursorSize || 0.026) * ww;
      cur.innerHTML = `<svg width="${cs}" height="${cs * 1.3}" viewBox="0 0 20 26"><path d="M1.5 1.5 L1.5 20.5 L6.4 16 L9.6 23.6 L13 22.1 L9.9 14.7 L16.6 14.7 Z" fill="#0b0b0c" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
      ripple = el("div", "ripple", scroller);
    }
    // text beside / above
    let tb = null;
    if (side !== "none") tb = TextBlock(ctx.root, sc.text, { size: sc.size || (side === "top" ? "m" : "m"), color: light ? theme.ink : theme.paper,
      align: side === "top" ? "center" : "left", vpos: "center", region, mode: sc.mode });
    const times = tb ? ctx.times(tb.toks.map((t) => t.text)) : [];

    // toasts float above everything
    const toasts = (sc.toasts || []).map((t) => {
      const d = el("div", "toast", ctx.root);
      const tw = (portrait ? 0.86 : 0.36) * W;
      d.style.width = tw + "px"; d.style.padding = `${22 * S}px ${26 * S}px`;
      const ic = el("div", "ic", d); ic.style.width = ic.style.height = 64 * S + "px";
      ic.style.background = t.iconBg || hexA(theme.accent, 0.15); ic.style.fontSize = 34 * S + "px";
      if (t.icon && /\.(png|jpe?g|svg|webp)$/i.test(t.icon)) { const im = el("img", "", ic); im.src = url(t.icon); } else ic.textContent = t.icon || "●";
      if (!t.icon) ic.style.color = theme.accent;
      const tx = el("div", "tx", d);
      const tt = el("div", "tt", tx, esc(t.title || "")); tt.style.fontSize = 28 * S + "px";
      const tbb = el("div", "tb", tx, esc(t.body || "")); tbb.style.fontSize = 25 * S + "px";
      const tm = el("div", "tm", d, esc(t.time || "now")); tm.style.fontSize = 22 * S + "px";
      return { d, t, tw };
    });

    // camera keys (window-relative; x/y as fractions of the window, s scale, rx/ry degrees)
    const viewCX = side === "left" ? wx + Math.min(ww, W - wx) / 2 : side === "right" ? Math.max(0, wx) + Math.min(ww, wx + ww) / 2 : W / 2;
    const viewCY = side === "top" ? wy + Math.min(wh, H - wy) / 2 : H / 2;
    const zoomInside = sc.zoom === "content";
    const zoomKeys = (sc.cam && Array.isArray(sc.cam) && zoomInside) ? sc.cam.map((k) => {
      if (!k.to) return { at: k.at, s: k.s ?? 1, x: 0, y: 0 };
      const [rx, ry, rw, rh] = k.to;
      const s = Math.min(ww / (rw * ww), viewH / (rh * ch)) * (k.fill || 0.85);
      return { at: k.at, s, x: ww / 2 - s * (rx + rw / 2) * ww, y: viewH / 2 - s * (ry + rh / 2) * ch, ease: k.ease };
    }) : null;
    const camKeys = (() => {
      const c = zoomInside ? "still" : sc.cam, d = ctx.dur;
      if (Array.isArray(c)) return c.map((k) => {
        if (k.to) {   // zoom to a rect of the screenshot
          const [rx, ry, rw, rh] = k.to;
          const s = Math.min((W * (k.fill || 0.55)) / (rw * ww), (H * (k.fill || 0.55)) / (rh * ch));
          const dx = (rx + rw / 2) * ww - ww / 2, dy = barH + (ry + rh / 2) * ch - wh / 2;
          return { at: k.at, s, x: (viewCX - (wx + ww / 2) - s * dx) / ww, y: (viewCY - (wy + wh / 2) - s * dy) / wh, rx: k.rx || 0, ry: k.ry || 0, ease: k.ease };
        }
        return k;
      });
      if (c === "tilt") return [{ at: 0, s: 0.9, rx: 24, y: 0.1 }, { at: 1.0, s: 1, rx: 0, y: 0 }, { at: d, s: 1.05 }];
      if (c === "pan") return [{ at: 0, s: 1 }, { at: d, s: 1.03 }];
      if (c === "still") return [{ at: 0, s: 1 }];
      if (c === "pushleft") return [{ at: 0, s: 1, x: 0.02 }, { at: d, s: 1.08, x: -0.04 }];
      return [{ at: 0, s: 1, ry: side === "left" ? -4 : side === "right" ? 4 : 0 }, { at: d, s: 1.07, ry: 0 }];
    })();

    return {
      update(lt, dur, exitK) {
        const enter = E.out5(prog(lt, 0, 0.6));
        const cam = keyAt(camKeys, lt, ["s", "x", "y", "rx", "ry"]);
        const sk = sc.scroll != null ? keyAt(Array.isArray(sc.scroll) ? sc.scroll : [{ at: 0, y: 0 }, { at: dur, y: sc.scroll }], lt, ["y"]).y
          : sc.cam === "pan" ? E.inout3(prog(lt, 0.45, dur - 0.6)) : 0;
        if (zoomKeys) {
          const z = keyAt(zoomKeys, lt, ["s", "x", "y"]), zs = z.s ?? 1;
          scroller.style.transformOrigin = "0 0";
          scroller.style.transform = `translate(${((z.x ?? 0) * (zs === 1 && !z.x ? 0 : 1)).toFixed(2)}px, ${((z.y ?? 0) - clamp(sk) * scrollMax).toFixed(2)}px) scale(${zs.toFixed(4)})`;
        } else scroller.style.transform = `translateY(${(-clamp(sk) * scrollMax).toFixed(2)}px)`;
        const tiltIn = sc.cam === "tilt";
        wrap.style.transformOrigin = "50% 50%";
        wrap.style.transform = tf({ x: wx + (cam.x || 0) * ww, y: wy + (cam.y || 0) * wh + (tiltIn ? 0 : (1 - enter) * H * 0.06),
          persp: 2400, rx: cam.rx || 0, ry: cam.ry || 0, s: (cam.s || 1) * (tiltIn ? 1 : lerp(0.97, 1, enter)) });
        setFx(wrap, clamp(enter * 1.5) * (1 - exitK), (1 - enter) * 12 * S + exitK * 12 * S);
        // toast blur-behind
        const tk = toasts.length ? Math.max(...toasts.map((t) => E.out3(prog(lt, t.t.at || 0, 0.4)))) : 0;
        if (sc.blurBehind && tk > 0) win.style.filter = `blur(${(tk * 7 * S).toFixed(2)}px)`;
        if (ctx.glow && sc.glow != null) ctx.glow.style.opacity = (sc.glow ? E.out3(prog(lt, sc.glowAt || 0.2, 0.9)) : 0).toFixed(3);
        // focus cards
        let veilK = 0;
        for (const { d, f } of focus) {
          const k = E.back(prog(lt, f.at, 0.5)), k0 = prog(lt, f.at, 0.3);
          veilK = Math.max(veilK, k0);
          d.style.opacity = k0 > 0 ? 1 : 0;
          d.style.transform = `scale(${lerp(1, f.s || 1.08, k).toFixed(4)})`;
          d.style.boxShadow = `0 0 0 ${2 * S}px ${hexA(theme.accent, 0.6 * k0)}, 0 ${24 * S}px ${70 * S}px rgba(0,0,0,${0.2 * k0}), 0 0 ${90 * S}px ${hexA(theme.accent, 0.35 * k0)}`;
        }
        veil.style.opacity = (veilK * (sc.veil ?? (sc.dark ? 0.45 : 0.55))).toFixed(3);
        for (const { d, ty } of typing) {
          const n = Math.floor(prog(lt, ty.at, ty.text.length / (ty.cps || 16)) * ty.text.length);
          d.textContent = ty.text.slice(0, n);
        }
        if (cur) {
          const p = keyAt(path, lt, ["x", "y"]);
          const first = path[0].at;
          let press = 0, rip = -1;
          for (const k of path) if (k.click) {
            const c = lt - k.at;
            if (c > -0.08 && c < 0.16) press = Math.max(press, 1 - Math.abs(c - 0.04) / 0.12);
            if (c >= 0 && c < 0.5) rip = c / 0.5;
          }
          const cs = (sc.cursorSize || 0.026) * ww;
          cur.style.transform = tf({ x: p.x * ww - cs * 0.08, y: p.y * ch - cs * 0.06, s: 1 - 0.18 * clamp(press) });
          cur.style.opacity = clamp((lt - first + 0.25) / 0.25).toFixed(3);
          if (rip >= 0) {
            const rr = cs * lerp(0.4, 2.2, E.out3(rip));
            Object.assign(ripple.style, { width: rr + "px", height: rr + "px", left: p.x * ww - rr / 2 + "px", top: p.y * ch - rr / 2 + "px", opacity: (1 - rip).toFixed(3) });
          } else ripple.style.opacity = 0;
        }
        // toasts stack from the top
        let ty = H * (sc.toastY ?? (portrait ? 0.32 : 0.16));
        toasts.forEach(({ d, t, tw }) => {
          const k = E.back(prog(lt, t.at || 0, 0.55)), k0 = prog(lt, t.at || 0, 0.25);
          const hh = d.offsetHeight;
          d.style.transform = tf({ x: (t.x != null ? t.x * W : (W - tw) / 2), y: ty + (1 - k) * -40 * S, s: lerp(0.9, 1, k) });
          setFx(d, k0 * (1 - exitK), (1 - k0) * 10 * S);
          if (k0 > 0) ty += (hh + 18 * S) * E.out3(k0);
        });
        if (tb) tb.update(lt, times, exitK);
      },
      cues() {
        const c = [{ t: 0.02, name: "swish", gain: 0.3 }];
        for (const k of path) if (k.click) c.push({ t: k.at, name: "click", gain: 0.7 });
        for (const t of sc.toasts || []) c.push({ t: t.at || 0, name: "ding", gain: 0.55 });
        for (const ty of sc.typing || []) for (let i = 0; i < ty.text.length; i++) c.push({ t: ty.at + i / (ty.cps || 16), name: "key" + (1 + (i % 3)), gain: 0.18 });
        for (const f of sc.focus || []) c.push({ t: f.at, name: "pop", gain: 0.4 });
        if (tb) c.push(...tb.cues(times));
        return c;
      },
      videos: media.video ? [{ v: media.video, clipIn: sc.in || 0, speed: sc.speed || 1 }] : [],
    };
  };

  // floating cards: screenshots, outputs, phone screens
  B.cards = (ctx) => {
    const sc = ctx.sc, light = isLight(sc.bg), portrait = H > W;
    const items = sc.items || [];
    let tb = null, top = 0;
    if (sc.text) {
      tb = TextBlock(ctx.root, sc.text, { size: sc.size || "m", color: light ? theme.ink : theme.paper, align: "center", vpos: "center",
        region: { x: W * 0.07, y: H * (portrait ? 0.08 : 0.06), w: W * 0.86, h: H * (portrait ? 0.16 : 0.18) }, mode: sc.mode });
      top = H * (portrait ? 0.26 : 0.25);
    }
    const n = items.length, layout = sc.layout || "row";
    const availW = W * (portrait ? 0.9 : 0.86), availH = H - top - H * 0.1;
    const cards = items.map((it, i) => {
      const media = ctx.media(it.src);
      const d = el("div", "card", ctx.root);
      const im = media.make(d); im.style.width = "100%"; im.style.height = "100%";
      let lab = null;
      if (it.label) { lab = TextBlock(ctx.root, `[${it.label}]`, { size: sc.labelSize || 34, color: "#fff", align: "center", static: true, region: { x: 0, y: 0, w: 600 * S, h: 60 * S }, vpos: "top" }); }
      return { d, media, it, lab, ar: media.w / media.h, video: media.video };
    });
    // layout
    const gap = W * 0.025;
    let rowW = 0;
    if (layout === "grid") {
      const cols = sc.cols || (portrait ? 2 : Math.min(3, n)), rows = Math.ceil(n / cols);
      const cw = Math.min((availW - gap * (cols - 1)) / cols, ((availH - gap * (rows - 1)) / rows) * cards[0].ar);
      cards.forEach((c, i) => { c.w = cw; c.h = cw / c.ar; const r = Math.floor(i / cols), k = i % cols;
        const rowN = Math.min(cols, n - r * cols); const rw = rowN * cw + (rowN - 1) * gap;
        c.x = (W - rw) / 2 + k * (cw + gap); c.y = top + (availH - (rows * c.h + (rows - 1) * gap)) / 2 + r * (c.h + gap); c.rz = 0; });
    } else if (portrait) {
      const cw = W * 0.8;
      cards.forEach((c) => { c.w = cw; c.h = cw / c.ar; });
      const tot = cards.reduce((a, c) => a + c.h, 0);
      const g2 = n > 1 ? Math.min(gap, (availH - tot) / (n - 1)) : 0;
      let y = top + Math.max(0, (availH - (tot + g2 * (n - 1))) / 2);
      cards.forEach((c, i) => { c.x = (W - cw) / 2 + (layout === "fan" ? (i % 2 ? 1 : -1) * W * 0.03 : 0); c.y = y; y += c.h + g2;
        c.rz = layout === "fan" ? (i % 2 ? 2.5 : -2.5) : 0; });
    } else if (layout === "coverflow") {   // 3D: the middle card faces you, the others turn toward it
      const hh = Math.min(availH * 0.82, (availW * 0.52) / cards[0].ar);
      cards.forEach((c, i) => {
        const o = i - (n - 1) / 2, a = Math.min(1, Math.abs(o));
        c.h = hh; c.w = hh * c.ar; c.x = W / 2 - c.w / 2 + o * c.w * 0.66; c.y = top + (availH - c.h) / 2;
        c.rz = 0; c.ry = -Math.sign(o) * a * 42; c.sc = 1 - 0.14 * a; c.d.style.zIndex = String(10 - Math.round(Math.abs(o) * 2));
      });
    } else {
      const hMax = availH * (layout === "fan" ? 0.8 : 0.85);
      let hs = cards.map((c) => Math.min(hMax, (availW / n - gap) / c.ar));
      const hh = Math.min(...hs);
      cards.forEach((c) => { c.h = hh; c.w = hh * c.ar; });
      rowW = cards.reduce((a, c) => a + c.w, 0) + gap * (n - 1) * (layout === "fan" ? -0.6 : 1);
      let x = (W - rowW) / 2;
      cards.forEach((c, i) => {
        c.x = x; c.y = top + (availH - c.h) / 2; x += c.w + (layout === "fan" ? -gap * 0.6 : gap);
        c.rz = layout === "fan" ? (i - (n - 1) / 2) * 5 : 0;
        if (layout === "fan") c.y += Math.abs(i - (n - 1) / 2) * H * 0.02;
      });
    }
    const times = tb ? ctx.times(tb.toks.map((t) => t.text)) : [];
    const at = cards.map((c, i) => c.it.at ?? (sc.stagger != null ? 0.15 + i * sc.stagger : 0.15 + (i / Math.max(1, n)) * Math.min(ctx.dur * 0.55, 0.35 * n)));
    return {
      update(lt, dur, exitK) {
        const drift = lerp(0, -W * 0.015, prog(lt, 0, dur));
        cards.forEach((c, i) => {
          const k = E.out5(prog(lt, at[i], 0.7));
          const fl = Math.sin(lt * 1.3 + i * 1.7) * 6 * S;
          c.d.style.width = c.w + "px"; c.d.style.height = c.h + "px";
          const ry = c.ry ? c.ry * lerp(1.4, 1, k) + Math.sin(lt * 0.8) * 4 : 0;   // coverflow: swing in, then breathe
          c.d.style.transform = tf({ x: c.x + drift, y: c.y + (1 - k) * H * 0.12 + fl, persp: 1800, rx: (1 - k) * 28, ry, rz: c.rz, s: lerp(0.9, 1, k) * (c.sc || 1) });
          setFx(c.d, clamp(k * 1.4) * (1 - exitK), (1 - k) * 16 * S + exitK * 12 * S);
          if (c.lab) {
            const lk = E.back(prog(lt, at[i] + 0.35, 0.45));
            c.lab.root.style.transform = tf({ x: c.x + drift + c.w / 2 - 300 * S, y: c.y + c.h - 90 * S + fl, s: lerp(0.7, 1, lk) });
            c.lab.update(lt, [], 0);
            c.lab.root.style.opacity = (clamp(lk * 2) * (1 - exitK)).toFixed(3);
          }
        });
        if (tb) tb.update(lt, times, exitK);
      },
      cues() { const c = at.map((t) => ({ t, name: "swish", gain: 0.25 })); if (tb) c.push(...tb.cues(times)); return c; },
      videos: cards.filter((c) => c.video).map((c) => ({ v: c.video, clipIn: c.it.in || 0, speed: c.it.speed || 1, offset: at[cards.indexOf(c)] })),
    };
  };

  // terminal: typed commands and their output
  B.terminal = (ctx) => {
    const sc = ctx.sc, portrait = H > W, light = isLight(sc.bg);
    let tb = null, top = H * 0.12;
    if (sc.text) {
      tb = TextBlock(ctx.root, sc.text, { size: sc.size || "m", color: light ? theme.ink : theme.paper, align: "center", vpos: "center",
        region: { x: W * 0.07, y: H * 0.06, w: W * 0.86, h: H * 0.16 }, mode: sc.mode });
      top = H * 0.27;
    }
    const ww = W * (sc.width || (portrait ? 0.92 : 0.72));
    let fs = (sc.fontSize || 40) * S * (portrait ? 0.8 : 1), lh = fs * 1.7;
    const lines = sc.lines || [];
    {
      const longest = Math.max(1, ...lines.map((l) => (l.cmd != null ? (l.prompt ?? "›").length + 1 + l.cmd.length : String(l.out).length)));
      fs = Math.min(fs, (ww - 76 * S) / (longest * 0.6)); lh = fs * 1.7;
    }
    const wh = Math.min(H - top - H * 0.07, Math.max(H * 0.34, 44 * S + 52 * S + lh * (lines.length + 0.6)));
    top = sc.text ? top : (H - wh) / 2;
    const wrap = el("div", "abs", ctx.root);
    const win = el("div", "win dark term", wrap);
    win.style.width = ww + "px"; win.style.height = wh + "px";
    if (!light) win.style.boxShadow = `0 0 0 1px rgba(255,255,255,.16), 0 ${30 * S}px ${90 * S}px rgba(0,0,0,.6), 0 0 ${120 * S}px ${hexA(theme.accent, 0.18)}`;
    const bar = el("div", "bar", win); bar.style.height = 44 * S + "px";
    [0, 1, 2].forEach((i) => { const d = el("div", "dot", bar); d.style.width = d.style.height = 12 * S + "px"; d.style.left = (20 + i * 20) * S + "px"; d.style.top = 16 * S + "px"; });
    const tt = el("div", "title", bar, esc(sc.title || "claude")); tt.style.fontSize = 15 * S + "px"; tt.style.lineHeight = 44 * S + "px";
    const body = el("div", "abs", win);
    body.style.transform = tf({ x: 34 * S, y: 44 * S + 26 * S });
    body.style.fontSize = fs + "px";
    // schedule
    let t = sc.startAt ?? 0.35;
    const rows = lines.map((ln) => {
      const r = { ln, e: el("div", "ln", body) };
      r.e.style.top = 0;
      if (ln.cmd != null) { r.start = ln.at ?? t; r.end = r.start + ln.cmd.length / (ln.cps || 26); t = r.end + (ln.pause ?? 0.35); }
      else { r.start = ln.at ?? t; r.end = r.start; t = r.start + (ln.pause ?? 0.22); }
      return r;
    });
    const span = t, fitTo = ctx.dur * 0.88;
    if (sc.fit !== false && span > fitTo) for (const r of rows) { if (r.ln.at == null) { r.start *= fitTo / span; r.end *= fitTo / span; } }
    const caret = el("div", "abs caret", body); caret.style.width = fs * 0.55 + "px"; caret.style.height = fs * 1.15 + "px"; caret.style.color = "#e6e6e9";
    const times = tb ? ctx.times(tb.toks.map((t) => t.text)) : [];
    const wx = (W - ww) / 2;
    return {
      update(lt, dur, exitK) {
        const enter = E.out5(prog(lt, 0, 0.6));
        const tilt = sc.cam === "tilt", tk = E.out3(prog(lt, 0, 1.1)), tp = prog(lt, 0, dur);   // tilt: swings up out of 3D and stays slightly angled
        wrap.style.transform = tf({ x: wx, y: top + (1 - enter) * H * 0.05, s: lerp(0.97, 1, enter) * lerp(1, 1.03, tp),
          persp: tilt ? 2000 : 0, rx: tilt ? lerp(28, 9, tk) : 0, ry: tilt ? lerp(-8, 6, E.inout3(tp)) : 0 });
        setFx(wrap, clamp(enter * 1.5) * (1 - exitK), (1 - enter) * 12 * S + exitK * 12 * S);
        let y = 0, cx = 0, cy = 0, typingNow = false;
        const visible = rows.filter((r) => lt >= r.start);
        const maxRows = Math.floor((wh - 80 * S) / lh);
        const scroll = Math.max(0, visible.length - maxRows);
        rows.forEach((r, i) => {
          const shown = lt >= r.start;
          r.e.style.display = shown && i >= scroll ? "block" : "none";
          if (!shown || i < scroll) return;
          r.e.style.top = y + "px";
          if (r.ln.cmd != null) {
            const n = Math.floor(prog(lt, r.start, r.end - r.start) * r.ln.cmd.length);
            r.e.innerHTML = `<span class="pr">${esc(r.ln.prompt ?? "›")} </span>${esc(r.ln.cmd.slice(0, n))}`;
            if (lt < r.end + 0.05) typingNow = true;
            cx = ((r.ln.prompt ?? "›").length + 1 + n) * fs * 0.6; cy = y;
          } else {
            const k = E.out3(prog(lt, r.start, 0.25));
            r.e.innerHTML = `<span class="${r.ln.accent ? "acc" : r.ln.dim ? "mut" : ""}">${esc(r.ln.out)}</span>`;
            r.e.style.opacity = k;
            cx = 0; cy = y + lh;
          }
          y += lh;
        });
        const blink = typingNow || Math.floor(lt * 2.2) % 2 === 0;
        caret.style.opacity = blink && exitK === 0 ? 0.9 : 0;
        caret.style.transform = tf({ x: cx, y: cy + (lh - fs * 1.15) / 2 - fs * 0.12 });
        if (tb) tb.update(lt, times, exitK);
      },
      cues() {
        const c = [{ t: 0.02, name: "swish", gain: 0.3 }];
        for (const r of rows) if (r.ln.cmd != null) {
          const n = r.ln.cmd.length;
          for (let i = 0; i < n; i += 1) c.push({ t: r.start + (i / n) * (r.end - r.start), name: "key" + (1 + (i % 3)), gain: 0.2 });
          c.push({ t: r.end + 0.12, name: "enter", gain: 0.35 });
        }
        if (tb) c.push(...tb.cues(times));
        return c;
      },
    };
  };

  // desktop chat app (the Claude Code desktop look): light window, sidebar, your message typed into the box and sent,
  // then the reply. lines: {cmd} = your message, {out} = a reply line, {out, tool: true} = a grey tool row (›)
  B.app = (ctx) => {
    const sc = ctx.sc, portrait = H > W, light = isLight(sc.bg);
    let tb = null, top = H * 0.12;
    if (sc.text) {
      tb = TextBlock(ctx.root, sc.text, { size: sc.size || "m", color: light ? theme.ink : theme.paper, align: "center", vpos: "center",
        region: { x: W * 0.07, y: H * 0.05, w: W * 0.86, h: H * 0.16 }, mode: sc.mode });
      top = H * 0.24;
    }
    const ww = W * (sc.width || (portrait ? 0.94 : 0.76)), wh = Math.min(H - top - H * 0.09, ww * (sc.aspect || 0.5));
    if (!sc.text) top = (H - wh) / 2;
    const wx = (W - ww) / 2;
    const wrap = el("div", "abs", ctx.root);
    const win = el("div", "app", wrap);
    win.style.width = ww + "px"; win.style.height = wh + "px"; win.style.borderRadius = 16 * S + "px";
    const f = (px) => px * S * (sc.scale || 1);
    // sidebar
    const sw = portrait ? 0 : ww * 0.2;
    const side = el("div", "app-side", win); side.style.width = sw + "px";
    [["#FF5F57", 0], ["#FEBC2E", 1], ["#28C840", 2]].forEach(([c, i]) => {
      const d = el("div", "abs", side); Object.assign(d.style, { width: f(13) + "px", height: f(13) + "px", borderRadius: "50%", background: c, transform: tf({ x: f(20 + i * 21), y: f(20) }) });
    });
    const row = (y, label, o = {}) => {
      const r = el("div", "app-row" + (o.on ? " on" : ""), side, esc(label));
      Object.assign(r.style, { left: f(12) + "px", right: f(12) + "px", top: y + "px", height: f(34) + "px", lineHeight: f(34) + "px", fontSize: f(15) + "px", padding: `0 ${f(10)}px`, borderRadius: f(8) + "px" });
      return r;
    };
    if (sw) {
      row(f(56), "+  New session");
      const lab = el("div", "app-lab", side, "Today"); Object.assign(lab.style, { left: f(22) + "px", top: f(112) + "px", fontSize: f(13) + "px" });
      row(f(136), sc.session || "Launch video", { on: true });
      [0.62, 0.48, 0.7, 0.55].forEach((wf, i) => {
        const b = el("div", "app-skel", side);
        Object.assign(b.style, { left: f(22) + "px", top: f(186 + i * 36) + "px", width: (sw - f(44)) * wf + "px", height: f(11) + "px", borderRadius: f(4) + "px" });
      });
    }
    // main column
    const main = el("div", "app-main", win); main.style.left = sw + "px"; main.style.width = ww - sw + "px";
    const title = el("div", "app-title", main, esc(sc.title || sc.session || "Launch video") + ` <span style="opacity:.5">&#x2304;</span>`);
    Object.assign(title.style, { left: f(22) + "px", top: f(16) + "px", fontSize: f(17) + "px" });
    const colW = (ww - sw) * 0.8, colX = ((ww - sw) - colW) / 2;
    const inH = f(66), inY = wh - inH - f(22);
    const box = el("div", "app-input", main);
    Object.assign(box.style, { left: colX + "px", top: inY + "px", width: colW + "px", height: inH + "px", borderRadius: f(16) + "px" });
    const plus = el("div", "app-ph", box, "+"); Object.assign(plus.style, { left: f(18) + "px", top: 0, lineHeight: inH + "px", fontSize: f(24) + "px" });
    const field = el("div", "app-field", box); Object.assign(field.style, { left: f(50) + "px", top: 0, lineHeight: inH + "px", fontSize: f(19) + "px" });
    const caret = el("div", "abs", box); Object.assign(caret.style, { width: f(2) + "px", height: f(24) + "px", background: "#1F1E1D" });
    const feed = el("div", "abs", main); feed.style.left = colX + "px"; feed.style.width = colW + "px";
    const feedTop = f(70), feedH = inY - feedTop - f(16);
    // schedule: type into the box, send, then the reply line by line
    let t = sc.startAt ?? 0.3;
    const rows = (sc.lines || []).map((ln) => {
      const r = { ln };
      if (ln.cmd != null) { r.start = ln.at ?? t; r.end = r.start + ln.cmd.length / (ln.cps || 24); t = r.end + (ln.pause ?? 0.3); }
      else { r.start = ln.at ?? t; r.end = r.start; t = r.start + (ln.pause ?? (ln.tool ? 0.32 : 0.24)); }
      r.e = el("div", ln.cmd != null ? "app-you" : ln.tool ? "app-tool" : "app-say" + (ln.accent ? " acc" : ""), feed);
      r.e.textContent = ln.cmd != null ? ln.cmd : ln.out + (ln.tool ? "  ›" : "");
      if (ln.cmd != null) Object.assign(r.e.style, { fontSize: f(21) + "px", padding: `${f(11)}px ${f(18)}px`, borderRadius: f(18) + "px" });
      else r.e.style.fontSize = (ln.tool ? f(19) : f(21)) + "px";
      return r;
    });
    const span = t, fitTo = ctx.dur * 0.88;
    if (sc.fit !== false && span > fitTo) for (const r of rows) if (r.ln.at == null) { r.start *= fitTo / span; r.end *= fitTo / span; }
    const gap = f(14);
    const times = tb ? ctx.times(tb.toks.map((x) => x.text)) : [];
    let sized = false;
    return {
      update(lt, dur, exitK) {
        if (!sized) { for (const r of rows) { r.w = r.e.offsetWidth; r.h = r.e.offsetHeight; } sized = true; }
        const enter = E.out5(prog(lt, 0, 0.6));
        const tilt = sc.cam === "tilt", tk = E.out3(prog(lt, 0, 1.1)), tp = prog(lt, 0, dur);
        wrap.style.transform = tf({ x: wx, y: top + (1 - enter) * H * 0.05, s: lerp(0.97, 1, enter) * lerp(1, 1.03, tp),
          persp: tilt ? 2000 : 0, rx: tilt ? lerp(24, 8, tk) : 0, ry: tilt ? lerp(-4, 4, E.inout3(tp)) : 0 });
        setFx(wrap, clamp(enter * 1.5) * (1 - exitK), (1 - enter) * 12 * S + exitK * 12 * S);
        // the input box: whatever is being typed now (cleared once it's sent)
        const typing = rows.find((r) => r.ln.cmd != null && lt >= r.start && lt < r.end + 0.15);
        const n = typing ? Math.floor(prog(lt, typing.start, typing.end - typing.start) * typing.ln.cmd.length) : 0;
        field.textContent = typing ? typing.ln.cmd.slice(0, n) : "Type / for commands";
        field.classList.toggle("ph", !typing);
        const blink = typing || Math.floor(lt * 2.2) % 2 === 0;
        caret.style.opacity = blink && exitK === 0 ? 0.85 : 0;
        caret.style.transform = tf({ x: f(50) + (typing ? field.offsetWidth : 0) + f(2), y: (inH - f(24)) / 2 });
        // the feed: sent messages and reply lines, newest at the bottom once it fills
        let y = 0; const shown = [];
        for (const r of rows) {
          const at = r.ln.cmd != null ? r.end + 0.15 : r.start;
          if (lt < at) { r.e.style.opacity = 0; continue; }
          shown.push({ r, at, y }); y += r.h + gap;
        }
        const over = Math.max(0, y - gap - feedH);
        feed.style.top = feedTop - over + "px";
        for (const { r, at, y: ry } of shown) {
          const k = E.out3(prog(lt, at, 0.3));
          r.e.style.opacity = k.toFixed(3);
          const x = r.ln.cmd != null ? colW - r.w : 0;
          r.e.style.transform = tf({ x, y: ry + (1 - k) * f(12) });
        }
        if (tb) tb.update(lt, times, exitK);
      },
      cues() {
        const c = [{ t: 0.02, name: "swish", gain: 0.3 }];
        for (const r of rows) if (r.ln.cmd != null) {
          const n = r.ln.cmd.length;
          for (let i = 0; i < n; i += 1) c.push({ t: r.start + (i / n) * (r.end - r.start), name: "key" + (1 + (i % 3)), gain: 0.18 });
          c.push({ t: r.end + 0.12, name: "enter", gain: 0.35 });
        } else c.push({ t: r.start, name: r.ln.tool ? "click" : "pop", gain: 0.12 });
        if (tb) c.push(...tb.cues(times));
        return c;
      },
    };
  };

  // flow chips: 2.7K Clicks -> 6.5% -> 129 Leads ...
  B.chips = (ctx) => {
    const sc = ctx.sc, light = isLight(sc.bg);
    let fs = (sc.fontSize || 64) * S * (H > W ? 0.8 : 1);
    if (!sc.fontSize) {   // few short chips: grow them to fill ~80% of the width (up to 2x)
      const est = (sc.items || []).reduce((a, it) => a + (/^(→|->)/.test(it) ? 1.67 : it.length * 0.52 + 0.92) * fs, 0);
      if (est < W * 0.8) fs *= Math.min(1.9, (W * 0.8) / est);
    }
    const row = el("div", "abs", ctx.root);
    const chips = (sc.items || []).map((it) => {
      const arrow = it.startsWith("→") || it.startsWith("->");
      const d = el("div", "chip " + (arrow ? "arrow" : "box"), row);
      d.style.fontSize = fs + "px"; d.style.fontWeight = 500;
      if (!light && !arrow) { d.style.background = "#151518"; d.style.boxShadow = "0 0 0 1px rgba(255,255,255,.08)"; }
      if (arrow) {
        const pct = it.replace(/^(→|->)\s*/, "");
        d.style.width = fs * 1.55 + "px"; d.style.height = fs * 2.1 + "px"; d.style.borderRadius = fs * 0.3 + "px";
        el("div", "", d, "→").style.fontSize = fs * 0.9 + "px";
        if (pct) { const p = el("div", "pct", d, esc(pct)); p.style.fontSize = fs * 0.62 + "px"; p.style.padding = `${fs * 0.06}px ${fs * 0.22}px`; p.style.marginTop = fs * 0.12 + "px"; }
      } else {
        const m = it.match(/^(\S+)\s+(.*)$/) || [null, it, ""];
        d.innerHTML = `<span>${esc(m[1])}</span>${m[2] ? `<span class="lbl">&nbsp;${esc(m[2])}</span>` : ""}`;
        d.style.height = fs * 1.5 + "px"; d.style.padding = `0 ${fs * 0.4}px`; d.style.borderRadius = fs * 0.22 + "px";
      }
      return { d, arrow };
    });
    const gap = fs * 0.12;
    let widths = null;
    const n = chips.length;
    const at = chips.map((_, i) => (sc.at && sc.at[i] != null ? sc.at[i] : 0.2 + (i / Math.max(1, n - 1)) * Math.min(ctx.dur * 0.75, n * 0.45)));
    if (!sc.at && ctx.words.length) {   // a chip appears when its label is spoken (voice ~ "voices"); arrows just before
      let j = 0, prev = 0.1;
      chips.forEach((c, i) => {
        if (c.arrow) return;
        const key = norm(sc.items[i].split(/\s+/).pop()).slice(0, 4);
        const q = ctx.words.findIndex((w, k) => k >= j && key && norm(w.w).startsWith(key));
        at[i] = q >= 0 ? Math.max(prev, ctx.words[q].s - 0.06) : (i === 0 ? 0.1 : prev + 0.3);
        if (q >= 0) j = q + 1;
        prev = at[i];
      });
      chips.forEach((c, i) => { if (c.arrow) at[i] = Math.max(0.05, (at[i + 1] ?? at[i - 1] + 0.3) - 0.18); });
    }
    return {
      update(lt, dur, exitK) {
        if (!widths) widths = chips.map((c) => c.d.offsetWidth);
        let x = 0; const xs = [];
        chips.forEach((c, i) => { xs.push(x); x += widths[i] + gap; });
        // camera follows the newest chip
        let focusX = 0;
        chips.forEach((c, i) => { const k = E.out3(prog(lt, at[i], 0.5)); if (k > 0) focusX = lerp(focusX, xs[i] + widths[i] / 2, k); });
        const total = x - gap;
        const offset = total < W * 0.84 ? (W - total) / 2 : Math.min(W * 0.08, W * 0.62 - focusX);
        chips.forEach((c, i) => {
          const k = E.back(prog(lt, at[i], 0.45)), k0 = prog(lt, at[i], 0.2);
          const hgt = c.arrow ? fs * 2.1 : fs * 1.5;
          c.d.style.transform = tf({ x: offset + xs[i], y: H / 2 - hgt / 2, s: lerp(0.8, 1, k) });
          setFx(c.d, k0, (1 - k0) * 10 * S);
        });
        setFx(row, 1 - exitK, exitK * 14 * S);
      },
      cues: () => at.map((t, i) => ({ t, name: chips[i].arrow ? "swish" : "pop", gain: chips[i].arrow ? 0.25 : 0.4 })),
    };
  };


  // floating tag chips around a centred line (the seo.party hero look). items: "Claude Code", "# Link building", "seo-audit ✓"
  B.tags = (ctx) => {
    const sc = ctx.sc, light = isLight(sc.bg), portrait = H > W;
    const tb = TextBlock(ctx.root, sc.text ?? sc.vo, { size: sc.size || "l", color: light ? theme.ink : theme.paper, align: "center", vpos: "center",
      region: portrait ? { x: W * 0.07, y: H * 0.4, w: W * 0.86, h: H * 0.2 } : { x: W * 0.28, y: 0, w: W * 0.44, h: H }, mode: sc.mode, weight: sc.weight || 600 });
    const times = ctx.times(tb.toks.map((t) => t.text));
    const fs = (sc.fontSize || 34) * S * (portrait ? 0.9 : 1);
    const rnd = (k) => { const x = Math.sin(k * 91.7 + 13.1) * 43758.5453; return x - Math.floor(x); };
    const items = sc.items || [];
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", W); svg.setAttribute("height", H); svg.style.position = "absolute"; svg.style.left = 0; svg.style.top = 0;
    ctx.root.appendChild(svg);
    const tags = items.map((it, i) => {
      const d = el("div", "tag" + (it.dark ? " tag-dark" : ""), ctx.root);
      const label = (typeof it === "string" ? it : it.label);
      const hash = label.startsWith("# "), check = label.endsWith(" ✓");
      const text = label.replace(/^# /, "").replace(/ ✓$/, "");
      d.style.fontSize = fs + "px"; d.style.padding = `${fs * 0.42}px ${fs * 0.62}px`;
      d.innerHTML = (hash ? `<span class="hash">#</span>` : "") + `<span>${esc(text)}</span>` +
        (check ? `<span class="check" style="width:${fs * 0.72}px;height:${fs * 0.72}px;font-size:${fs * 0.45}px">✓</span>` : "");
      // two columns either side of the text (landscape) or bands above/below (portrait)
      const side = i % 2, row = Math.floor(i / 2), rows = Math.ceil(items.length / 2);
      const f = rows > 1 ? row / (rows - 1) : 0.5;
      let x, y;
      if (portrait) { x = W * (0.08 + rnd(i) * 0.5); y = side ? H * (0.66 + f * 0.24) : H * (0.08 + f * 0.24); }
      else { x = side ? W * (0.71 + rnd(i) * 0.12) : W * (0.03 + rnd(i) * 0.12); y = H * (0.14 + f * 0.68) + (rnd(i + 7) - 0.5) * H * 0.06; }
      const at = typeof it === "object" && it.at != null ? it.at : 0.1 + i * (sc.stagger ?? 0.12);
      return { d, x, y, rz: (rnd(i + 3) - 0.5) * 9, side, at };
    });
    const lines = [];
    tags.forEach((t, i) => { const n = tags[i + 2]; if (n) { const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
      l.setAttribute("stroke", light ? "#E1E2E5" : "#333438"); l.setAttribute("stroke-width", 1.5 * S); l.setAttribute("stroke-dasharray", `${4 * S} ${5 * S}`);
      svg.appendChild(l); lines.push({ l, a: t, b: n }); } });
    let sized = false;
    return {
      update(lt, dur, exitK) {
        if (!sized) {   // keep chips inside the frame and off the centred line
          const tl = tb.width ? (W - tb.width) / 2 - W * 0.02 : W * 0.28, tr = tb.width ? (W + tb.width) / 2 + W * 0.02 : W * 0.72;
          tags.forEach((t) => {
            t.w = t.d.offsetWidth; t.h = t.d.offsetHeight;
            if (!portrait) { if (t.side) t.x = Math.min(Math.max(t.x, tr), W * 0.97 - t.w); else t.x = Math.max(W * 0.03, Math.min(t.x, tl - t.w)); }
            else t.x = Math.min(t.x, W * 0.95 - t.w);
          });
          sized = true;
        }
        for (const t of tags) {
          const k = E.out5(prog(lt, t.at, 0.7));
          const fx = Math.sin(lt * 0.7 + t.rz) * 6 * S, fy = Math.cos(lt * 0.9 + t.rz) * 5 * S;
          t.cx = t.x + t.w / 2 + fx; t.cy = t.y + t.h / 2 + fy + (1 - k) * 30 * S;
          t.d.style.transform = tf({ x: t.x + fx, y: t.y + fy + (1 - k) * 30 * S, rz: t.rz, s: lerp(0.9, 1, k) });
          setFx(t.d, clamp(k * 1.3) * (1 - exitK), (1 - k) * 10 * S + exitK * 10 * S);
          t.k = k;
        }
        for (const { l, a, b } of lines) {
          l.setAttribute("x1", a.cx); l.setAttribute("y1", a.cy); l.setAttribute("x2", b.cx); l.setAttribute("y2", b.cy);
          l.style.opacity = (Math.min(a.k, b.k) * 0.9 * (1 - exitK)).toFixed(3);
        }
        tb.update(lt, times, exitK);
      },
      cues() { return [...tags.map((t) => ({ t: t.at, name: "pop", gain: 0.18 })), ...tb.cues(times)]; },
    };
  };

  // twinkling four-point stars around the frame (the app-ad style); kept off the middle where the subject is
  function sparkles(root, n, seed = 1) {
    const rnd = (k) => { const x = Math.sin(k * 127.1 + seed * 311.7) * 43758.5453; return x - Math.floor(x); };
    const stars = [];
    for (let i = 0; i < n; i++) {
      let x = rnd(i * 3 + 1), y = rnd(i * 3 + 2);
      if (Math.abs(x - 0.5) < 0.22 && Math.abs(y - 0.5) < 0.3) x = x < 0.5 ? x - 0.22 : x + 0.22;
      const d = el("div", "abs", root), sz = (10 + rnd(i * 3 + 3) * 22) * S;
      d.innerHTML = `<svg width="${sz}" height="${sz}" viewBox="0 0 20 20"><path d="M10 0 C11 7 13 9 20 10 C13 11 11 13 10 20 C9 13 7 11 0 10 C7 9 9 7 10 0Z" fill="#fff"/></svg>`;
      d.style.transform = tf({ x: clamp(x, 0.03, 0.97) * W, y: clamp(y, 0.05, 0.95) * H });
      stars.push({ d, ph: rnd(i + 9) * 6.28, sp: 1.2 + rnd(i + 5) * 2.2 });
    }
    return (lt, k = 1) => { for (const s of stars) { const tw = (Math.sin(lt * s.sp + s.ph) + 1) / 2; s.d.style.opacity = (k * (0.25 + 0.75 * tw * tw)).toFixed(3); } };
  }

  // 3D phone (the app-ad style): a screen recording or screenshot inside an iPhone that a 3D camera flies around.
  // cam: "rise" | "hero" | "flyover" | "closeup" (with `to`) | keys [{at, rx, ry, rz, x, y, s, blur}] (x/y: fractions of the frame)
  B.phone = (ctx) => {
    const sc = ctx.sc, light = isLight(sc.bg), portrait = H > W;
    const media = ctx.media(sc.src);
    let tb = null, cx0 = 0;
    if (sc.text) {
      const side = sc.side || "left";
      const region = side === "right" ? { x: W * 0.56, y: 0, w: W * 0.38, h: H } : { x: W * 0.06, y: 0, w: W * 0.38, h: H };
      tb = TextBlock(ctx.root, sc.text, { size: sc.size || "m", color: light ? theme.ink : theme.paper, align: "left", vpos: "center", region, mode: sc.mode, weight: sc.weight });
      cx0 = (side === "right" ? -0.2 : 0.2) * W;
    }
    const times = tb ? ctx.times(tb.toks.map((x) => x.text)) : [];
    const stars = sc.sparkles ? sparkles(ctx.root, sc.sparkles, sc.seed || 3) : null;
    const view = el("div", "layer", ctx.root);
    view.style.perspective = (sc.persp || 1900) * S + "px";
    const world = el("div", "l3", view);
    // the phone is laid out at the recording's own pixel size and scaled down by the camera, so close-ups stay sharp
    // (Chrome rasterises a video at its layout size before the 3D transform scales it)
    const target = H * (sc.height || (portrait ? 0.66 : 0.92)), L = Math.max(1, media.h / target);
    const sh = target * L, swd = sh * (media.w / media.h);          // screen size (layout px)
    const bz = swd * 0.035, bw = swd + bz * 2, bh = sh + bz * 2, r = bw * 0.155;
    const slab = (z, col) => { const d = el("div", "l3 phone-slab", world); Object.assign(d.style, { width: bw + "px", height: bh + "px", borderRadius: r + "px", background: col, transform: `translate3d(${-bw / 2}px, ${-bh / 2}px, ${z}px)` }); return d; };
    const depth = bw * 0.075;
    for (let i = 7; i >= 1; i--) slab(-depth * (i / 7), i === 7 ? "#1a1b20" : `linear-gradient(135deg, #8d9099, #3b3d44 45%, #a7aab2 70%, #34363c)`);
    const body = slab(0, "linear-gradient(135deg, #b9bcc4, #50535b 40%, #c9ccd3 65%, #45474e)");
    body.classList.add("phone-body");
    const bezel = el("div", "abs phone-bezel", body); Object.assign(bezel.style, { left: bz * 0.25 + "px", top: bz * 0.25 + "px", width: bw - bz * 0.5 + "px", height: bh - bz * 0.5 + "px", borderRadius: r * 0.96 + "px" });
    const screen = el("div", "abs phone-screen", body); Object.assign(screen.style, { left: bz + "px", top: bz + "px", width: swd + "px", height: sh + "px", borderRadius: r * 0.84 + "px" });
    const m = media.make(screen); m.style.width = "100%"; m.style.height = "100%"; m.style.objectFit = "cover";
    if (sc.status !== false) {   // a clean status bar over the recording's own (8:00, island, signal, battery)
      const dark = sc.status === "dark";
      const bar = el("div", "abs", screen); Object.assign(bar.style, { left: 0, top: 0, width: swd + "px", height: sh * 0.056 + "px", background: dark ? "#000" : "#fff" });
      const fg = dark ? "#fff" : "#000", fs = sh * 0.02;
      // time and icons sit centred in the "ears" either side of the island, clear of the rounded corners (like iOS)
      const tm = el("div", "abs", bar, esc(sc.time || "8:00")); Object.assign(tm.style, { left: swd * 0.06 + "px", width: swd * 0.26 + "px", textAlign: "center", top: sh * 0.019 + "px", fontSize: fs + "px", fontWeight: 600, color: fg, letterSpacing: "-0.01em", fontFamily: "Inter, system-ui, sans-serif" });
      const rt = el("div", "abs", bar); Object.assign(rt.style, { left: "auto", right: swd * 0.09 + "px", top: sh * 0.024 + "px", display: "flex", gap: fs * 0.3 + "px", alignItems: "flex-end" });
      [0.35, 0.55, 0.75, 0.95].forEach((hh) => { const b = el("div", "", rt); Object.assign(b.style, { width: fs * 0.18 + "px", height: fs * 0.62 * hh + "px", background: fg, borderRadius: fs * 0.05 + "px" }); });
      const bat = el("div", "", rt); Object.assign(bat.style, { width: fs * 1.25 + "px", height: fs * 0.6 + "px", border: `${fs * 0.07}px solid ${fg}`, borderRadius: fs * 0.18 + "px", marginLeft: fs * 0.25 + "px", boxSizing: "border-box", padding: fs * 0.06 + "px" });
      el("div", "", bat).style.cssText = `width:80%;height:100%;background:${fg};border-radius:${fs * 0.08}px`;
    }
    const island = el("div", "abs", screen); Object.assign(island.style, { left: swd * 0.357 + "px", top: sh * 0.012 + "px", width: swd * 0.286 + "px", height: sh * 0.038 + "px", borderRadius: sh + "px", background: "#000" });
    const glare = el("div", "abs phone-glare", screen); Object.assign(glare.style, { left: 0, top: 0, width: swd + "px", height: sh + "px" });
    const fit = sc.fill || 0.7;
    const zoomTo = (rect, k) => {            // camera centred on a rect of the screen, the rect filling `fill` of the frame height
      const [rx, ry, rw, rh] = rect, s = Math.min((H * fit) / (rh * sh), (W * fit) / (rw * swd));
      return { ...k, s, x: -(((rx + rw / 2) - 0.5) * swd * s) / W, y: -(((ry + rh / 2) - 0.5) * sh * s) / H, _layout: true };
    };
    const d = ctx.dur, c = sc.cam || "hero";
    const keys = Array.isArray(c) ? c.map((k) => (k.to ? zoomTo(k.to, k) : k))
      : c === "rise" ? [{ at: 0, rx: 58, ry: 0, rz: 0, s: 0.78, y: 0.42, blur: 14 }, { at: Math.min(1.1, d * 0.5), rx: 14, ry: -10, rz: 3, s: 1, y: 0.02, blur: 0, ease: "out5" }, { at: d, rx: 14, ry: 16, rz: -4, s: 1.05, y: 0 }]
      : c === "flyover" ? [{ at: 0, rx: 42, ry: 26, rz: -32, s: 2.1, x: 0.24, y: 0.34, blur: 8 }, { at: d, rx: 30, ry: 14, rz: -24, s: 1.55, x: -0.02, y: 0.08, blur: 0, ease: "out3" }]
      : c === "closeup" ? [zoomTo(sc.to || [0, 0.6, 1, 0.4], { at: 0, rx: 36, ry: -6, rz: 0, blur: 6 }), zoomTo(sc.to || [0, 0.6, 1, 0.4], { at: d, rx: 22, ry: 4, rz: 0, blur: 0, ease: "out3" })]
      : [{ at: 0, rx: 26, ry: -40, rz: 11, s: 0.86, y: 0.06, blur: 7 }, { at: Math.min(0.9, d * 0.45), rx: 16, ry: -24, rz: 7, s: 1, y: 0, blur: 0, ease: "out5" }, { at: d, rx: 12, ry: -14, rz: 5, s: 1.06, y: 0 }];
    for (const q of keys) if (!q._layout) q.s = (q.s ?? 1) / L;   // preset/plan scales are relative to the on-screen size
    if (sc.flip) for (const q of keys) { if (q.ry != null) q.ry = -q.ry; if (q.rz != null) q.rz = -q.rz; if (q.x != null) q.x = -q.x; }   // mirror the move
    const amp = sc.amp ?? (P.look === "clean" && !Array.isArray(c) ? 0.6 : 1);   // calmer angles for the clean look
    if (amp !== 1) for (const q of keys) for (const a of ["rx", "ry", "rz"]) if (q[a] != null) q[a] *= amp;
    body.style.boxShadow = light ? `0 ${24 * S * L}px ${70 * S * L}px rgba(0,0,0,.16)`   // a soft shadow on white, not a smudge
      : `0 ${40 * S * L}px ${120 * S * L}px rgba(0,0,0,.45)`;
    return {
      update(lt, dur, exitK) {
        const k = keyAt(keys, lt, ["rx", "ry", "rz", "x", "y", "s", "blur"]);
        const enter = E.out3(prog(lt, 0, 0.35));
        world.style.transform = `translate(${W / 2 + cx0 + (k.x || 0) * W}px, ${H / 2 + (k.y || 0) * H}px) rotateX(${(k.rx || 0).toFixed(3)}deg) rotateY(${(k.ry || 0).toFixed(3)}deg) rotateZ(${(k.rz || 0).toFixed(3)}deg) scale(${(k.s ?? 1).toFixed(4)})`;
        glare.style.backgroundPosition = `${(50 + (k.ry || 0) * 2.2).toFixed(1)}% 0`;
        setFx(view, enter * (1 - exitK), (k.blur || 0) * S + exitK * 14 * S);
        if (stars) stars(lt, enter * (1 - exitK));
        if (tb) tb.update(lt, times, exitK);
      },
      cues() { const cc = [{ t: 0.02, name: "whoosh", gain: 0.35 }]; if (tb) cc.push(...tb.cues(times)); return cc; },
      videos: media.video ? [{ v: media.video, clipIn: sc.in || 0, speed: sc.speed || 1 }] : [],
    };
  };

  // exploded 3D view: the screenshot tips back like a page on a table and what was pulled from it rises off it.
  // items: {kind: "image", src} | {kind: "colors", colors: ["#2563EB", ...]} | {kind: "font", font, sample: "Aa"}
  //        each with label, from: [x, y] (where on the screenshot it came from), word (spoken word that lifts it), lift (px)
  B.layers = (ctx) => {
    const sc = ctx.sc, light = isLight(sc.bg), portrait = H > W;
    const media = ctx.media(sc.src);
    let tb = null;
    if (sc.text) tb = TextBlock(ctx.root, sc.text, { size: sc.size || "m", color: light ? theme.ink : theme.paper, align: "center", vpos: "center",
      region: { x: W * 0.07, y: H * (portrait ? 0.08 : 0.05), w: W * 0.86, h: H * (portrait ? 0.14 : 0.15) }, mode: sc.mode });
    const times = tb ? ctx.times(tb.toks.map((t) => t.text)) : [];
    const view = el("div", "layer", ctx.root);
    view.style.perspective = (sc.persp || 2200) * S + "px"; view.style.perspectiveOrigin = "50% 30%";
    const world = el("div", "l3", view);
    const pw = W * (sc.width || (portrait ? 0.86 : 0.54)), ph = pw * (media.h / media.w);
    const base = el("div", "l3 l3base", world);
    Object.assign(base.style, { width: pw + "px", height: ph + "px", transform: `translate3d(${-pw / 2}px, ${-ph / 2}px, 0)` });
    const bm = media.make(base); bm.style.width = "100%"; bm.style.height = "100%";
    const items = (sc.items || []).map((it, i) => {
      const card = el("div", "l3 l3card", world);
      card.style.padding = `${24 * S}px ${30 * S}px`; card.style.borderRadius = 22 * S + "px"; card.style.gap = 14 * S + "px";
      if (it.kind === "image") {
        const im = el("img", "", card); im.src = url(it.src);
        Object.assign(im.style, { width: (it.size || 116) * S + "px", height: (it.size || 116) * S + "px", objectFit: "contain", borderRadius: 18 * S + "px" });
      } else if (it.kind === "colors") {
        const row = el("div", "l3row", card); row.style.gap = 12 * S + "px";
        for (const c of it.colors || []) el("div", "l3sw", row).style.cssText =
          `width:${86 * S}px;height:${86 * S}px;border-radius:${20 * S}px;background:${c};box-shadow:inset 0 0 0 ${1.5 * S}px rgba(0,0,0,.1)`;
      } else if (it.kind === "font") {
        const a = el("div", "", card, esc(it.sample || "Aa"));
        a.style.cssText = `font-family:"${it.font}";font-size:${(it.size || 120) * S}px;line-height:1;letter-spacing:-0.03em;color:${theme.ink}`;
      }
      if (it.label) { const lab = el("div", "l3lab", card, esc(it.label)); lab.style.fontSize = 24 * S + "px"; }
      const [fx, fy] = it.from || [0.2 + 0.3 * i, 0.5];
      const shadow = el("div", "l3", world), beam = el("div", "l3 l3beam", world), ring = el("div", "l3 l3ring", world);
      beam.style.width = 3 * S + "px";
      beam.style.background = `repeating-linear-gradient(to bottom, ${theme.accent} 0 ${8 * S}px, transparent ${8 * S}px ${15 * S}px)`;
      ring.style.borderColor = theme.accent; ring.style.borderWidth = 3 * S + "px";
      let at = it.at;
      if (at == null) {   // lift when its word is spoken ("logo", "colors", "font")
        const key = norm(it.word || "").slice(0, 4);
        const q = key ? ctx.words.findIndex((w) => norm(w.w).startsWith(key)) : -1;
        at = q >= 0 ? ctx.words[q].s - 0.12 : 0.9 + i * 0.5;
      }
      return { it, card, shadow, beam, ring, x: (fx - 0.5) * pw, y: (fy - 0.5) * ph, lift: (it.lift || 230 + i * 50) * S, at };
    });
    const RX = sc.rx ?? 56, RZ = sc.rz ?? -26, tipAt = sc.tipAt ?? 0.1, tipDur = sc.tipDur ?? 1.0;
    let sized = false;
    return {
      update(lt, dur, exitK) {
        if (!sized) { for (const c of items) { c.w = c.card.offsetWidth; c.h = c.card.offsetHeight; } sized = true; }
        const enter = E.out5(prog(lt, 0, 0.6)), tip = E.inout3(prog(lt, tipAt, tipDur));
        const rx = lerp(0, RX, tip), rz = lerp(0, RZ, tip) + 7 * prog(lt, tipAt, dur) * tip;   // tip back, then a slow orbit
        const s = lerp(0.96, 1, enter) * lerp(1, sc.scale ?? 1.12, tip);
        const cy = H * (sc.text ? (portrait ? 0.58 : 0.6) : 0.5) + lerp(0, H * (sc.drop ?? 0.02), tip);
        world.style.transform = `translate(${W / 2}px, ${cy}px) rotateX(${rx.toFixed(3)}deg) rotateZ(${rz.toFixed(3)}deg) scale(${s.toFixed(4)})`;
        for (const c of items) {
          const k = E.out5(prog(lt, c.at, 0.85)), kb = E.back(prog(lt, c.at, 0.7)), z = c.lift * k;
          c.card.style.transform = `translate3d(${c.x - c.w / 2}px, ${c.y - c.h / 2}px, ${z.toFixed(2)}px) rotateZ(${-rz}deg) rotateX(${-rx}deg) scale(${lerp(0.6, 1, kb).toFixed(4)})`;
          c.card.style.opacity = clamp(k * 2.2).toFixed(3);
          Object.assign(c.beam.style, { height: Math.max(0, z - c.h * 0.35) + "px", transformOrigin: "50% 0",
            transform: `translate3d(${c.x - 1.5 * S}px, ${c.y}px, 0) rotateX(90deg)`, opacity: (clamp(k * 3) * 0.9).toFixed(3) });
          const sw = c.w * 0.9, sh = c.h * 0.7;
          Object.assign(c.shadow.style, { width: sw + "px", height: sh + "px", borderRadius: "50%", transform: `translate3d(${c.x - sw / 2}px, ${c.y - sh / 2}px, 1px)`,
            background: "radial-gradient(closest-side, rgba(0,0,0,.28), transparent)", opacity: (k * 0.9).toFixed(3) });
          const rk = prog(lt, c.at, 0.9), rr = lerp(30, 260, E.out3(rk)) * S;
          Object.assign(c.ring.style, { width: rr + "px", height: rr + "px", transform: `translate3d(${c.x - rr / 2}px, ${c.y - rr / 2}px, 2px)`,
            opacity: (rk > 0 && rk < 1 ? (1 - rk) * 0.9 : 0).toFixed(3) });
        }
        setFx(view, clamp(enter * 1.5) * (1 - exitK), (1 - enter) * 10 * S + exitK * 12 * S);
        if (tb) tb.update(lt, times, exitK);
      },
      cues() {
        const c = [{ t: 0.05, name: "swish", gain: 0.3 }, { t: tipAt + 0.1, name: "whoosh", gain: 0.25 }];
        for (const it of items) c.push({ t: it.at, name: "pop", gain: 0.4 }, { t: it.at + 0.05, name: "swish", gain: 0.2 });
        if (tb) c.push(...tb.cues(times));
        return c;
      },
    };
  };

  // ---------- media ----------
  const mediaCache = {};
  async function preload(src) {
    if (!src || mediaCache[src]) return;
    if (isVideo(src)) {
      const v = document.createElement("video");
      v.muted = true; v.preload = "auto"; v.playsInline = true; v.src = url(src);
      await new Promise((ok, bad) => { v.onloadeddata = ok; v.onerror = () => bad(new Error("cannot load " + src)); });
      mediaCache[src] = { w: v.videoWidth, h: v.videoHeight, src, video: true };
    } else {
      const im = new Image(); im.src = url(src);
      await im.decode().catch(() => { throw new Error("cannot load " + src); });
      mediaCache[src] = { w: im.naturalWidth, h: im.naturalHeight, src };
    }
  }
  function media(src) {
    const m = mediaCache[src];
    if (!m) throw new Error("missing media " + src);
    const out = { w: m.w, h: m.h, video: null };
    out.make = (parent) => {
      if (m.video) { const v = el("video", "", parent); v.muted = true; v.preload = "auto"; v.src = url(src); out.video = v; videos.push(v); return v; }
      const im = el("img", "", parent); im.src = url(src); im.draggable = false; return im;
    };
    return out;
  }

  // ---------- timeline ----------
  function estimate(plan) {
    let t = 0.25; const out = [];
    for (const sc of plan.scenes) {
      const words = spoken(sc.vo || "");
      const start = t, vs = t + (sc.pre ?? 0.1);
      const ws = words.map((w, i) => ({ w, s: vs + i / WPS, e: vs + (i + 0.85) / WPS }));
      const ve = words.length ? vs + words.length / WPS : vs;
      t = Math.max(start + (sc.dur || 0), ve + (sc.post ?? (words.length ? 0.3 : 0)));
      if (!words.length && !sc.dur) t = start + 1.2;
      out.push({ start, end: t, vo_start: vs, vo_end: ve, words: ws });
    }
    const last = plan.scenes[plan.scenes.length - 1];
    out[out.length - 1].end += last ? (last.hold ?? 1.0) : 0;
    return { duration: out[out.length - 1].end, scenes: out, estimated: true };
  }

  // ---------- load / seek ----------
  window.__load = async (data) => {
    P = data.plan; BASE = data.base.endsWith("/") ? data.base : data.base + "/";
    [W, H] = FORMATS[P.format || "16:9"];
    S = Math.min(W, H) / 1080;
    theme = Object.assign({ accent: "#0DDD4B", dark: "#000000", light: "#FDFDFD", ink: "#0B0B0C", paper: "#ECEDF1", dotColor: "#E4E4E7" }, P.theme || {});
    brand = Object.assign({ name: "Product" }, P.brand || {});
    blurK = P.look === "clean" ? 0 : 1;
    stage = document.getElementById("stage");
    stage.style.width = W + "px"; stage.style.height = H + "px";
    const root = document.documentElement.style;
    root.setProperty("--s", S); root.setProperty("--accent", theme.accent);
    root.setProperty("--accent-hi", shade(theme.accent, 0.6)); root.setProperty("--accent-lo", shade(theme.accent, -0.45));
    root.setProperty("--ink", theme.ink);
    if (theme.pill === "soft") { root.setProperty("--pill-bg", theme.pillBg || hexA(theme.accent, 0.13)); root.setProperty("--pill-fg", theme.accent); }
    if (theme.pillRadius) root.setProperty("--pill-radius", theme.pillRadius);
    if (theme.font) root.setProperty("--font", `"${theme.font}"`);
    for (const [w, file] of Object.entries(theme.fontFiles || {})) {   // the brand's own font files (brand.py)
      try { const ff = new FontFace(theme.font, `url("${url(file)}")`, { weight: String(w) }); document.fonts.add(ff); await ff.load(); }
      catch (e) { console.warn("font failed", file, e && e.message); }
    }
    for (const sc of P.scenes) for (const it of sc.items || []) if (it.font && it.fontFile) {   // a font shown as a specimen (layers)
      try { const ff = new FontFace(it.font, `url("${url(it.fontFile)}")`, { weight: "100 900" }); document.fonts.add(ff); await ff.load(); }
      catch (e) { console.warn("font failed", it.fontFile, e && e.message); }
    }
    await Promise.all(["400", "500", "600", "700"].map((w) => document.fonts.load(`${w} 100px "${theme.font || "Inter Tight"}"`)));
    await document.fonts.load(`italic 400 100px "Instrument Serif"`);
    await document.fonts.load(`400 100px "JetBrains Mono"`);
    await document.fonts.ready;
    const srcs = new Set();
    for (const sc of P.scenes) { if (sc.src) srcs.add(sc.src); for (const it of sc.items || []) if (it.src) srcs.add(it.src); }
    await Promise.all([...srcs].map(preload));
    const TL = data.timeline && data.timeline.scenes && data.timeline.scenes.length === P.scenes.length ? data.timeline : estimate(P);
    if (data.timeline && TL !== data.timeline) console.warn("timeline does not match the plan's scenes; using an estimate");
    scenes = P.scenes.map((sc, i) => {
      const tl = TL.scenes[i];
      const node = el("div", "scene", stage);
      node.style.display = "block"; node.style.visibility = "hidden";
      const bg = el("div", "bg", node);
      const glow = paintBg(bg, sc.bg || (sc.type === "hero" || sc.type === "logo" ? (sc.type === "hero" ? "glow" : "dark") : "dark"));
      const layer = el("div", "layer", node);
      const dur = tl.end - tl.start;
      const localWords = (tl.words || []).map((w) => ({ w: w.w, s: w.s - tl.start, e: w.e - tl.start }));
      const ctx = { sc, root: layer, glow, dur, media, words: localWords,
        times: (tokens, skip = 0) => {
          const ws = localWords.slice(skip);
          if (!ws.length) {   // nothing spoken: reveal over the opening of the scene
            const n = tokens.length, t1 = Math.min(dur * 0.55, 0.12 + n * 0.22);
            return tokens.map((_, k) => ({ s: lerp(0.12, t1, n > 1 ? k / (n - 1) : 0), e: lerp(0.12, t1, n > 1 ? k / (n - 1) : 0) + 0.2 }));
          }
          return mapTimes(tokens, ws, (tl.vo_start ?? tl.start) - tl.start, (tl.vo_end ?? tl.end) - tl.start);
        } };
      if (!B[sc.type]) throw new Error(`scene ${i}: unknown type "${sc.type}"`);
      const inst = B[sc.type](ctx);
      return { i, sc, node, layer, glow, start: tl.start, end: tl.end, dur, inst };
    });
    await Promise.all(videos.map((v) => (v.readyState >= 2 ? 0 : new Promise((ok) => { v.onloadeddata = ok; v.onerror = ok; }))));
    // first paint of every scene (measures widths), then hide
    for (const s of scenes) { s.inst.update(0, s.dur, 0); s.node.style.display = "none"; s.node.style.visibility = "visible"; }
    {   // what shows through when the last scene fades out: its own background colour, not black
      const lastBg = (P.scenes[P.scenes.length - 1] || {}).bg;
      stage.style.background = isLight(lastBg) ? theme.light : theme.dark;
    }
    window.__duration = TL.duration;
    window.__timeline = TL;
    return { W, H, duration: TL.duration, estimated: !!TL.estimated, scenes: scenes.map((s) => ({ type: s.sc.type, start: s.start, end: s.end })) };
  };

  const OUT = { blur: 0.24, zoom: 0.3, slide: 0.3, fade: 0.3, cut: 0 };
  window.__seek = async (t) => {
    const pend = [];
    for (const s of scenes) {
      const on = t >= s.start && (t < s.end || (s === scenes[scenes.length - 1] && t <= s.end + 1));
      s.node.style.display = on ? "block" : "none";
      if (!on) continue;
      const lt = t - s.start;
      const out = s.sc.out || (P.look === "clean" || ["ui", "cards", "terminal"].includes(s.sc.type) ? "cut" : "blur");
      const od = OUT[out] ?? 0.24;
      const last = s === scenes[scenes.length - 1];
      const exitK = od && (!last || s.sc.out) ? E.in3(prog(lt, s.dur - od, od)) : last ? E.in3(prog(lt, s.dur - 0.6, 0.6)) : 0;
      s.layer.style.transform = out === "zoom" ? `scale(${lerp(1, 1.18, exitK).toFixed(4)})` : out === "slide" ? `translateX(${(-exitK * W * 0.08).toFixed(1)}px)` : "";
      s.node.style.opacity = last && !s.sc.out ? (1 - exitK).toFixed(3) : 1;
      s.inst.update(lt, s.dur, out === "fade" || out === "cut" ? 0 : (last && !s.sc.out ? 0 : exitK));
      if (out === "fade") s.layer.style.opacity = (1 - exitK).toFixed(3);
      for (const v of s.inst.videos || []) {
        const target = Math.max(0, Math.min(v.v.duration - 0.05, v.clipIn + (lt - (v.offset || 0)) * v.speed));
        if (Math.abs(v.v.currentTime - target) > 0.001) pend.push(new Promise((ok) => { v.v.onseeked = ok; v.v.currentTime = target; setTimeout(ok, 15000); }));
      }
    }
    await Promise.all(pend);
  };

  window.__cues = () => {
    const out = [];
    scenes.forEach((s, i) => {
      for (const c of (s.inst.cues ? s.inst.cues(s.dur) : [])) out.push({ t: +(s.start + c.t).toFixed(3), name: c.name, gain: c.gain ?? 0.5 });
      const o = s.sc.out;
      if ((o === "zoom" || o === "slide") && i < scenes.length - 1) out.push({ t: +(s.end - 0.28).toFixed(3), name: "whoosh", gain: 0.45 });
      for (const c of s.sc.sfx || []) out.push({ t: +(s.start + (c.at || 0)).toFixed(3), name: c.name, gain: c.gain ?? 0.6 });
    });
    return out.filter((c) => c.t >= 0).sort((a, b) => a.t - b.t);
  };
})();
