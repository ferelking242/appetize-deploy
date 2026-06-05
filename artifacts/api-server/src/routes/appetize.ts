import { Router } from "express";
import { spawn, type ChildProcess } from "child_process";
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const router = Router();

const APPETIZE_DIR = path.resolve(process.cwd(), "../../appetize-uploader");
const COOKIES_FILE = path.join(APPETIZE_DIR, "cookies.json");
const APK_PATH = path.join(APPETIZE_DIR, "app.apk");
const STATE_FILE = path.join(APPETIZE_DIR, "monitor-state.json");

// ── State ───────────────────────────────────────────────────────────────────
interface MonitorState {
  repoUrl: string;
  pat: string;
  enabled: boolean;
  lastSeenTag: string;
  lastUploadedTag: string;
  lastCheck: string;
  lastUpload: string;
  lastError: string;
  apiKey?: string;
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

if (!state.apiKey) {
  state.apiKey = randomUUID();
  saveState(state);
}

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

// ── GitHub helpers ──────────────────────────────────────────────────────────
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
  broadcast(`[AUTO] Checking release — ${owner}/${repo}`);
  const release = await getLatestRelease(owner, repo, pat);
  const tag = release.tag_name;
  const apkAsset = release.assets.find((a) => a.name.endsWith(".apk"));
  if (!apkAsset) throw new Error(`No .apk in release ${tag}. Assets: ${release.assets.map((a) => a.name).join(", ")}`);
  broadcast(`[AUTO] Release: ${tag} — APK: ${apkAsset.name} (${(apkAsset.size / 1024 / 1024).toFixed(1)} MB)`);
  broadcast(`[AUTO] Downloading…`);
  const downloadUrl = pat ? apkAsset.url : apkAsset.browser_download_url;
  await downloadFile(downloadUrl, APK_PATH, pat);
  const stats = fs.statSync(APK_PATH);
  broadcast(`[AUTO] APK saved: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  return { tag, assetName: apkAsset.name };
}

// ── Upload process ──────────────────────────────────────────────────────────
function runUploadProcess(cookiesFileOverride?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (activeProcess) {
      reject(new Error("Upload already in progress"));
      return;
    }

    broadcast(`\n${"═".repeat(60)}`);
    broadcast(`[UPLOAD] Launching Appetize upload…`);
    broadcast(`${"═".repeat(60)}`);

    const child = spawn("node", ["script.js", "upload-file"], {
      cwd: APPETIZE_DIR,
      env: {
        ...process.env,
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || "",
        ...(cookiesFileOverride ? { APPETIZE_COOKIES_FILE: cookiesFileOverride } : {}),
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
      broadcast(`[UPLOAD] Done — exit code: ${code}`);
      activeProcess = null;
      if (code === 0) resolve();
      else reject(new Error(`Upload failed (code ${code})`));
    });
    child.on("error", (err) => {
      activeProcess = null;
      reject(err);
    });
  });
}

// ── Monitor ─────────────────────────────────────────────────────────────────
async function checkAndUpload() {
  const parsed = parseRepoFromUrl(state.repoUrl);
  if (!parsed) {
    broadcast("[MONITOR] Repo URL not configured — disabling monitor");
    stopMonitor();
    return;
  }
  state.lastCheck = new Date().toISOString();
  saveState(state);
  try {
    const release = await getLatestRelease(parsed.owner, parsed.repo, state.pat) as GHRelease;
    const tag = release.tag_name;
    broadcast(`[MONITOR] Latest: ${tag} | Last uploaded: ${state.lastUploadedTag || "none"}`);
    if (tag === state.lastUploadedTag) { broadcast(`[MONITOR] No new release`); return; }
    broadcast(`[MONITOR] 🆕 New release: ${tag} — uploading…`);
    state.lastSeenTag = tag;
    saveState(state);
    await downloadLatestApk(parsed.owner, parsed.repo, state.pat);
    await runUploadProcess();
    state.lastUploadedTag = tag;
    state.lastUpload = new Date().toISOString();
    state.lastError = "";
    saveState(state);
    broadcast(`[MONITOR] ✅ Release ${tag} uploaded!`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcast(`[MONITOR] ❌ Error: ${msg}`);
    state.lastError = msg;
    saveState(state);
  }
}

function startMonitor() {
  if (monitorInterval) clearInterval(monitorInterval);
  state.enabled = true;
  saveState(state);
  broadcast("[MONITOR] ✅ Monitoring enabled — checking every 5 min");
  checkAndUpload();
  monitorInterval = setInterval(checkAndUpload, 5 * 60 * 1000);
}

function stopMonitor() {
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
  state.enabled = false;
  saveState(state);
  broadcast("[MONITOR] 🔴 Monitoring disabled");
}

if (state.enabled && state.repoUrl) {
  broadcast("[MONITOR] Resuming monitor from saved state…");
  startMonitor();
}

// ── Legacy SSE ──────────────────────────────────────────────────────────────
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

// ── Legacy Status ───────────────────────────────────────────────────────────
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

// ── API Key (for dashboard only) ────────────────────────────────────────────
router.get("/api-key", (_req, res) => {
  res.json({ apiKey: state.apiKey });
});

// ── Legacy Config ───────────────────────────────────────────────────────────
router.post("/config", (req, res) => {
  const { repoUrl, pat } = req.body as { repoUrl?: string; pat?: string };
  if (repoUrl !== undefined) state.repoUrl = repoUrl.trim();
  if (pat !== undefined && pat.trim()) state.pat = pat.trim();
  saveState(state);
  broadcast(`[CONFIG] Repo: ${state.repoUrl} | PAT: ${state.pat ? "****" : "unset"}`);
  res.json({ ok: true });
});

// ── Legacy Monitor ──────────────────────────────────────────────────────────
router.post("/monitor/start", (_req, res) => {
  if (!state.repoUrl) { res.status(400).json({ error: "Configure GitHub repo first" }); return; }
  startMonitor();
  res.json({ ok: true });
});

router.post("/monitor/stop", (_req, res) => {
  stopMonitor();
  res.json({ ok: true });
});

router.post("/monitor/check-now", (_req, res) => {
  if (!state.repoUrl) { res.status(400).json({ error: "Configure GitHub repo first" }); return; }
  checkAndUpload().catch(() => {});
  res.json({ ok: true });
});

// ── Legacy Release ──────────────────────────────────────────────────────────
router.get("/release", async (_req, res) => {
  const parsed = parseRepoFromUrl(state.repoUrl);
  if (!parsed) { res.status(400).json({ error: "Repo URL not configured" }); return; }
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

// ── Legacy Cookies ──────────────────────────────────────────────────────────
router.post("/cookies", (req, res) => {
  const { cookies } = req.body as { cookies?: string };
  if (!cookies) { res.status(400).json({ error: "cookies required" }); return; }
  try {
    const parsed = JSON.parse(cookies);
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(parsed, null, 2), "utf-8");
    broadcast(`[COOKIES] Session saved (${Array.isArray(parsed) ? parsed.length : "?"} cookies)`);
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.delete("/cookies", (_req, res) => {
  try {
    if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
    broadcast("[COOKIES] Session deleted");
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Legacy Upload ───────────────────────────────────────────────────────────
router.post("/upload-now", async (_req, res) => {
  const parsed = parseRepoFromUrl(state.repoUrl);
  if (!parsed) { res.status(400).json({ error: "Configure GitHub repo first" }); return; }
  if (activeProcess) { res.status(409).json({ error: "Upload already in progress" }); return; }
  res.json({ ok: true, message: "Upload started" });
  try {
    const { tag } = await downloadLatestApk(parsed.owner, parsed.repo, state.pat);
    await runUploadProcess();
    state.lastUploadedTag = tag;
    state.lastUpload = new Date().toISOString();
    state.lastError = "";
    saveState(state);
    broadcast(`[UPLOAD] ✅ ${tag} uploaded!`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    state.lastError = msg;
    saveState(state);
    broadcast(`[UPLOAD] ❌ ${msg}`);
  }
});

router.post("/stop", (_req, res) => {
  if (!activeProcess) { res.status(404).json({ error: "No active process" }); return; }
  activeProcess.kill("SIGTERM");
  broadcast("[UPLOAD] Stop signal sent");
  res.json({ ok: true });
});

export default router;

// ════════════════════════════════════════════════════════════════════════════
// API v1 — authenticated, AI-friendly REST API
// ════════════════════════════════════════════════════════════════════════════

export const v1Router = Router();

function requireApiKey(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
) {
  const auth = req.headers.authorization;
  const xkey = req.headers["x-api-key"] as string | undefined;
  const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : xkey;
  if (provided && provided === state.apiKey) return next();
  res.status(401).json({
    error: "Unauthorized",
    hint: "Pass your API key via: Authorization: Bearer <key>  OR  X-Api-Key: <key>",
    docs: "https://ferelking242.github.io/Appetize",
  });
}

// GET / — API info (public)
v1Router.get("/", (_req, res) => {
  res.json({
    name: "Watchtower Appetize Uploader",
    version: "1.0.0",
    docs: "https://ferelking242.github.io/Appetize",
    dashboard: "/api/dashboard/",
    endpoints: {
      "GET  /api/v1/status":           "System status (public)",
      "GET  /api/v1/release":          "Latest GitHub release (public)",
      "GET  /api/v1/logs":             "SSE log stream (public)",
      "POST /api/v1/upload":           "Trigger upload — body: {cookies?,pat?,repoUrl?,apkUrl?} [auth]",
      "POST /api/v1/upload/url":       "Upload from direct APK URL — body: {apkUrl,cookies?} [auth]",
      "POST /api/v1/cookies":          "Save session cookies — body: {cookies:[...]} [auth]",
      "DELETE /api/v1/cookies":        "Delete session cookies [auth]",
      "POST /api/v1/config":           "Update config — body: {repoUrl?,pat?} [auth]",
      "POST /api/v1/monitor/start":    "Start auto-monitor [auth]",
      "POST /api/v1/monitor/stop":     "Stop auto-monitor [auth]",
      "POST /api/v1/monitor/check":    "Force release check now [auth]",
      "POST /api/v1/stop":             "Kill active upload [auth]",
    },
  });
});

// GET /status — public
v1Router.get("/status", (_req, res) => {
  const apkStat = fs.existsSync(APK_PATH) ? fs.statSync(APK_PATH) : null;
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    running: activeProcess !== null,
    session: {
      active: fs.existsSync(COOKIES_FILE),
    },
    apk: {
      cached: !!apkStat,
      sizeMb: apkStat ? +(apkStat.size / 1024 / 1024).toFixed(1) : null,
    },
    monitor: {
      enabled: state.enabled,
      repoUrl: state.repoUrl,
      hasPat: !!state.pat,
      lastSeenTag: state.lastSeenTag || null,
      lastUploadedTag: state.lastUploadedTag || null,
      lastCheck: state.lastCheck || null,
      lastUpload: state.lastUpload || null,
      lastError: state.lastError || null,
    },
  });
});

// GET /release — public
v1Router.get("/release", async (_req, res) => {
  const parsed = parseRepoFromUrl(state.repoUrl);
  if (!parsed) { res.status(400).json({ error: "Repo URL not configured. POST /api/v1/config first." }); return; }
  try {
    const release = await getLatestRelease(parsed.owner, parsed.repo, state.pat) as GHRelease;
    const apk = release.assets.find((a) => a.name.endsWith(".apk"));
    res.json({
      tag: release.tag_name,
      name: release.name,
      publishedAt: release.published_at,
      htmlUrl: release.html_url,
      uploaded: release.tag_name === state.lastUploadedTag,
      apk: apk
        ? { name: apk.name, sizeMb: +(apk.size / 1024 / 1024).toFixed(1), downloadUrl: apk.browser_download_url }
        : null,
    });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /logs — SSE stream (public)
v1Router.get("/logs", (req, res) => {
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

// POST /upload [auth] — trigger full upload (download + upload to Appetize)
// Body (all optional): cookies, pat, repoUrl, apkUrl
v1Router.post("/upload", requireApiKey, async (req, res) => {
  if (activeProcess) { res.status(409).json({ error: "Upload already in progress" }); return; }

  const body = req.body as {
    cookies?: unknown[];
    pat?: string;
    repoUrl?: string;
    apkUrl?: string;
  };

  const effectivePat = body.pat?.trim() || state.pat;
  const effectiveRepoUrl = body.repoUrl?.trim() || state.repoUrl;

  let tempCookiesFile: string | null = null;
  if (Array.isArray(body.cookies) && body.cookies.length > 0) {
    tempCookiesFile = path.join("/tmp", `appetize-cookies-${Date.now()}.json`);
    fs.writeFileSync(tempCookiesFile, JSON.stringify(body.cookies, null, 2));
    broadcast(`[API v1] Using per-request cookies (${body.cookies.length} cookies)`);
  }

  res.json({ ok: true, message: "Upload started", logsUrl: "/api/v1/logs" });

  try {
    if (body.apkUrl) {
      broadcast(`[API v1] Downloading APK from: ${body.apkUrl}`);
      await downloadFile(body.apkUrl, APK_PATH, effectivePat);
    } else {
      const parsed = parseRepoFromUrl(effectiveRepoUrl);
      if (!parsed) throw new Error("Repo URL not configured — pass repoUrl in body or POST /api/v1/config");
      const { tag } = await downloadLatestApk(parsed.owner, parsed.repo, effectivePat);
      state.lastSeenTag = tag;
      saveState(state);
    }

    await runUploadProcess(tempCookiesFile ?? undefined);

    state.lastUpload = new Date().toISOString();
    state.lastError = "";
    saveState(state);
    broadcast("[API v1] ✅ Upload successful");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    state.lastError = msg;
    saveState(state);
    broadcast(`[API v1] ❌ ${msg}`);
  } finally {
    if (tempCookiesFile && fs.existsSync(tempCookiesFile)) {
      try { fs.unlinkSync(tempCookiesFile); } catch {}
    }
  }
});

// POST /upload/url [auth] — download from direct URL and upload
v1Router.post("/upload/url", requireApiKey, async (req, res) => {
  const { apkUrl, cookies } = req.body as { apkUrl?: string; cookies?: unknown[] };
  if (!apkUrl) { res.status(400).json({ error: "apkUrl is required" }); return; }
  if (activeProcess) { res.status(409).json({ error: "Upload already in progress" }); return; }

  let tempCookiesFile: string | null = null;
  if (Array.isArray(cookies) && cookies.length > 0) {
    tempCookiesFile = path.join("/tmp", `appetize-cookies-${Date.now()}.json`);
    fs.writeFileSync(tempCookiesFile, JSON.stringify(cookies, null, 2));
  }

  res.json({ ok: true, message: "Upload started", logsUrl: "/api/v1/logs" });

  try {
    broadcast(`[API v1] Downloading APK from URL: ${apkUrl}`);
    await downloadFile(apkUrl, APK_PATH, state.pat);
    await runUploadProcess(tempCookiesFile ?? undefined);
    broadcast("[API v1] ✅ Upload from URL successful");
  } catch (err: unknown) {
    broadcast(`[API v1] ❌ ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (tempCookiesFile && fs.existsSync(tempCookiesFile)) {
      try { fs.unlinkSync(tempCookiesFile); } catch {}
    }
  }
});

