#!/usr/bin/env node
// Screenshot real product pages for ui / cards scenes, crisp (2x) and at a chosen size.
//
//   node shoot.mjs <url> <out.png> [--w 1440] [--h 900] [--scale 2] [--full] [--scroll 600] [--wait 1500] [--hide ".cookie,.banner"]
import { chromium } from "playwright-core";
import fs from "node:fs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const [url, out] = argv;
if (!url || !out) { console.error("usage: node shoot.mjs <url> <out.png> [--w 1440] [--h 900] [--scale 2] [--full] [--scroll px]"); process.exit(1); }
const CHROME = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: Number(opt("w", 1440)), height: Number(opt("h", 900)) }, deviceScaleFactor: Number(opt("scale", 2)) });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => page.goto(url, { waitUntil: "load" }));
await page.waitForTimeout(Number(opt("wait", 1500)));
const hide = opt("hide");
if (hide) await page.addStyleTag({ content: `${hide} { display: none !important; }` });
if (opt("scroll")) { await page.evaluate((y) => window.scrollTo(0, y), Number(opt("scroll"))); await page.waitForTimeout(600); }
await page.screenshot({ path: out, fullPage: argv.includes("--full") });
console.log("shot", out);
await browser.close();
