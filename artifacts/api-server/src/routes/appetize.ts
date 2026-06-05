import { Router } from "express";
import { spawn, type ChildProcess } from "child_process";
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";

const router = Router();

const APPETIZE_DIR = path.resolve(process.cwd(), "../../appetize-uploader");
const COOKIES_FILE = path.join(APPETIZE_DIR, "cookies.json");
const APK_PATH = path.join(APPETIZE_DIR, "app.apk");
const STATE_FILE = path.join(APPETIZE_DIR, "monitor-state.json");

// ── Runtime state ──────────────────────────────────────────────────────────
interface MonitorState {
  repoUrl: string;
  pat: string;
  enabled: boolean;
  lastSeenTag: string;
  lastUploadedTag: string;
  lastCheck: string;
  lastUpload: string;
  lastError: string;
}

function loadState(): MonitorState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {
      repoUrl: "",
      pat: process.env.GITHUB_PAT || "",
      enabled: false,
      lastSeenTag: "",
      lastUploadedTag: "",
      lastCheck: "",
      lastUpload: "",
      lastError: "",
    };
  }
}

function saveState(s: MonitorState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

let state = loadState();
let activeProcess: ChildProcess | null = null;
let monitorInterval: ReturnType<typeof setInterval> | null = null;

const logBuffer: string[] = [];
const MAX_BUFFER = 800;
type SSEClient = { res: import("express").Response };
const sseClients: SSEClient[] = [];

function broadcast(line: string) {
  logBuffer.push(line);
  if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
  for (const c of sseClients) {
    try { c.res.write(`data: ${JSON.stringify(line)}\n\n`); } catch {}
  }
}

// ── GitHub helpers ─────────────────────────────────────────────────────────
function githubRequest(url: string, pat: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      headers: {
        "User-Agent": "appetize-watcher/1.0",
        Accept: "application/vnd.github+json",
        ...(pat ? { Authorization: `Bearer ${pat}` } : {}),
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c));
      res.on("end", () => {
        if ((res.statusCode ?? 0) >= 400) reject(new Error(`GitHub ${res.statusCode}: ${data}`));
        else resolve(JSON.parse(data));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function parseRepoFromUrl(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/\s]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

interface GHRelease {
  tag_name: string;
  name: string;
  published_at: string;
  html_url: string;
  assets: Array<{ name: string; size: number; browser_download_url: string; url: string }>;
}

async function getLatestRelease(owner: string, repo: string, pat: string): Promise<GHRelease> {
  return githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
    pat
  ) as Promise<GHRelease>;
}

function downloadFile(url: string, dest: string, pat: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let received = 0;

    function doReq(reqUrl: string, withAuth: boolean) {
      const u = new URL(reqUrl);
      const lib = u.protocol === "https:" ? https : http;
      const headers: Record<string, string> = { "User-Agent": "appetize-watcher/1.0" };
      if (withAuth && pat) {
        headers["Authorization"] = `Bearer ${pat}`;
        headers["Accept"] = "application/octet-stream";
      }
      lib.get(
        { hostname: u.hostname, path: u.pathname + u.search, headers },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            doReq(res.headers.location, false);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} downloading APK`));
            return;
          }
          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            process.stdout.write(`\r  Download: ${(received / 1024 / 1024).toFixed(1)} MB`);
          });
          res.pipe(file);
          file.on("finish", () => { process.stdout.write("\n"); file.close(() => resolve()); });
        }
      ).on("error", reject);
    }

    doReq(url, true);
  });
}

async function downloadLatestApk(owner: string, repo: string, pat: string): Promise<{ tag: string; assetName: string }> {
  broadcast(`[AUTO] Vérification release — ${owner}/${repo}`);
  const release = await getLatestRelease(owner, repo, pat);
  const tag = release.tag_name;

  const apkAsset = release.assets.find((a) => a.name.endsWith(".apk"));
  if (!apkAsset) throw new Error(`Aucun .apk dans la release ${tag}. Assets: ${release.assets.map((a) => a.name).join(", ")}`);

  broadcast(`[AUTO] Release: ${tag} — APK: ${apkAsset.name} (${(apkAsset.size / 1024 / 1024).toFixed(1)} MB)`);
  broadcast(`[AUTO] Téléchargement…`);

  // Use API URL for private repos (needs auth + redirect), browser_download_url for public
  const downloadUrl = pat ? apkAsset.url : apkAsset.browser_download_url;
  await downloadFile(downloadUrl, APK_PATH, pat);

  const stats = fs.statSync(APK_PATH);
  broadcast(`[AUTO] APK sauvegardé: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  return { tag, assetName: apkAsset.name };
}

// ── Upload process ─────────────────────────────────────────────────────────
function runUploadProcess(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (activeProcess) {
      reject(new Error("Un upload est déjà en cours"));
      return;
    }

    broadcast(`\n${"═".repeat(60)}`);
    broadcast(`[UPLOAD] Lancement de l'upload Appetize…`);
    broadcast(`${"═".repeat(60)}`);

    const child = spawn("node", ["script.js", "upload-file"], {
      cwd: APPETIZE_DIR,
      env: {
        ...process.env,
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    activeProcess = child;

    child.stdout?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) { if (line.trim()) broadcast(line); }
    });
    child.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) { if (line.trim()) broadcast(`[ERR] ${line}`); }
    });
    child.on("close", (code) => {
      broadcast(`[UPLOAD] Terminé — code: ${code}`);
      activeProcess = null;
      if (code === 0) resolve();
      else reject(new Error(`Upload échoué (code ${code})`));
    });
    child.on("error", (err) => {
      activeProcess = null;
      reject(err);
    });
  });
}