// POST /cookies [auth] — update stored session cookies
v1Router.post("/cookies", requireApiKey, (req, res) => {
  const { cookies } = req.body as { cookies?: unknown };
  if (!cookies) { res.status(400).json({ error: "cookies array required in body" }); return; }
  try {
    const arr = typeof cookies === "string" ? JSON.parse(cookies) : cookies;
    if (!Array.isArray(arr)) { res.status(400).json({ error: "cookies must be an array" }); return; }
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(arr, null, 2), "utf-8");
    broadcast(`[API v1] Session cookies updated (${arr.length} cookies)`);
    res.json({ ok: true, count: arr.length });
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// DELETE /cookies [auth]
v1Router.delete("/cookies", requireApiKey, (_req, res) => {
  try {
    if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
    broadcast("[API v1] Session cookies deleted");
    res.json({ ok: true });
  } catch (e: unknown) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /config [auth]
v1Router.post("/config", requireApiKey, (req, res) => {
  const { repoUrl, pat } = req.body as { repoUrl?: string; pat?: string };
  if (repoUrl?.trim()) state.repoUrl = repoUrl.trim();
  if (pat?.trim()) state.pat = pat.trim();
  saveState(state);
  broadcast(`[API v1] Config updated — repo: ${state.repoUrl}`);
  res.json({ ok: true, repoUrl: state.repoUrl, hasPat: !!state.pat });
});

// POST /monitor/start [auth]
v1Router.post("/monitor/start", requireApiKey, (_req, res) => {
  if (!state.repoUrl) { res.status(400).json({ error: "Configure repo URL first via POST /api/v1/config" }); return; }
  startMonitor();
  res.json({ ok: true, message: "Monitor started" });
});

// POST /monitor/stop [auth]
v1Router.post("/monitor/stop", requireApiKey, (_req, res) => {
  stopMonitor();
  res.json({ ok: true, message: "Monitor stopped" });
});

// POST /monitor/check [auth]
v1Router.post("/monitor/check", requireApiKey, (_req, res) => {
  if (!state.repoUrl) { res.status(400).json({ error: "Configure repo URL first" }); return; }
  checkAndUpload().catch(() => {});
  res.json({ ok: true, message: "Check triggered" });
});

// POST /stop [auth]
v1Router.post("/stop", requireApiKey, (_req, res) => {
  if (!activeProcess) { res.status(404).json({ error: "No active upload process" }); return; }
  activeProcess.kill("SIGTERM");
  broadcast("[API v1] Upload stopped");
  res.json({ ok: true });
});
