import { Router } from "express";
import { spawn, type ChildProcess } from "child_process";
import https from "https";
import fs from "fs";
import path from "path";

const router = Router();

const APPETIZE_DIR = path.resolve(process.cwd(), "../../appetize-uploader");
const COOKIES_FILE = path.join(APPETIZE_DIR, "cookies.json");

let runtimePat: string = process.env.GITHUB_PAT || "";

let activeProcess: ChildProcess | null = null;
const logBuffer: string[] = [];
const MAX_BUFFER = 500;

type SSEClient = { res: import("express").Response };
const sseClients: SSEClient[] = [];

function broadcast(line: string) {
  logBuffer.push(line);
  if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
  for (const client of sseClients) {
    try {
      client.res.write(`data: ${JSON.stringify(line)}\n\n`);
    } catch {}
  }
}

function githubGet(urlPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.github.com",
      path: urlPath,
      method: "GET",
      headers: {
        "User-Agent": "appetize-uploader/1.0",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${process.env.GITHUB_PAT || ""}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c));
      res.on("end", () => {
        if ((res.statusCode ?? 0) >= 400) {
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

function parseGithubRunUrl(url: string): { owner: string; repo: string; runId: string } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], runId: m[3] };
}

router.get("/logs", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  for (const line of logBuffer) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }

  const client: SSEClient = { res };
  sseClients.push(client);

  req.on("close", () => {
    const idx = sseClients.indexOf(client);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

router.get("/status", (_req, res) => {
  res.json({
    running: activeProcess !== null,
    cookiesExist: fs.existsSync(COOKIES_FILE),
  });
});

router.get("/artifacts", async (req, res) => {
  const url = req.query.url as string;
  if (!url) {
    res.status(400).json({ error: "url requis" });
    return;
  }

  const parsed = parseGithubRunUrl(url);
  if (!parsed) {
    res.status(400).json({ error: "URL invalide. Format attendu: https://github.com/owner/repo/actions/runs/ID" });
    return;
  }

  try {
    const data = await githubGet(
      `/repos/${parsed.owner}/${parsed.repo}/actions/runs/${parsed.runId}/artifacts`
    ) as { total_count: number; artifacts: Array<{ id: number; name: string; size_in_bytes: number }> };

    res.json({
      owner: parsed.owner,
      repo: `${parsed.owner}/${parsed.repo}`,
      runId: parsed.runId,
      artifacts: data.artifacts.map((a) => ({
        id: a.id,
        name: a.name,
        sizeMb: (a.size_in_bytes / 1024 / 1024).toFixed(1),
      })),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

router.post("/cookies", (req, res) => {
  const { cookies } = req.body as { cookies?: string };
  if (!cookies) {
    res.status(400).json({ error: "cookies requis" });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cookies);
  } catch {
    res.status(400).json({ error: "JSON invalide" });
    return;
  }

  try {
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(parsed, null, 2), "utf-8");
    broadcast(`[DASHBOARD] Cookies sauvegardés → ${COOKIES_FILE}`);
    res.json({ ok: true, message: "Cookies sauvegardés" });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

router.delete("/cookies", (_req, res) => {
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      fs.unlinkSync(COOKIES_FILE);
      broadcast("[DASHBOARD] Cookies supprimés");
    }
    res.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

router.post("/run", (req, res) => {
  if (activeProcess) {
    res.status(409).json({ error: "Un processus est déjà en cours" });
    return;
  }

  const { command, repo, runId, artifactName } = req.body as {
    command: string;
    repo?: string;
    runId?: string;
    artifactName?: string;
  };

  const validCommands = ["upload", "list", "delete"];
  if (!validCommands.includes(command)) {
    res.status(400).json({ error: `Commande invalide` });
    return;
  }

  const args = ["script.js", command];
  if (command === "upload") {
    if (!repo || !runId || !artifactName) {
      res.status(400).json({ error: "repo, runId et artifactName sont requis pour upload" });
      return;
    }
    args.push(repo, runId, artifactName);
  }

  broadcast(`\n${"═".repeat(60)}`);
  broadcast(`[DASHBOARD] Lancement: node ${args.join(" ")}`);
  broadcast(`${"═".repeat(60)}`);

  const child = spawn("node", args, {
    cwd: APPETIZE_DIR,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  activeProcess = child;

  child.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) broadcast(line);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) broadcast(`[ERR] ${line}`);
    }
  });

  child.on("close", (code) => {
    broadcast(`\n[DASHBOARD] Processus terminé — code: ${code}`);
    activeProcess = null;
  });

  child.on("error", (err) => {
    broadcast(`[DASHBOARD] Erreur: ${err.message}`);
    activeProcess = null;
  });

  res.json({ ok: true, pid: child.pid });
});

router.post("/stop", (_req, res) => {
  if (!activeProcess) {
    res.status(404).json({ error: "Aucun processus actif" });
    return;
  }
  activeProcess.kill("SIGTERM");
  broadcast("[DASHBOARD] Signal d'arrêt envoyé");
  res.json({ ok: true });
});

export default router;
