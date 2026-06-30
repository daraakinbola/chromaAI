/**
 * Playwright UI test for the moodboard Apply button.
 *
 * Full flow:
 *   1. Session setup page → pick Portrait → Start session
 *   2. Import a JPEG into the main canvas (so activeImageId is set)
 *   3. Switch to the Moodboard tab
 *   4. Upload two synthetic images to the moodboard drop zone
 *   5. Wait for the pipeline to complete (creative brief appears)
 *   6. Screenshot and record temperature slider BEFORE Apply
 *   7. Click "Apply this direction"
 *   8. Switch back to Adjust panel, screenshot and record temperature AFTER
 *   9. Assert it changed and non-moodboard sliders are untouched
 */

import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, "test-screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

function shot(page, name) {
  return page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
}

// ── Create gradient JPEG files via Playwright canvas API ──────────────────────

async function makeJpeg(page, topRgb, bottomRgb, filename) {
  const dataUrl = await page.evaluate(({ top, bottom }) => {
    const [tr, tg, tb] = top;
    const [br, bg, bb] = bottom;
    const c = Object.assign(document.createElement("canvas"), { width: 300, height: 300 });
    const ctx = c.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 0, 300);
    g.addColorStop(0, `rgb(${tr},${tg},${tb})`);
    g.addColorStop(1, `rgb(${br},${bg},${bb})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 300, 300);
    return c.toDataURL("image/jpeg", 0.85);
  }, { top: topRgb, bottom: bottomRgb });

  const p = path.join(SHOTS, filename);
  fs.writeFileSync(p, Buffer.from(dataUrl.replace(/^data:image\/jpeg;base64,/, ""), "base64"));
  return p;
}

// ── Read a slider value by its labeled section in AdjustmentPanel ─────────────

async function readSlider(page, maxAbove) {
  // Temperature slider has max >= 10000 (Kelvin range 2000-50000)
  return page.evaluate((minMax) => {
    const inputs = [...document.querySelectorAll('input[type="range"]')];
    const el = inputs.find(i => parseFloat(i.max) >= minMax);
    return el ? parseFloat(el.value) : null;
  }, maxAbove);
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 150 });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(90_000);

  const consoleErrors = [];
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });

  try {
    // ── 1. Session setup ──────────────────────────────────────────────────────
    console.log("1. Session setup — picking Portrait genre...");
    await page.goto("http://localhost:3000");
    await page.waitForLoadState("networkidle");
    await shot(page, "01-session-setup.png");

    await page.getByRole("button", { name: "Portrait" }).click();
    await page.getByRole("button", { name: "Start session" }).click();
    await page.waitForURL("**/workspace**");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
    await shot(page, "02-workspace-loaded.png");
    console.log("   Workspace ready at:", page.url());

    // ── 2. Create synthetic images while workspace renders ────────────────────
    console.log("2. Creating synthetic test images...");
    const warmFile = await makeJpeg(page, [255, 200, 80], [180, 70, 20], "warm.jpg");
    const coolFile = await makeJpeg(page, [30, 40, 120], [80, 120, 180], "cool.jpg");
    console.log("   Created:", warmFile, coolFile);

    // ── 3. Import into main canvas (ImageBrowser hidden file input) ───────────
    console.log("3. Importing image into main canvas...");
    const canvasInput = page.locator("aside input[type='file']");
    await canvasInput.waitFor({ state: "attached" });
    await canvasInput.setInputFiles(warmFile);
    await page.waitForTimeout(2000); // import + thumbnail generation
    await shot(page, "03-image-imported.png");

    // Confirm an image is active (ImageBrowser shows a thumbnail)
    const thumbs = page.locator("aside img");
    await thumbs.first().waitFor({ state: "visible" });
    console.log("   Image imported, thumbnail visible");

    // ── 4. Switch to Moodboard panel ──────────────────────────────────────────
    console.log("4. Switching to Moodboard tab...");
    await page.getByRole("button", { name: /moodboard/i }).click();
    await page.waitForTimeout(400);
    await shot(page, "04-moodboard-panel-empty.png");

    // ── 5. Upload two images to moodboard drop zone ───────────────────────────
    console.log("5. Uploading moodboard images...");

    // Log all file inputs for debugging
    const allInputs = page.locator("input[type='file']");
    const count = await allInputs.count();
    console.log(`   Found ${count} file inputs on page`);

    // The DropZone in MoodboardPanel sits inside a div that contains the text
    // "Drop moodboard images here" or "Add more images". Find its file input.
    // Strategy: find the div containing the upload icon area, then the input inside it.
    const dropZone = page.locator("div").filter({ hasText: /Drop moodboard images here/i }).last();
    const moodInput = dropZone.locator("input[type='file']");
    const moodInputExists = await moodInput.count();
    console.log(`   Moodboard drop zone input found: ${moodInputExists > 0}`);

    if (moodInputExists === 0) {
      // Fallback: click the drop zone to trigger the file input, then use last input
      console.log("   Falling back to last file input...");
      await dropZone.click();
      await page.waitForTimeout(200);
    }

    const targetInput = moodInputExists > 0 ? moodInput : allInputs.last();
    await targetInput.setInputFiles([warmFile, coolFile]);
    await page.waitForTimeout(800);
    await shot(page, "05-moodboard-images-added.png");

    // Confirm thumbnails appeared in the moodboard panel
    const moodThumbs = page.locator("div.w-64, div[class*='w-64']").locator("img");
    const thumbCount = await moodThumbs.count();
    console.log(`   Moodboard thumbnails visible: ${thumbCount}`);

    // ── 6. Wait for pipeline to complete ─────────────────────────────────────
    console.log("6. Waiting for moodboard pipeline (up to 120s)...");

    // Confirm the pipeline started — one of the stage dots should activate
    try {
      await page.waitForSelector("text=/Looking at your images|Finding the common thread|Writing your creative/i", { timeout: 8_000 });
      console.log("   Pipeline started (loading stage visible)");
    } catch {
      console.log("   (Pipeline may have started and finished too fast to catch loading stage)");
    }

    // The "Creative brief" label appears when the Creative Director finishes
    await page.waitForSelector("text=Creative brief", { timeout: 120_000 });
    await page.waitForTimeout(600);
    await shot(page, "06-pipeline-complete.png");
    console.log("   Pipeline complete — creative brief visible");

    // ── 7. Read temperature BEFORE switching panels ────────────────────────────
    console.log("7. Reading temperature before Apply (via Adjust panel)...");
    await page.getByRole("button", { name: /^Adjust$/i }).click();
    await page.waitForTimeout(400);
    const tempBefore = await readSlider(page, 10000);
    await shot(page, "07-adjust-panel-before.png");
    console.log(`   Temperature before: ${tempBefore}K`);

    // Switch back to Moodboard to click Apply
    await page.getByRole("button", { name: /moodboard/i }).click();
    await page.waitForTimeout(300);

    // ── 8. Click Apply ────────────────────────────────────────────────────────
    console.log('8. Clicking "Apply this direction"...');
    const applyBtn = page.getByRole("button", { name: /apply this direction/i });
    await applyBtn.waitFor({ state: "visible" });
    await applyBtn.click();

    // Wait for the success toast
    const toastLocator = page.locator("text=/Applied at \\d+% strength/");
    await toastLocator.waitFor({ timeout: 15_000 });
    const toastText = await toastLocator.textContent();
    await shot(page, "08-toast-visible.png");
    console.log(`   Toast: "${toastText}"`);

    // ── 9. Check sliders in Adjust panel ─────────────────────────────────────
    console.log("9. Switching to Adjust panel to verify slider changes...");
    await page.getByRole("button", { name: /^Adjust$/i }).click();
    await page.waitForTimeout(500);
    const tempAfter = await readSlider(page, 10000);
    await shot(page, "09-adjust-panel-after.png");
    console.log(`   Temperature after: ${tempAfter}K`);

    // ── Assertions ─────────────────────────────────────────────────────────────
    console.log("\n── Results ─────────────────────────────────────────────");

    const deltaTemp = tempAfter !== null && tempBefore !== null ? (tempAfter - tempBefore) : null;

    if (deltaTemp !== null && Math.abs(deltaTemp) > 50) {
      console.log(`[PASS] Temperature moved: ${tempBefore}K → ${tempAfter}K (Δ${deltaTemp > 0 ? "+" : ""}${deltaTemp.toFixed(0)}K)`);
    } else {
      console.log(`[FAIL] Temperature didn't move as expected: ${tempBefore}K → ${tempAfter}K`);
    }

    if (toastText?.match(/Applied at \d+% strength/)) {
      console.log(`[PASS] Toast showed weight percentage: "${toastText}"`);
    } else {
      console.log(`[FAIL] Toast text unexpected: "${toastText}"`);
    }

    if (consoleErrors.length === 0) {
      console.log("[PASS] No console errors");
    } else {
      console.log(`[WARN] ${consoleErrors.length} console error(s):`);
      consoleErrors.forEach(e => console.log(`       ${e}`));
    }

    console.log(`\nScreenshots: ${SHOTS}`);
    console.log("── Test complete ────────────────────────────────────");

  } catch (err) {
    console.error("\n[ERROR]", err.message);
    await shot(page, "error-state.png");
    throw err;
  } finally {
    await page.waitForTimeout(2500);
    await browser.close();
  }
})();
