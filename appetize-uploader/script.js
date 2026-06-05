/**
 * Appetize.io APK Manager
 * ========================
 * - Upload un APK depuis un artefact GitHub Actions (privé, via PAT)
 * - Supprime une app existante sur Appetize.io
 * - Gestion de session persistante (cookies)
 *
 * Usage:
 *   node script.js upload  <owner/repo> <run_id> <artifact_name>
 *   node script.js delete  <public_key_ou_nom_app>
 *   node script.js list
 *
 * Exemples:
 *   node script.js upload ferelking242/watchtower 24347257733 app-arm64-profile
 *   node script.js delete
 *   node script.js list
 *
 * Variables d'environnement:
 *   GITHUB_PAT  — Personal Access Token GitHub (requis pour artefacts privés)
 */

"use strict";

const { chromium } = require("playwright");
const AdmZip = require("adm-zip");
const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  appetizeUrl:   "https://appetize.io/apps",
  cookiesFile:   path.resolve(__dirname, "cookies.json"),
  apkOutputPath: path.resolve(__dirname, "app.apk"),
  screenshotsDir: path.resolve(__dirname, "screenshots"),
  headless: true,
  timeouts: {
    navigation:         60_000,
    elementVisible:     30_000,
    uploadConfirmation: 180_000,
    manualLogin:        180_000,
    deleteConfirmation:  30_000,
  },
  retries: {
    upload:   3,
    download: 3,
  },
};

const GITHUB_PAT = process.env.GITHUB_PAT || "";

// ─────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────
const ts = () => new Date().toISOString().slice(11, 23);
const log = {
  info:    (m, d) => console.log(`[INFO]  ${ts()} ${m}`, d !== undefined ? d : ""),
  warn:    (m, d) => console.warn(`[WARN]  ${ts()} ${m}`, d !== undefined ? d : ""),
  error:   (m, d) => console.error(`[ERROR] ${ts()} ${m}`, d !== undefined ? d : ""),
  success: (m, d) => console.log(`[OK]    ${ts()} ${m}`, d !== undefined ? d : ""),
  step:    (m)    => console.log(`\n${"═".repeat(60)}\n[STEP]  ${ts()} ${m}\n${"═".repeat(60)}`),
};

// ─────────────────────────────────────────────
// SCREENSHOT ON ERROR
// ─────────────────────────────────────────────
async function screenshot(page, label) {
  try {
    fs.mkdirSync(CONFIG.screenshotsDir, { recursive: true });
    const p = path.join(CONFIG.screenshotsDir, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: true });
    log.warn(`Screenshot → ${p}`);
  } catch (e) { log.warn("Screenshot failed", e.message); }
}

