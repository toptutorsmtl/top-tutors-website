#!/usr/bin/env node
// Render a launch-video project: player.html frames in headless Chrome -> ffmpeg -> mux with the audio mix.
//
//   node render.mjs <project>                 full render -> <project>/out/<name>.mp4 (+ -review.mp4 at 720p)
//   node render.mjs <project> --draft         half size, 15 fps, quick look at timing
//   node render.mjs <project> --still 3.2,10  PNG frames -> <project>/out/stills/
//   node render.mjs <project> --board         one frame per scene on a contact sheet -> <project>/out/board.jpg
//   options: --fps 30  --workers 4  --from 5 --to 12  --no-audio
import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes("--" + n);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
if (!argv[0] || argv[0].startsWith("--")) { console.error("usage: node render.mjs <project> [--draft|--still t,t|--board]"); process.exit(1); }
const PROJ = path.resolve(argv[0]);
const plan = JSON.parse(fs.readFileSync(path.join(PROJ, "plan.json"), "utf8"));
const tlPath = path.join(PROJ, "timeline.json");
const timeline = fs.existsSync(tlPath) ? JSON.parse(fs.readFileSync(tlPath, "utf8")) : null;
const OUT = path.join(PROJ, "out");
fs.mkdirSync(OUT, { recursive: true });
const name = plan.name || path.basename(PROJ);
const draft = flag("draft");
const fps = Number(opt("fps", draft ? 15 : plan.fps || 30));
const scale = draft ? 0.5 : Number(opt("scale", 1));
const workers = Number(opt("workers", 4));

const CHROME = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ["--allow-file-access-from-files", "--disable-web-security", "--autoplay-policy=no-user-gesture-required", "--hide-scrollbars", "--force-color-profile=srgb"] });
const data = { plan, timeline, base: pathToFileURL(PROJ).href + "/" };

async function openPage() {
  const FMT = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350] }[plan.format || "16:9"];
  const ctx = await browser.newContext({ viewport: { width: FMT[0], height: FMT[1] }, deviceScaleFactor: scale });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.error("[page]", m.text()); });
  page.on("pageerror", (e) => console.error("[page error]", e.message));
  await page.goto(pathToFileURL(path.join(HERE, "player.html")).href);
  const info = await page.evaluate((d) => window.__load(d), data);
  return { page, info };
}
const shot = async (page, t, type = "jpeg") => {
  await page.evaluate((t) => window.__seek(t), t);
  return page.screenshot(type === "png" ? { type: "png" } : { type: "jpeg", quality: 93 });
};
const run = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] }); if (r.status !== 0) throw new Error(`${cmd} failed`); };

const { page, info } = await openPage();
if (info.estimated) console.log("note: no timeline.json yet, timing is estimated from word count (run vo.py to record the voice)");
const D = info.duration;
console.log(`${name}: ${info.W}x${info.H}, ${D.toFixed(2)} s, ${info.scenes.length} scenes`);
info.scenes.forEach((s, i) => console.log(`  ${String(i).padStart(2)} ${s.start.toFixed(2).padStart(6)}  ${s.type.padEnd(9)} ${(plan.scenes[i].vo || plan.scenes[i].text || "").slice(0, 70)}`));

if (opt("still")) {
  const dir = path.join(OUT, "stills"); fs.mkdirSync(dir, { recursive: true });
  for (const t of String(opt("still")).split(",").map(Number)) {
    const f = path.join(dir, `t${t.toFixed(2)}.png`);
    fs.writeFileSync(f, await shot(page, t, "png")); console.log("still", f);
  }
  await browser.close(); process.exit(0);
}

if (flag("board")) {
  const dir = path.join(OUT, "board"); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const at = info.scenes.map((s) => s.start + Math.min(s.end - s.start - 0.3, Math.max(0.6, (s.end - s.start) * 0.72)));
  const cols = 4, n = Math.ceil(at.length / cols) * cols;
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, `${String(i).padStart(3, "0")}.jpg`), await shot(page, at[Math.min(i, at.length - 1)]));
  run("ffmpeg", ["-v", "error", "-y", "-i", path.join(dir, "%03d.jpg"), "-vf", `scale=480:-1,tile=${cols}x${n / cols}:padding=6:color=0x222222`, "-frames:v", "1", path.join(OUT, "board.jpg")]);
  console.log("board", path.join(OUT, "board.jpg"));
  await browser.close(); process.exit(0);
}

