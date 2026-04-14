/**
 * Appetize.io APK Auto-Uploader
 * ================================
 * Automates uploading an APK from a GitHub URL to https://appetize.io/apps
 * using Playwright for browser automation.
 *
 * Usage:
 *   npm install
 *   npx playwright install chromium
 *   node script.js <github-apk-url>
 *
 * Example:
 *   node script.js https://github.com/owner/repo/releases/download/v1.0/app.apk
 */

"use strict";

const { chromium } = require("playwright");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// ─────────────────────────────────────────────
// CONFIG — tweak timeouts here
// ─────────────────────────────────────────────
const CONFIG = {
  appetizeUrl: "https://appetize.io/apps",
  cookiesFile: path.resolve(__dirname, "cookies.json"),
  apkOutputPath: path.resolve(__dirname, "app.apk"),
  headless: false,               // false = visible browser (easier debug)
  screenshotsDir: path.resolve(__dirname, "screenshots"),
  timeouts: {
    navigation: 60_000,          // page navigation
    elementVisible: 30_000,      // waiting for elements to appear
    uploadConfirmation: 120_000, // waiting for upload to complete
    manualLogin: 120_000,        // time given to user to log in manually
  },
  retries: {
    upload: 3,                   // how many times to retry the upload flow
    download: 3,                 // how many times to retry APK download
  },
};

// ─────────────────────────────────────────────
// LOGGING UTILITIES
// ─────────────────────────────────────────────
const log = {
  info:    (msg, data) => console.log(`[INFO]  ${timestamp()} ${msg}`, data !== undefined ? data : ""),
  warn:    (msg, data) => console.warn(`[WARN]  ${timestamp()} ${msg}`, data !== undefined ? data : ""),
  error:   (msg, data) => console.error(`[ERROR] ${timestamp()} ${msg}`, data !== undefined ? data : ""),
  success: (msg, data) => console.log(`[OK]    ${timestamp()} ${msg}`, data !== undefined ? data : ""),
  step:    (msg)       => console.log(`\n[STEP]  ${timestamp()} ══ ${msg} ══`),
};

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

// ─────────────────────────────────────────────
// SCREENSHOT HELPER
// ─────────────────────────────────────────────
async function takeErrorScreenshot(page, label) {
  try {
    if (!fs.existsSync(CONFIG.screenshotsDir)) {
      fs.mkdirSync(CONFIG.screenshotsDir, { recursive: true });
    }
    const name = `${label}-${Date.now()}.png`;
    const screenshotPath = path.join(CONFIG.screenshotsDir, name);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log.warn(`Screenshot saved → ${screenshotPath}`);
  } catch (err) {
    log.warn("Could not save screenshot", err.message);
  }
}

// ─────────────────────────────────────────────
// SESSION / COOKIES
// ─────────────────────────────────────────────
function hasSavedCookies() {
  return fs.existsSync(CONFIG.cookiesFile);
}

function loadCookies() {
  try {
    const raw = fs.readFileSync(CONFIG.cookiesFile, "utf-8");
    const cookies = JSON.parse(raw);
    log.info(`Loaded ${cookies.length} cookies from ${CONFIG.cookiesFile}`);
    return cookies;
  } catch (err) {
    log.warn("Failed to load cookies, starting fresh session", err.message);
    return null;
  }
}

async function saveCookies(context) {
  try {
    const cookies = await context.cookies();
    fs.writeFileSync(CONFIG.cookiesFile, JSON.stringify(cookies, null, 2));
    log.success(`Session saved → ${cookies.length} cookies written to ${CONFIG.cookiesFile}`);
  } catch (err) {
    log.error("Failed to save cookies", err.message);
  }
}

/**
 * Inject previously saved cookies into the browser context.
 */
async function injectCookies(context, cookies) {
  await context.addCookies(cookies);
  log.success("Cookies injected into browser context");
}

/**
 * Wait for the user to log in manually, then save their session.
 */