// ─────────────────────────────────────────────
// GITHUB API HELPER
// ─────────────────────────────────────────────
function githubGet(urlPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.github.com",
      path:     urlPath,
      method:   "GET",
      headers: {
        "User-Agent":    "appetize-uploader/1.0",
        "Accept":        "application/vnd.github+json",
        "Authorization": `Bearer ${GITHUB_PAT}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`GitHub API ${res.statusCode}: ${data}`));
        } else {
          resolve(JSON.parse(data));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Récupère l'URL de téléchargement d'un artefact GitHub Actions.
 * Retourne l'URL directe du ZIP de l'artefact.
 */
async function getArtifactDownloadUrl(owner, repo, runId, artifactName) {
  log.info(`Recherche de l'artefact "${artifactName}" dans le run ${runId}…`);
  const data = await githubGet(`/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`);

  log.info(`${data.total_count} artefact(s) trouvé(s) dans ce run:`);
  for (const a of data.artifacts) {
    log.info(`  - ${a.name} (${(a.size_in_bytes / 1024 / 1024).toFixed(1)} MB) id=${a.id}`);
  }

  const artifact = data.artifacts.find((a) => a.name === artifactName);
  if (!artifact) {
    throw new Error(
      `Artefact "${artifactName}" introuvable.\nDisponibles: ${data.artifacts.map((a) => a.name).join(", ")}`
    );
  }

  log.success(`Artefact trouvé: ${artifact.name} (${(artifact.size_in_bytes / 1024 / 1024).toFixed(1)} MB)`);
  return { artifactId: artifact.id, owner, repo };
}

// ─────────────────────────────────────────────
// TÉLÉCHARGEMENT ARTEFACT GITHUB (ZIP → APK)
// ─────────────────────────────────────────────

/**
 * Résout le 1er redirect (GitHub → Azure Blob URL pré-signée) sans télécharger le corps.
 * GitHub envoie un redirect 302 vers une URL Azure/S3 pré-signée, valide ~1 min.
 * On ne peut pas passer l'Authorization header sur l'URL signée (Azure la rejette).
 */
function resolveGithubRedirect(url, authHeaders) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   "GET",
      headers:  { "User-Agent": "appetize-uploader/1.0", ...authHeaders },
    };
    const req = https.request(opts, (res) => {
      // Consommer la réponse pour libérer le socket
      res.resume();
      if ((res.statusCode === 302 || res.statusCode === 301) && res.headers.location) {
        resolve(res.headers.location);
      } else {
        reject(new Error(`GitHub redirect attendu (302), reçu: ${res.statusCode}`));
      }
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Télécharge un fichier depuis une URL directe (sans auth — pour URLs pré-signées Azure/S3).
 * Suit les éventuels redirects supplémentaires.
 */
function downloadDirect(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let received = 0;

    function doRequest(reqUrl) {
      const lib = reqUrl.startsWith("https") ? https : http;
      const urlObj = new URL(reqUrl);
      lib.get(
        { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, headers: { "User-Agent": "appetize-uploader/1.0" } },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            doRequest(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} lors du téléchargement`));
            return;
          }
          res.on("data", (chunk) => {
            received += chunk.length;
            process.stdout.write(`\r  Téléchargement: ${(received / 1024 / 1024).toFixed(1)} MB`);
          });
          res.pipe(file);
          file.on("finish", () => { process.stdout.write("\n"); file.close(resolve); });
        }
      ).on("error", reject);
    }
    doRequest(url);
  });
}

/**
 * Télécharge l'artefact GitHub Actions (ZIP), l'extrait avec AdmZip, et retourne le chemin de l'APK.
 */
async function downloadArtifactApk(owner, repo, artifactId) {
  log.step("Téléchargement de l'artefact GitHub Actions");

  const zipPath = path.resolve(__dirname, "artifact.zip");

  // Clean up
  try { fs.unlinkSync(zipPath); } catch {}
  try { fs.unlinkSync(CONFIG.apkOutputPath); } catch {}

  const githubUrl = `https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`;
  const authHeaders = {
    "Authorization":         `Bearer ${GITHUB_PAT}`,
    "Accept":                "application/vnd.github+json",
    "X-GitHub-Api-Version":  "2022-11-28",
  };

  for (let attempt = 1; attempt <= CONFIG.retries.download; attempt++) {
    log.info(`Tentative ${attempt}/${CONFIG.retries.download}…`);
    try {
      // Étape 1: obtenir l'URL pré-signée Azure/S3
      log.info("Résolution de l'URL de téléchargement signée…");
      const signedUrl = await resolveGithubRedirect(githubUrl, authHeaders);
      log.info(`URL signée obtenue (${signedUrl.slice(0, 60)}…)`);

      // Étape 2: télécharger depuis l'URL pré-signée (sans auth)
      log.info("Téléchargement du ZIP…");
      await downloadDirect(signedUrl, zipPath);

      const stats = fs.statSync(zipPath);
      if (stats.size === 0) throw new Error("Fichier ZIP vide (0 bytes)");
      log.success(`ZIP téléchargé: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      break;
    } catch (err) {
      log.error(`Tentative ${attempt} échouée`, err.message);
      if (attempt === CONFIG.retries.download) throw err;
      log.info("Nouvelle tentative dans 3s…");
      await sleep(3000);
    }
  }

  // Extraction du ZIP avec AdmZip (pas besoin d'unzip système)
  log.info("Extraction du ZIP…");
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  log.info(`${entries.length} fichier(s) dans le ZIP:`);
  entries.forEach((e) => log.info(`  - ${e.entryName} (${(e.header.size / 1024 / 1024).toFixed(2)} MB)`));

  // Chercher l'APK directement dans le ZIP
  const apkEntry = entries.find((e) => e.entryName.endsWith(".apk") && !e.isDirectory);
  if (!apkEntry) {
    throw new Error(`Aucun .apk trouvé dans le ZIP. Fichiers: ${entries.map((e) => e.entryName).join(", ")}`);
  }

  log.info(`Extraction de: ${apkEntry.entryName}`);
  const apkData = zip.readFile(apkEntry);
  fs.writeFileSync(CONFIG.apkOutputPath, apkData);

  const stats = fs.statSync(CONFIG.apkOutputPath);
  log.success(`APK prêt: ${CONFIG.apkOutputPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  // Cleanup ZIP
  try { fs.unlinkSync(zipPath); } catch {}

  return CONFIG.apkOutputPath;
}

function findFiles(dir, ext) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(full, ext));
    } else if (ext === "" || entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────
// SESSION / COOKIES
// ─────────────────────────────────────────────
function hasSavedCookies() {
  return fs.existsSync(CONFIG.cookiesFile);
}

const SAMESITE_MAP = {
  no_restriction: "None",
  unspecified: "None",
  lax: "Lax",
  strict: "Strict",
  none: "None",
};

function normalizeCookies(raw) {
  return raw.map((c) => {
    const out = {
      name:     c.name,
      value:    c.value,
      domain:   c.domain,
      path:     c.path    || "/",
      secure:   !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: SAMESITE_MAP[(c.sameSite || "").toLowerCase()] || "None",
    };
    if (c.expirationDate) out.expires = c.expirationDate;
    return out;
  });
}

function loadCookies() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG.cookiesFile, "utf-8"));
    const cookies = normalizeCookies(raw);
    log.info(`${cookies.length} cookies chargés depuis ${CONFIG.cookiesFile}`);
    return cookies;
  } catch (e) {
    log.warn("Impossible de charger les cookies", e.message);
    return null;
  }
}

async function saveCookies(context) {
  try {
    const cookies = await context.cookies();
    fs.writeFileSync(CONFIG.cookiesFile, JSON.stringify(cookies, null, 2));
    log.success(`Session sauvegardée (${cookies.length} cookies → ${CONFIG.cookiesFile})`);
  } catch (e) {
    log.error("Sauvegarde cookies échouée", e.message);
  }
}

function isLoginUrl(url) {
  return /login|sign-in|signin|register|auth/i.test(url);
}

async function isSessionValid(page) {
  log.info("Vérification de la validité de la session…");
  try {
    await page.goto(CONFIG.appetizeUrl, { waitUntil: "domcontentloaded", timeout: CONFIG.timeouts.navigation });
    await sleep(2000);
    const url = page.url();
    if (isLoginUrl(url)) {
      log.warn(`Session invalide/expirée — redirigé vers: ${url}`);
      return false;
    }
    log.success(`Session valide — URL: ${url}`);
    return true;
  } catch (e) {
    log.warn("Impossible de vérifier la session", e.message);
    return false;
  }
}

async function waitForManualLogin(page, context) {
  log.info("Aucune session valide → connexion manuelle requise");
  log.info(`Ouvre appetize.io dans le navigateur et connecte-toi.`);
  log.info(`Tu as ${CONFIG.timeouts.manualLogin / 1000}s pour te connecter.`);

  const deadline = Date.now() + CONFIG.timeouts.manualLogin;
  while (Date.now() < deadline) {
    await sleep(2000);
    const url = page.url();
    if (!isLoginUrl(url) && url.includes("appetize.io")) {
      log.success("Connexion détectée!");
      break;
    }
    if (Date.now() + 2000 >= deadline) {
      throw new Error("Timeout connexion manuelle. Relance le script.");
    }
  }
  await saveCookies(context);
}

async function setupSession(page, context) {
  log.step("Gestion de session");

  if (hasSavedCookies()) {
    const cookies = loadCookies();
    if (cookies) {
      await context.addCookies(cookies);
      log.info("Cookies chargés — vérification de la session en cours…");

      const valid = await isSessionValid(page);
      if (valid) {
        log.success("Session restaurée avec succès depuis cookies.json");
        return;
      }

      log.warn("Session expirée — suppression de cookies.json et reconnexion manuelle requise");
      try { fs.unlinkSync(CONFIG.cookiesFile); } catch {}
    }
  }

  log.info("Aucune session valide sauvegardée → connexion manuelle requise");
  await page.goto(CONFIG.appetizeUrl, { timeout: CONFIG.timeouts.navigation });
  await waitForManualLogin(page, context);
}

// ─────────────────────────────────────────────
// DOM — DETECTION INTELLIGENTE
// ─────────────────────────────────────────────
async function tryFind(page, strategies, timeoutMs = 8000) {
  for (const s of strategies) {
    try {
      const el = s.fn(page);
      await el.waitFor({ state: "visible", timeout: timeoutMs });
      const txt = await el.textContent().catch(() => "");
      log.info(`  ✓ Trouvé via '${s.desc}': "${txt.trim().slice(0, 60)}"`);
      return el;
    } catch {
      log.info(`  ✗ Stratégie '${s.desc}' — non trouvée`);
    }
  }
  return null;
}

async function findUploadButton(page) {
  log.info("Recherche du bouton 'Upload App'…");
  const el = await tryFind(page, [
    { desc: "text exact 'Upload App'",    fn: (p) => p.getByText("Upload App", { exact: true }).first() },
    { desc: "text partial 'Upload'",      fn: (p) => p.getByText("Upload", { exact: false }).first() },
    { desc: "role=button /upload/i",      fn: (p) => p.getByRole("button", { name: /upload/i }).first() },
    { desc: "role=link /upload/i",        fn: (p) => p.getByRole("link", { name: /upload/i }).first() },
    { desc: "aria-label *upload*",        fn: (p) => p.locator('[aria-label*="upload" i]').first() },
    { desc: "button:has-text Upload",     fn: (p) => p.locator('button:has-text("Upload"), a:has-text("Upload")').first() },
    { desc: "data-* upload",              fn: (p) => p.locator('[data-cy*="upload" i],[data-test*="upload" i],[data-testid*="upload" i]').first() },
  ]);
  if (!el) throw new Error("Bouton 'Upload App' introuvable");
  return el;
}

async function findFileInput(page) {
  log.info("Recherche de l'input file…");
  // Les inputs file sont souvent cachés, on utilise count()
  const strategies = [
    { desc: "input[type=file]",               fn: (p) => p.locator('input[type="file"]') },
    { desc: "input[accept*=apk]",             fn: (p) => p.locator('input[accept*=".apk"],input[accept*="application/vnd.android"]') },
    { desc: "input[accept] any",              fn: (p) => p.locator('input[accept]') },
  ];
  for (const s of strategies) {
    const el = s.fn(page);
    const count = await el.count().catch(() => 0);
    if (count > 0) {
      log.success(`Input file trouvé via '${s.desc}' (count=${count})`);
      return el.first();
    }
    log.info(`  ✗ '${s.desc}' — count=0`);
  }
  throw new Error("Input file introuvable");
}

async function findSubmitButton(page) {
  log.info("Recherche du bouton de validation…");
  const el = await tryFind(page, [
    { desc: "role=button /upload/i",     fn: (p) => p.getByRole("button", { name: /upload/i }).first() },
    { desc: "role=button /submit/i",     fn: (p) => p.getByRole("button", { name: /submit/i }).first() },
    { desc: "role=button /confirm/i",    fn: (p) => p.getByRole("button", { name: /confirm/i }).first() },
    { desc: "role=button /save/i",       fn: (p) => p.getByRole("button", { name: /save/i }).first() },
    { desc: "role=button /continue/i",   fn: (p) => p.getByRole("button", { name: /continue/i }).first() },
    { desc: "role=button /next/i",       fn: (p) => p.getByRole("button", { name: /next/i }).first() },
    { desc: "button[type=submit]",       fn: (p) => p.locator('button[type="submit"]').first() },
  ], 6000);
  return el; // peut être null (auto-upload)
}

// ─────────────────────────────────────────────
// UPLOAD FLOW
// ─────────────────────────────────────────────
async function runUploadFlow(page, apkPath) {
  log.step("Flux d'upload");

  log.info(`Navigation → ${CONFIG.appetizeUrl}`);
  await page.goto(CONFIG.appetizeUrl, { waitUntil: "domcontentloaded", timeout: CONFIG.timeouts.navigation });
  await sleep(2000);
  log.info(`URL actuelle: ${page.url()}`);

  // Clic sur Upload App
  const uploadBtn = await findUploadButton(page);
  log.info("Clic sur Upload App…");
  await uploadBtn.click();
  await sleep(2000);

  // Injection du fichier
  const fileInput = await findFileInput(page);
  log.info(`Injection du fichier: ${apkPath}`);
  await fileInput.setInputFiles(apkPath);
  log.success("Fichier injecté dans l'input");
  await sleep(2000);

  // Bouton de confirmation
  const submitBtn = await findSubmitButton(page);
  if (submitBtn) {
    log.info("Clic sur le bouton de validation…");
    await submitBtn.click();
  } else {
    log.warn("Pas de bouton submit trouvé — l'upload s'est peut-être déclenché automatiquement");
  }

  // Attente confirmation
  await waitForUploadConfirmation(page);
}

async function waitForUploadConfirmation(page) {
  log.info("Attente de confirmation d'upload…");
  const initialUrl = page.url();

  try {
    await Promise.race([
      // Succès texte
      page.waitForSelector(
        ':text-matches("success|uploaded|created|ready|complete", "i")',
        { timeout: CONFIG.timeouts.uploadConfirmation, state: "visible" }
      ),
      // Changement d'URL vers une page app (jamais vers login)
      page.waitForURL(
        (url) => {
          const s = url.toString();
          return s !== initialUrl &&
                 s.includes("appetize.io") &&
                 !isLoginUrl(s);
        },
        { timeout: CONFIG.timeouts.uploadConfirmation }
      ),
      // Bouton Close/Done sur dialog
      page.waitForSelector(
        'button:has-text("Close"), button:has-text("Done"), button:has-text("Finish"), button:has-text("OK")',
        { timeout: CONFIG.timeouts.uploadConfirmation, state: "visible" }
      ),
      // Classe success générique
      page.waitForSelector(
        '[class*="success"],[class*="complete"],[role="alert"],[class*="uploaded"]',
        { timeout: CONFIG.timeouts.uploadConfirmation, state: "visible" }
      ),
    ]);

    // Vérification finale : on ne doit pas être sur une page de login
    const finalUrl = page.url();
    if (isLoginUrl(finalUrl)) {
      throw new Error(
        `Upload échoué — redirigé vers la page de login (${finalUrl}). ` +
        `Session expirée. Supprime cookies.json et relance pour te reconnecter.`
      );
    }

    log.success("Upload confirmé avec succès!");
    log.info(`URL finale: ${finalUrl}`);
  } catch (e) {
    throw new Error(`Confirmation d'upload non détectée: ${e.message}`);
  }
}

// ─────────────────────────────────────────────
// LISTE DES APPS
// ─────────────────────────────────────────────
async function listApps(page) {
  log.step("Liste des apps sur Appetize.io");
  await page.goto(CONFIG.appetizeUrl, { waitUntil: "domcontentloaded", timeout: CONFIG.timeouts.navigation });
  await sleep(3000);

  // Analyser les cartes d'apps visibles
  const apps = await page.evaluate(() => {
    const results = [];
    // Chercher toutes les cartes qui ont un nom d'app
    const cards = document.querySelectorAll(
      '[class*="app-card"],[class*="AppCard"],[class*="appCard"],[class*="app_card"],' +
      'li[class*="app"],div[class*="app-item"],article[class*="app"]'
    );
    cards.forEach((card, i) => {
      const name = card.querySelector('h1,h2,h3,h4,[class*="name"],[class*="title"]')?.textContent?.trim();
      const pkg  = card.querySelector('[class*="package"],[class*="bundle"],[class*="id"]')?.textContent?.trim();
      const link = card.querySelector('a')?.href;
      results.push({ index: i, name, pkg, link });
    });

    // Fallback: chercher directement les liens avec /app/
    if (results.length === 0) {
      document.querySelectorAll('a[href*="/app/"]').forEach((a, i) => {
        results.push({ index: i, name: a.textContent?.trim(), link: a.href });
      });
    }
    return results;
  });

  if (apps.length === 0) {
    log.warn("Aucune app trouvée via selectors automatiques");
    log.info("Contenu de la page analysé — prends un screenshot pour debug");
    await screenshot(page, "list-apps-debug");
  } else {
    log.success(`${apps.length} app(s) trouvée(s):`);
    apps.forEach((a) => {
      log.info(`  [${a.index}] ${a.name || "(sans nom)"} — ${a.pkg || ""} → ${a.link || ""}`);
    });
  }
  return apps;
}

// ─────────────────────────────────────────────
// SUPPRESSION D'APP
// ─────────────────────────────────────────────
async function deleteAppFlow(page, targetName) {
  log.step(`Suppression d'app: ${targetName || "(choisir interactive)"}`);

  await page.goto(CONFIG.appetizeUrl, { waitUntil: "domcontentloaded", timeout: CONFIG.timeouts.navigation });
  await sleep(3000);

  // Analyser le DOM d'abord
  log.info("Analyse du DOM des apps…");
  const domInfo = await page.evaluate(() => {
    const info = {};
    // Snapshot HTML simplifié (premiers niveaux)
    const main = document.querySelector('main,[role="main"],#main,#content') || document.body;
    info.bodyClasses = document.body.className;
    info.mainTag = main.tagName;
    // Lister les liens et boutons qui ont "delete" ou "remove" dans aria/text
    const deleteEls = Array.from(document.querySelectorAll('button,a,[role="button"]'))
      .filter(el => {
        const t = (el.textContent + el.getAttribute('aria-label') + el.className).toLowerCase();
        return t.includes('delete') || t.includes('remove') || t.includes('trash') || t.includes('supprimer');
      })
      .map(el => ({ tag: el.tagName, text: el.textContent.trim().slice(0,60), cls: el.className.slice(0,80) }));
    info.deleteElements = deleteEls;
    return info;
  });

  log.info("Éléments delete/remove/trash trouvés directement:", JSON.stringify(domInfo.deleteElements, null, 2));

  // Chercher les app cards et afficher un menu
  // Stratégie: cliquer sur une app pour ouvrir sa page de détail, puis supprimer
  const appLinks = await page.$$('a[href*="/app/"]');
  log.info(`${appLinks.length} lien(s) d'app trouvé(s)`);

  let appNames = [];
  for (const link of appLinks) {
    const text = await link.textContent().catch(() => "");
    const href = await link.getAttribute("href").catch(() => "");
    appNames.push({ text: text.trim(), href });
  }
  // Dédupliquer
  appNames = [...new Map(appNames.map((a) => [a.href, a])).values()];
  log.info("Apps disponibles:", appNames.map((a, i) => `[${i}] ${a.text} (${a.href})`).join("\n  "));

  // Si targetName fourni, chercher l'app correspondante
  let target = null;
  if (targetName) {
    target = appNames.find(
      (a) => a.text.toLowerCase().includes(targetName.toLowerCase()) ||
             a.href.toLowerCase().includes(targetName.toLowerCase())
    );
    if (!target && appNames.length > 0) {
      log.warn(`App "${targetName}" non trouvée. Utilisation de la première app.`);
      target = appNames[0];
    }
  } else if (appNames.length > 0) {
    log.info("Aucun nom cible fourni — utilisation de la première app disponible");
    target = appNames[0];
  }

  if (!target) {
    throw new Error("Aucune app trouvée à supprimer");
  }

  log.info(`Ouverture de la page app: ${target.href}`);

  // Naviguer vers la page de l'app
  const appUrl = target.href.startsWith("http") ? target.href : `https://appetize.io${target.href}`;
  await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: CONFIG.timeouts.navigation });
  await sleep(2000);

  // Chercher le bouton delete/remove sur cette page
  log.info("Recherche du bouton delete sur la page de l'app…");

  // Dump DOM pour debug
  const pageButtons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button,a,[role="button"]'))
      .map(el => ({
        tag:   el.tagName,
        text:  el.textContent.trim().slice(0, 80),
        aria:  el.getAttribute('aria-label') || "",
        cls:   el.className.slice(0, 80),
        href:  el.getAttribute('href') || "",
      }));
  });
  log.info("Tous les boutons/liens sur la page app:");
  pageButtons.forEach((b) => log.info(`  [${b.tag}] "${b.text}" aria="${b.aria}" cls="${b.cls.slice(0,40)}"`));

  const deleteBtn = await tryFind(page, [
    { desc: "text 'Delete'",          fn: (p) => p.getByText("Delete", { exact: true }).first() },
    { desc: "text 'Delete App'",      fn: (p) => p.getByText("Delete App", { exact: false }).first() },
    { desc: "text 'Remove'",          fn: (p) => p.getByText("Remove", { exact: true }).first() },
    { desc: "text 'Delete app'",      fn: (p) => p.getByText(/delete app/i).first() },
    { desc: "role=button /delete/i",  fn: (p) => p.getByRole("button", { name: /delete/i }).first() },
    { desc: "role=button /remove/i",  fn: (p) => p.getByRole("button", { name: /remove/i }).first() },
    { desc: "aria-label *delete*",    fn: (p) => p.locator('[aria-label*="delete" i],[aria-label*="remove" i]').first() },
    { desc: "class *delete*",         fn: (p) => p.locator('[class*="delete"],[class*="Delete"],[class*="remove"]').first() },
    { desc: "trash icon btn",         fn: (p) => p.locator('button svg[class*="trash"], button [class*="trash"]').first() },
    { desc: "data-testid delete",     fn: (p) => p.locator('[data-testid*="delete" i],[data-cy*="delete" i]').first() },
  ], 5000);

  if (!deleteBtn) {
    await screenshot(page, "delete-button-not-found");
    throw new Error(
      "Bouton Delete introuvable sur la page. Vérifie les screenshots pour analyser l'UI."
    );
  }

  log.info("Clic sur Delete…");
  await deleteBtn.click();
  await sleep(1500);

  // Chercher une confirmation dialog (confirm / Yes / OK)
  const confirmBtn = await tryFind(page, [
    { desc: "text 'Yes'",              fn: (p) => p.getByText("Yes", { exact: true }).first() },
    { desc: "text 'Confirm'",          fn: (p) => p.getByText("Confirm", { exact: false }).first() },
    { desc: "text 'Delete' (dialog)",  fn: (p) => p.getByRole("button", { name: /delete/i }).first() },
    { desc: "text 'OK'",               fn: (p) => p.getByRole("button", { name: /^ok$/i }).first() },
    { desc: "text 'Yes, delete'",      fn: (p) => p.getByText(/yes.*delete|delete.*yes/i).first() },
  ], 6000);

  if (confirmBtn) {
    log.info("Confirmation du dialog de suppression…");
    await confirmBtn.click();
    await sleep(2000);
  } else {
    log.info("Pas de dialog de confirmation — suppression directe");
  }

  // Vérification: on devrait être redirigé vers /apps
  try {
    await page.waitForURL((url) => url.includes("/apps") && !url.includes(target.href), {
      timeout: CONFIG.timeouts.deleteConfirmation,
    });
    log.success("App supprimée avec succès! Retour vers /apps.");
  } catch {
    log.warn("Pas de redirection détectée, mais la suppression a peut-être réussi. Vérifie la page.");
    await screenshot(page, "delete-after");
  }
}