// ── Monitor loop ───────────────────────────────────────────────────────────
async function checkAndUpload() {
  const parsed = parseRepoFromUrl(state.repoUrl);
  if (!parsed) {
    broadcast("[MONITOR] URL du repo non configurée — désactivation du monitor");
    stopMonitor();
    return;
  }

  state.lastCheck = new Date().toISOString();
  saveState(state);

  try {
    const release = await getLatestRelease(parsed.owner, parsed.repo, state.pat) as GHRelease;
    const tag = release.tag_name;
    broadcast(`[MONITOR] Dernière release: ${tag} | Dernière uploadée: ${state.lastUploadedTag || "aucune"}`);

    if (tag === state.lastUploadedTag) {
      broadcast(`[MONITOR] Pas de nouvelle release — rien à faire`);
      return;
    }

    broadcast(`[MONITOR] 🆕 Nouvelle release détectée: ${tag} — upload en cours…`);
    state.lastSeenTag = tag;
    saveState(state);

    // Download APK
    await downloadLatestApk(parsed.owner, parsed.repo, state.pat);

    // Upload to Appetize
    await runUploadProcess();

    state.lastUploadedTag = tag;
    state.lastUpload = new Date().toISOString();
    state.lastError = "";
    saveState(state);
    broadcast(`[MONITOR] ✅ Release ${tag} uploadée avec succès!`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcast(`[MONITOR] ❌ Erreur: ${msg}`);
    state.lastError = msg;
    saveState(state);
  }
}

function startMonitor() {
  if (monitorInterval) clearInterval(monitorInterval);
  state.enabled = true;
  saveState(state);
  broadcast("[MONITOR] ✅ Surveillance activée — vérification toutes les 5 min");
  checkAndUpload();
  monitorInterval = setInterval(checkAndUpload, 5 * 60 * 1000);
}

function stopMonitor() {
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
  state.enabled = false;
  saveState(state);
  broadcast("[MONITOR] 🔴 Surveillance désactivée");
}

// Auto-restart monitor if it was enabled
if (state.enabled && state.repoUrl) {
  broadcast("[MONITOR] Reprise du monitor depuis le dernier état…");
  startMonitor();
}

// ── SSE ────────────────────────────────────────────────────────────────────
router.get("/logs", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  for (const line of logBuffer) res.write(`data: ${JSON.stringify(line)}\n\n`);
  const client: SSEClient = { res };
  sseClients.push(client);
  req.on("close", () => {
    const i = sseClients.indexOf(client);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

// ── Status ─────────────────────────────────────────────────────────────────
router.get("/status", (_req, res) => {
  res.json({
    running: activeProcess !== null,
    cookiesExist: fs.existsSync(COOKIES_FILE),
    apkExists: fs.existsSync(APK_PATH),
    monitor: {
      enabled: state.enabled,
      repoUrl: state.repoUrl,
      hasPat: !!state.pat,
      lastSeenTag: state.lastSeenTag,
      lastUploadedTag: state.lastUploadedTag,
      lastCheck: state.lastCheck,
      lastUpload: state.lastUpload,
      lastError: state.lastError,
    },
  });
});

// ── Config ─────────────────────────────────────────────────────────────────
router.post("/config", (req, res) => {
  const { repoUrl, pat } = req.body as { repoUrl?: string; pat?: string };
  if (repoUrl !== undefined) state.repoUrl = repoUrl.trim();
  if (pat !== undefined && pat.trim()) state.pat = pat.trim();
  saveState(state);
  broadcast(`[CONFIG] Repo: ${state.repoUrl} | PAT: ${state.pat ? "****" : "non défini"}`);
  res.json({ ok: true });
});

// ── Monitor toggle ──────────────────────────────────────────────────────────
router.post("/monitor/start", (_req, res) => {
  if (!state.repoUrl) { res.status(400).json({ error: "Configure le repo GitHub d'abord" }); return; }
  startMonitor();
  res.json({ ok: true });
});

router.post("/monitor/stop", (_req, res) => {
  stopMonitor();
  res.json({ ok: true });
});

router.post("/monitor/check-now", (_req, res) => {
  if (!state.repoUrl) { res.status(400).json({ error: "Configure le repo GitHub d'abord" }); return; }
  checkAndUpload().catch(() => {});
  res.json({ ok: true });
});

// ── Release info ────────────────────────────────────────────────────────────
router.get("/release", async (_req, res) => {
  const parsed = parseRepoFromUrl(state.repoUrl);
  if (!parsed) { res.status(400).json({ error: "URL du repo non configurée" }); return; }
  try {
    const release = await getLatestRelease(parsed.owner, parsed.repo, state.pat) as GHRelease;
    const apk = release.assets.find((a) => a.name.endsWith(".apk"));
    res.json({
      tag: release.tag_name,
      name: release.name,
      publishedAt: release.published_at,
      htmlUrl: release.html_url,
      apkName: apk?.name ?? null,
      apkSizeMb: apk ? (apk.size / 1024 / 1024).toFixed(1) : null,
    });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Cookies ─────────────────────────────────────────────────────────────────
router.post("/cookies", (req, res) => {
  const { cookies } = req.body as { cookies?: string };
  if (!cookies) { res.status(400).json({ error: "cookies requis" }); return; }
  try {
    const parsed = JSON.parse(cookies);
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(parsed, null, 2), "utf-8");
    broadcast(`[COOKIES] Session sauvegardée (${Array.isArray(parsed) ? parsed.length : "?"} cookies)`);
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.delete("/cookies", (_req, res) => {
  try {
    if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
    broadcast("[COOKIES] Session supprimée");
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Manual upload ───────────────────────────────────────────────────────────
router.post("/upload-now", async (_req, res) => {
  const parsed = parseRepoFromUrl(state.repoUrl);
  if (!parsed) { res.status(400).json({ error: "Configure le repo GitHub d'abord" }); return; }
  if (activeProcess) { res.status(409).json({ error: "Un upload est déjà en cours" }); return; }

  res.json({ ok: true, message: "Upload démarré" });

  try {
    const { tag } = await downloadLatestApk(parsed.owner, parsed.repo, state.pat);
    await runUploadProcess();
    state.lastUploadedTag = tag;
    state.lastUpload = new Date().toISOString();
    state.lastError = "";
    saveState(state);
    broadcast(`[UPLOAD] ✅ ${tag} uploadé!`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    state.lastError = msg;
    saveState(state);
    broadcast(`[UPLOAD] ❌ ${msg}`);
  }
});

router.post("/stop", (_req, res) => {
  if (!activeProcess) { res.status(404).json({ error: "Aucun processus actif" }); return; }
  activeProcess.kill("SIGTERM");
  broadcast("[UPLOAD] Signal d'arrêt envoyé");
  res.json({ ok: true });
});

export default router;
