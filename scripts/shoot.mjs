// Capture the card to docs/ with the system Chrome, and fail on what a reviewer would catch: horizontal overflow on a
// phone, any dash or unrenderable character in the visible text, and console errors.
// Needs a server on http://localhost:3008 (npm run dev).   node scripts/shoot.mjs [url]
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";

// set CHROME_PATH to your Chrome or Chromium on macOS or Linux
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL_ = process.argv[2] ?? "http://localhost:3008";
mkdirSync("docs", { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
const problems = [];
try {
  const p = await b.newPage();
  const errors = [];
  p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  p.on("pageerror", (e) => errors.push(String(e)));

  await p.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  await p.goto(URL_, { waitUntil: "networkidle0" });
  await wait(1900);
  await (await p.$(".hero")).screenshot({ path: "docs/hero_midway.png" });
  await wait(2600);
  await (await p.$(".hero")).screenshot({ path: "docs/hero.png" });
  // the link preview: X and LinkedIn crop large cards to about 1.91 to 1, so the share image is cut to that shape
  const hb = await (await p.$(".hero")).boundingBox();
  await p.screenshot({ path: "public/og.png", clip: { x: 0, y: hb.y + Math.max(0, (hb.height - 670) / 2), width: 1280, height: 670 } });
  await (await p.$(".phone-sec")).screenshot({ path: "docs/phone_check.png" });
  await p.screenshot({ path: "docs/card.png", fullPage: true });

  const text = await p.evaluate(() => document.body.innerText);
  mkdirSync("leads", { recursive: true });
  writeFileSync("leads/card_text.txt", text); // the visible text, for the no dash gate
  const dashes = text.split("\n").filter((l) => /[\u2010-\u2015\u2212-]/.test(l));
  if (dashes.length) problems.push(`dash in visible text:\n  ${dashes.join("\n  ")}`);
  const boxes = text.split("\n").filter((l) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/.test(l));
  if (boxes.length) problems.push(`unrenderable character in visible text:\n  ${boxes.join("\n  ")}`);

  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await p.reload({ waitUntil: "networkidle0" });
  await wait(4600);
  const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 0) problems.push(`phone layout overflows by ${over}px`);
  await p.screenshot({ path: "docs/phone.png", fullPage: true });

  if (errors.length) problems.push(`console errors:\n  ${errors.join("\n  ")}`);
} finally {
  await b.close();
}
console.log("wrote docs/hero_midway.png, docs/hero.png, docs/phone_check.png, docs/card.png, docs/phone.png");
if (problems.length) { console.log(`PROBLEMS\n${problems.join("\n")}`); process.exit(1); }
console.log("checks: no dashes or unrenderable characters in visible text, no phone overflow, no console errors");