async function handleManualLogin(page, context) {
  log.step("Manual Login Required");
  log.info("No saved session found.");
  log.info(`Please log into Appetize.io in the browser that just opened.`);
  log.info(`You have ${CONFIG.timeouts.manualLogin / 1000}s to complete login.`);
  log.info("The script will continue automatically once you are logged in.");

  // Navigate to the app, wait until the user is on a post-login page
  await page.goto(CONFIG.appetizeUrl, { timeout: CONFIG.timeouts.navigation });

  // Poll until the URL no longer contains /login or /sign-in
  const deadline = Date.now() + CONFIG.timeouts.manualLogin;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const url = page.url();
    if (!url.includes("login") && !url.includes("sign-in") && !url.includes("signin")) {
      log.success("Login detected — continuing");
      break;
    }
    // If still on login page, wait longer
    if (Date.now() + 2000 >= deadline) {
      throw new Error("Manual login timed out. Please run the script again.");
    }
  }

  await saveCookies(context);
}

// ─────────────────────────────────────────────
// APK DOWNLOAD
// ─────────────────────────────────────────────
/**
 * Download a file from a URL, following redirects (including GitHub's CDN hops).
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    function doRequest(requestUrl) {
      const lib = requestUrl.startsWith("https") ? https : http;
      lib.get(requestUrl, (response) => {
        // Follow HTTP redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          log.info(`Redirect → ${response.headers.location}`);
          doRequest(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} while downloading from ${requestUrl}`));
          return;
        }

        response.pipe(file);
        file.on("finish", () => {
          file.close(resolve);
        });
      }).on("error", (err) => {
        fs.unlink(destPath, () => {}); // clean up partial file
        reject(err);
      });
    }

    doRequest(url);
  });
}

/**
 * Download the APK from GitHub (with retries) and validate it.
 */