// ---- full render: split frames across pages, one ffmpeg segment each ----
const t0 = Number(opt("from", 0)), t1 = Math.min(D, Number(opt("to", D)));
const total = Math.round((t1 - t0) * fps);
const per = Math.ceil(total / workers);
const segs = [];
const started = Date.now();
let done = 0;
async function renderRange(k, a, b, pg) {
  const seg = path.join(OUT, `.seg${k}.mp4`); segs[k] = seg;
  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", draft ? "veryfast" : "medium", "-crf", draft ? "23" : "16", "-pix_fmt", "yuv420p", "-r", String(fps), seg]);
  const closed = new Promise((ok, bad) => ff.on("close", (c) => (c === 0 ? ok() : bad(new Error("ffmpeg segment failed")))));
  for (let f = a; f < b; f++) {
    const buf = await shot(pg, t0 + f / fps);
    if (!ff.stdin.write(buf)) await new Promise((ok) => ff.stdin.once("drain", ok));
    done++;
    if (done % 60 === 0) process.stdout.write(`\r  ${done}/${total} frames  ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
  ff.stdin.end();
  await closed;
}
const pages = [page];
for (let k = 1; k < workers; k++) pages.push((await openPage()).page);
await Promise.all(pages.map((pg, k) => renderRange(k, k * per, Math.min(total, (k + 1) * per), pg)));
process.stdout.write(`\r  ${total}/${total} frames  ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
const cues = await page.evaluate(() => window.__cues());
fs.writeFileSync(path.join(OUT, "cues.json"), JSON.stringify(cues.map((c) => ({ ...c, t: +(c.t - t0).toFixed(3) })).filter((c) => c.t >= 0 && c.t < t1 - t0), null, 0));
await browser.close();

const list = path.join(OUT, ".segs.txt");
fs.writeFileSync(list, segs.filter(Boolean).map((s) => `file '${s}'`).join("\n"));
const silent = path.join(OUT, ".video.mp4");
run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent]);
segs.forEach((s) => s && fs.rmSync(s, { force: true })); fs.rmSync(list, { force: true });

const final = path.join(OUT, `${name}${draft ? "-draft" : ""}.mp4`);
let audio = null;
if (!flag("no-audio")) {
  const py = spawnSync("python3", [path.join(HERE, "..", "audio.py"), "mix", PROJ, "--from", String(t0), "--to", String(t1)], { stdio: "inherit" });
  const mix = path.join(OUT, "mix.wav");
  if (py.status === 0 && fs.existsSync(mix)) audio = mix; else console.error("audio mix failed; writing a silent video");
}
run("ffmpeg", ["-v", "error", "-y", "-i", silent, ...(audio ? ["-i", audio, "-c:a", "aac", "-b:a", "192k", "-shortest"] : []), "-c:v", "copy", "-movflags", "+faststart", final]);
console.log("video", final);
if (audio && !draft && plan.music && plan.music.file) {   // a real song: also a copy without it, to post with the app's licensed sound
  const py = spawnSync("python3", [path.join(HERE, "..", "audio.py"), "mix", PROJ, "--from", String(t0), "--to", String(t1), "--no-music"], { stdio: "inherit" });
  const up = path.join(OUT, `${name}-upload.mp4`), um = path.join(OUT, "mix-upload.wav");
  if (py.status === 0 && fs.existsSync(um)) {
    run("ffmpeg", ["-v", "error", "-y", "-i", silent, "-i", um, "-c:a", "aac", "-b:a", "192k", "-shortest", "-c:v", "copy", "-movflags", "+faststart", up]);
    console.log("upload (no song)", up);
  }
}
fs.rmSync(silent, { force: true });
if (!draft) {   // small review copy (Cut Notes / sharing), 720p
  const review = path.join(OUT, `${name}-review.mp4`);
  const kbps = Math.max(800, Math.min(5000, Math.floor((14 * 8192) / Math.max(1, t1 - t0)) - 160));
  run("ffmpeg", ["-v", "error", "-y", "-i", final, "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", review]);
  console.log("review", review);
}