// ─────────────────────────────────────────────
// BROWSER SETUP
// ─────────────────────────────────────────────
async function launchBrowser() {
  log.step("Lancement du navigateur");
  const launchOpts = {
    headless: CONFIG.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  };
  const replitChrome = process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (replitChrome) {
    launchOpts.executablePath = replitChrome;
    log.info(`Utilisation du Chromium Replit: ${replitChrome}`);
  }
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  return { browser, context, page };
}

// ─────────────────────────────────────────────
// COMMANDES PRINCIPALES
// ─────────────────────────────────────────────
async function cmdUpload(ownerRepo, runId, artifactName) {
  if (!GITHUB_PAT) throw new Error("GITHUB_PAT non défini. Exporte-le: export GITHUB_PAT=ghp_xxx");

  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) throw new Error("Format owner/repo invalide");

  // 1. Récupérer l'ID de l'artefact
  const { artifactId } = await getArtifactDownloadUrl(owner, repo, runId, artifactName);

  // 2. Télécharger et extraire l'APK
  const apkPath = await downloadArtifactApk(owner, repo, artifactId);

  // 3. Upload sur Appetize
  const { browser, context, page } = await launchBrowser();
  try {
    await setupSession(page, context);

    let lastErr = null;
    for (let attempt = 1; attempt <= CONFIG.retries.upload; attempt++) {
      log.step(`Upload — tentative ${attempt}/${CONFIG.retries.upload}`);
      try {
        await runUploadFlow(page, apkPath);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        log.error(`Tentative ${attempt} échouée`, err.message);
        await screenshot(page, `upload-error-${attempt}`);
        if (attempt < CONFIG.retries.upload) {
          log.info("Nouvelle tentative dans 5s…");
          await sleep(5000);
        }
      }
    }
    if (lastErr) throw lastErr;

    await saveCookies(context);
    log.step("SUCCÈS");
    log.success("APK uploadé sur Appetize.io!");
    log.info("Visible sur: https://appetize.io/apps");
    await sleep(3000);
  } finally {
    await browser.close();
  }
}

