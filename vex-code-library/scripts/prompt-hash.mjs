// Prints the SHA-256 fingerprint of the Ask AI instructions that index.html
// builds and sends. The Supabase function only accepts approved fingerprints.
// Run it after you change snippets or the AI rules, then either update
// DEFAULT_PROMPT_SHA256 in supabase/functions/ask-ai/handler.ts and redeploy,
// or set the PROMPT_SHA256 secret in Supabase (no redeploy needed).
// The function also logs the fingerprint it received when it refuses one.
//
//   npm i -D playwright            (once; uses Playwright's bundled Chromium)
//   node vex-code-library/scripts/prompt-hash.mjs
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage();
// Stand in for the claude.ai runtime so the page hands us its instructions turn.
await page.addInitScript(() => {
  window.__captured = null;
  const sample = (input) => {
    window.__captured = input[0].content;
    return Promise.reject({ code: "cancelled" });
  };
  window.claude = { use: async (n) => (n === "sample" ? sample : null) };
});
page.on("pageerror", (e) => console.error("page error:", e.message));
// Skip web fonts: they are not needed to read the instructions.
await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ body: "", contentType: "text/css" }));
await page.goto(pathToFileURL(join(root, "index.html")).href, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.getElementById("mode")?.textContent === "Claude");
await page.click("#fab");
await page.fill("#ask", "x");
await page.press("#ask", "Enter");
await page.waitForFunction(() => window.__captured);
const rules = await page.evaluate(() => window.__captured);
await browser.close();

const sha = createHash("sha256").update(rules, "utf8").digest("hex");
console.log(`${sha}  (${rules.length} characters)`);