async function downloadApk(githubUrl) {
  log.step("Downloading APK from GitHub");
  log.info(`Source URL: ${githubUrl}`);

  for (let attempt = 1; attempt <= CONFIG.retries.download; attempt++) {
    log.info(`Download attempt ${attempt}/${CONFIG.retries.download}`);
    try {
      // Remove stale file if present
      if (fs.existsSync(CONFIG.apkOutputPath)) {
        fs.unlinkSync(CONFIG.apkOutputPath);
      }

      await downloadFile(githubUrl, CONFIG.apkOutputPath);

      // Validate
      const stats = fs.statSync(CONFIG.apkOutputPath);
      if (stats.size === 0) {
        throw new Error("Downloaded file is empty (0 bytes)");
      }

      log.success(`APK downloaded → ${CONFIG.apkOutputPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
      return CONFIG.apkOutputPath;
    } catch (err) {
      log.error(`Download attempt ${attempt} failed`, err.message);
      if (attempt === CONFIG.retries.download) {
        throw new Error(`All ${CONFIG.retries.download} download attempts failed: ${err.message}`);
      }
      log.info("Retrying in 3s…");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ─────────────────────────────────────────────
// DOM DETECTION — "Upload App" button
// ─────────────────────────────────────────────
/**
 * Try multiple strategies to locate the "Upload App" button.
 * Returns the element handle or throws.
 */
async function findUploadButton(page) {
  log.info("Searching for 'Upload App' button…");

  const strategies = [
    // Text-based (most reliable — no selector coupling)
    { desc: "text exact",        fn: () => page.getByText("Upload App", { exact: true }).first() },
    { desc: "text partial",      fn: () => page.getByText("Upload", { exact: false }).first() },
    // Role-based
    { desc: "role=button text",  fn: () => page.getByRole("button", { name: /upload/i }).first() },
    { desc: "role=link text",    fn: () => page.getByRole("link", { name: /upload/i }).first() },
    // aria-label
    { desc: "aria-label upload", fn: () => page.locator('[aria-label*="upload" i]').first() },
    // Common CSS patterns on Appetize.io (fallback)
    { desc: "data-* upload",     fn: () => page.locator('[data-cy*="upload" i], [data-test*="upload" i], [data-testid*="upload" i]').first() },
    { desc: "class upload",      fn: () => page.locator('button:has-text("Upload"), a:has-text("Upload")').first() },
  ];

  for (const strategy of strategies) {
    try {
      const el = strategy.fn();
      await el.waitFor({ state: "visible", timeout: 5000 });
      log.success(`Upload button found via: ${strategy.desc}`);
      const text = await el.textContent().catch(() => "(no text)");
      log.info(`  → element text: "${text.trim()}"`);
      return el;
    } catch {
      log.info(`  Skipping strategy '${strategy.desc}' (not found)`);
    }
  }

  throw new Error("Could not locate 'Upload App' button with any strategy");
}

// ─────────────────────────────────────────────
// DOM DETECTION — file input
// ─────────────────────────────────────────────
/**
 * Try multiple strategies to locate the file <input>.
 */
async function findFileInput(page) {
  log.info("Searching for file input…");

  const strategies = [
    { desc: "input[type=file]",              fn: () => page.locator('input[type="file"]').first() },
    { desc: "input accept apk/zip",          fn: () => page.locator('input[accept*=".apk"], input[accept*=".zip"], input[accept*="application"]').first() },
    { desc: "input hidden file",             fn: () => page.locator('input[type="file"]:not([style*="display:none"])').first() },
    { desc: "any file input (including hidden)", fn: () => page.locator('input[type="file"]') },
  ];

  for (const strategy of strategies) {
    try {
      const el = strategy.fn();
      // File inputs are often hidden — check if it exists in DOM even if not visible
      const count = await el.count().catch(() => 0);
      if (count > 0) {
        log.success(`File input found via: ${strategy.desc} (count=${count})`);
        return el.first();
      }
    } catch {
      log.info(`  Skipping strategy '${strategy.desc}' (not found)`);
    }
  }

  throw new Error("Could not locate file input element");
}

// ─────────────────────────────────────────────
// DOM DETECTION — submit / confirm button
// ─────────────────────────────────────────────
/**
 * After selecting the file, find the confirmation button.
 */
async function findSubmitButton(page) {
  log.info("Searching for submit/confirm button…");

  const strategies = [
    { desc: "Upload (role=button)",      fn: () => page.getByRole("button", { name: /upload/i }).first() },
    { desc: "Submit (role=button)",      fn: () => page.getByRole("button", { name: /submit/i }).first() },
    { desc: "Confirm (role=button)",     fn: () => page.getByRole("button", { name: /confirm/i }).first() },
    { desc: "Save (role=button)",        fn: () => page.getByRole("button", { name: /save/i }).first() },
    { desc: "Continue (role=button)",    fn: () => page.getByRole("button", { name: /continue/i }).first() },
    { desc: "Next (role=button)",        fn: () => page.getByRole("button", { name: /next/i }).first() },
    { desc: "button type=submit",        fn: () => page.locator('button[type="submit"]').first() },
    { desc: "data-testid submit",        fn: () => page.locator('[data-testid*="submit" i], [data-cy*="submit" i]').first() },
  ];

  for (const strategy of strategies) {
    try {
      const el = strategy.fn();
      await el.waitFor({ state: "visible", timeout: 5000 });
      const text = await el.textContent().catch(() => "(no text)");
      log.success(`Submit button found via: ${strategy.desc} → "${text.trim()}"`);
      return el;
    } catch {
      log.info(`  Skipping strategy '${strategy.desc}' (not found)`);
    }
  }

  // Last resort — try any enabled button on the page
  log.warn("No submit button found via named strategies — dumping visible buttons for debug");
  const allButtons = await page.locator("button:visible").all();
  for (const btn of allButtons) {
    const txt = await btn.textContent().catch(() => "");
    log.info(`  visible button: "${txt.trim()}"`);
  }

  throw new Error("Could not locate submit/confirm button after file selection");
}

// ─────────────────────────────────────────────
// UPLOAD CONFIRMATION DETECTION
// ─────────────────────────────────────────────
/**
 * Wait for a signal that the upload succeeded.
 * Looks for success messages, new app entries, or URL changes.
 */
async function waitForUploadConfirmation(page) {
  log.info("Waiting for upload confirmation…");

  // Strategy 1: watch for success text
  const successTexts = [
    /upload.*(success|complete|done)/i,
    /app.*(uploaded|created|ready)/i,
    /success/i,
  ];

  // Strategy 2: watch for a new app card appearing
  // Strategy 3: URL change (redirect to new app page)
  const initialUrl = page.url();

  try {
    await Promise.race([
      // Wait for success-like text
      (async () => {
        for (const pattern of successTexts) {
          try {
            await page.waitForSelector(`text=${pattern}`, { timeout: CONFIG.timeouts.uploadConfirmation });
            log.success("Upload confirmation text detected");
            return;
          } catch { /* try next */ }
        }
      })(),

      // Wait for URL change (e.g. redirect to app detail page)
      page.waitForURL((url) => url !== initialUrl && url.includes("appetize.io"), {
        timeout: CONFIG.timeouts.uploadConfirmation,
      }),

      // Wait for a "close" or "done" button on a dialog
      page.waitForSelector('button:has-text("Close"), button:has-text("Done"), button:has-text("Finish")', {
        timeout: CONFIG.timeouts.uploadConfirmation,
        state: "visible",
      }),

      // Generic: wait for any element that suggests completion
      page.waitForSelector('[class*="success"], [class*="complete"], [role="alert"]', {
        timeout: CONFIG.timeouts.uploadConfirmation,
        state: "visible",
      }),
    ]);

    log.success("Upload completed successfully!");
    log.info(`Final page URL: ${page.url()}`);
  } catch (err) {
    throw new Error(`Upload confirmation not detected within timeout: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// MAIN UPLOAD FLOW
// ─────────────────────────────────────────────
async function runUploadFlow(page, apkPath) {
  log.step("Starting Upload Flow");

  // 1. Navigate to apps page
  log.info(`Navigating to ${CONFIG.appetizeUrl}`);
  await page.goto(CONFIG.appetizeUrl, {
    waitUntil: "domcontentloaded",
    timeout: CONFIG.timeouts.navigation,
  });
  await page.waitForTimeout(2000); // let dynamic content settle

  log.info(`Current URL: ${page.url()}`);

  // 2. Find and click "Upload App" button
  const uploadBtn = await findUploadButton(page);
  log.info("Clicking Upload App button…");
  await uploadBtn.click();
  await page.waitForTimeout(1500); // wait for modal/dialog to open

  // 3. Locate the file input and set the APK file
  const fileInput = await findFileInput(page);

  log.info(`Injecting APK file: ${apkPath}`);
  await fileInput.setInputFiles(apkPath);
  log.success("File injected into input");
  await page.waitForTimeout(1500); // let UI react to file selection

  // 4. Find and click the submit/confirm button
  let submitBtn;
  try {
    submitBtn = await findSubmitButton(page);
    log.info("Clicking submit button…");
    await submitBtn.click();
  } catch (err) {
    log.warn("No separate submit button found — file input may auto-trigger upload");
    // Some flows auto-upload on file selection; proceed to confirmation wait
  }

  // 5. Wait for confirmation
  await waitForUploadConfirmation(page);
}

// ─────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────
async function main() {
  const githubUrl = process.argv[2];
  if (!githubUrl) {
    console.error(
      "\nUsage: node script.js <github-apk-url>\n" +
      "Example: node script.js https://github.com/owner/repo/releases/download/v1.0/app-release.apk\n"
    );
    process.exit(1);
  }

  log.step("Appetize.io APK Auto-Uploader");
  log.info(`APK source: ${githubUrl}`);

  // ── Step 1: Download APK ──
  const apkPath = await downloadApk(githubUrl);

  // ── Step 2: Launch browser ──
  log.step("Launching Browser");
  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled", // reduces bot detection
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // ── Step 3: Session management ──
  log.step("Session Management");
  if (hasSavedCookies()) {
    const cookies = loadCookies();
    if (cookies) {
      await injectCookies(context, cookies);
      log.info("Existing session loaded — skipping manual login");
    } else {
      await handleManualLogin(page, context);
    }
  } else {
    log.info("No cookies.json found — manual login required");
    await handleManualLogin(page, context);
  }

  // ── Step 4: Run upload with retries ──
  let lastError = null;
  for (let attempt = 1; attempt <= CONFIG.retries.upload; attempt++) {
    log.step(`Upload Attempt ${attempt}/${CONFIG.retries.upload}`);
    try {
      await runUploadFlow(page, apkPath);
      lastError = null;
      break; // success
    } catch (err) {
      lastError = err;
      log.error(`Upload attempt ${attempt} failed`, err.message);
      await takeErrorScreenshot(page, `upload-error-attempt-${attempt}`);

      if (attempt < CONFIG.retries.upload) {
        log.info("Retrying in 5s…");
        await page.waitForTimeout(5000);
      }
    }
  }

  if (lastError) {
    log.error("All upload attempts failed", lastError.message);
    log.error("Check screenshots in the 'screenshots/' folder for visual debug info");
    await browser.close();
    process.exit(1);
  }

  // ── Step 5: Refresh cookies (keeps session alive) ──
  await saveCookies(context);

  log.step("Done");
  log.success("APK uploaded successfully to Appetize.io!");
  log.info("Your app should now be visible at https://appetize.io/apps");

  await page.waitForTimeout(3000); // give user time to see the result visually
  await browser.close();
}

// Run
main().catch((err) => {
  console.error("\n[FATAL]", err.message);
  process.exit(1);
});