async function cmdDelete(targetName) {
  const { browser, context, page } = await launchBrowser();
  try {
    await setupSession(page, context);
    await deleteAppFlow(page, targetName);
    await saveCookies(context);
    await sleep(3000);
  } finally {
    await browser.close();
  }
}

async function cmdList() {
  const { browser, context, page } = await launchBrowser();
  try {
    await setupSession(page, context);
    await listApps(page);
    await sleep(3000);
  } finally {
    await browser.close();
  }
}

async function cmdUploadFile() {
  const apkPath = CONFIG.apkOutputPath;
  if (!fs.existsSync(apkPath)) {
    throw new Error(`APK introuvable: ${apkPath} — télécharge-le d'abord`);
  }
  const stats = fs.statSync(apkPath);
  log.info(`APK existant: ${apkPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  const { browser, context, page } = await launchBrowser();
  try {
    await setupSession(page, context);

    let lastErr = null;
    for (let attempt = 1; attempt <= CONFIG.retries.upload; attempt++) {
      log.step(`Upload — tentative ${attempt}/${CONFIG.retries.upload}`);
      try {
        await runUploadFlow(page, apkPath);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        log.error(`Tentative ${attempt} échouée`, err.message);
        await screenshot(page, `upload-error-${attempt}`);
        if (attempt < CONFIG.retries.upload) {
          log.info("Nouvelle tentative dans 5s…");
          await sleep(5000);
        }
      }
    }
    if (lastErr) throw lastErr;

    await saveCookies(context);
    log.step("SUCCÈS");
    log.success("APK uploadé sur Appetize.io!");
    log.info("Visible sur: https://appetize.io/apps");
    await sleep(3000);
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────
async function main() {
  const [,, cmd, ...args] = process.argv;

  const USAGE = `
Usage:
  node script.js upload  <owner/repo> <run_id> <artifact_name>
  node script.js delete  [nom_ou_key_app]
  node script.js list

Exemples:
  node script.js upload ferelking242/watchtower 24347257733 app-arm64-profile
  node script.js delete watchtower
  node script.js list

Variables d'environnement:
  GITHUB_PAT  — GitHub Personal Access Token (requis pour upload)
`;

  if (!cmd) { console.error(USAGE); process.exit(1); }

  log.step(`Appetize.io Manager — commande: ${cmd}`);

  switch (cmd) {
    case "upload": {
      const [ownerRepo, runId, artifactName] = args;
      if (!ownerRepo || !runId || !artifactName) {
        console.error("upload requiert: <owner/repo> <run_id> <artifact_name>");
        console.error(USAGE);
        process.exit(1);
      }
      await cmdUpload(ownerRepo, runId, artifactName);
      break;
    }
    case "delete": {
      await cmdDelete(args[0] || null);
      break;
    }
    case "list": {
      await cmdList();
      break;
    }
    case "upload-file": {
      // Upload l'APK déjà présent sur disque (pas de téléchargement GitHub)
      await cmdUploadFile();
      break;
    }
    default:
      console.error(`Commande inconnue: ${cmd}`);
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n[FATAL]", err.message);
  process.exit(1);
});
