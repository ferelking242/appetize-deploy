# 🗼 Watchtower — Appetize Auto-Uploader

  Automated APK upload service for [Appetize.io](https://appetize.io). Monitors GitHub releases for new APKs and uploads them automatically via a headless browser. Exposes a full REST API for AI agents and CI/CD pipelines.

  **Live app:** [https://indigo-sinful-robots--lotovo9439.replit.app](https://indigo-sinful-robots--lotovo9439.replit.app/api/dashboard/)  
  **Dashboard:** [https://indigo-sinful-robots--lotovo9439.replit.app/api/dashboard/](https://indigo-sinful-robots--lotovo9439.replit.app/api/dashboard/)  
  **API Docs:** [https://indigo-sinful-robots--lotovo9439.replit.app/docs](https://indigo-sinful-robots--lotovo9439.replit.app/docs)

  ---

  ## Features

  - **Auto-monitor** — polls a GitHub repo every 5 minutes, downloads new APKs, and uploads to Appetize
  - **REST API v1** — full authenticated API for AI agents, scripts, and CI/CD
  - **Per-request cookies** — pass session cookies per request (no shared state needed)
  - **SSE log stream** — real-time upload logs over Server-Sent Events
  - **Professional dashboard** — dark UI with live status, log console, and API key management

  ---

  ## Quick Start

  1. Open the [dashboard](https://indigo-sinful-robots--lotovo9439.replit.app/api/dashboard/) and copy your **API key**
  2. Configure your GitHub repo:
  ```bash
  curl -X POST https://indigo-sinful-robots--lotovo9439.replit.app/api/v1/config \
    -H "Authorization: Bearer YOUR_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"repoUrl":"https://github.com/owner/repo","pat":"YOUR_GITHUB_PAT"}'
  ```
  3. Start the auto-monitor:
  ```bash
  curl -X POST https://indigo-sinful-robots--lotovo9439.replit.app/api/v1/monitor/start \
    -H "Authorization: Bearer YOUR_API_KEY"
  ```

  ---

  ## API Reference

  Base URL: `https://indigo-sinful-robots--lotovo9439.replit.app/api/v1`

  Full interactive docs: [https://indigo-sinful-robots--lotovo9439.replit.app/docs](https://indigo-sinful-robots--lotovo9439.replit.app/docs)

  ### Authentication

  All write endpoints require your API key (shown on the dashboard):

  ```
  Authorization: Bearer <your-api-key>
  ```
  or
  ```
  X-Api-Key: <your-api-key>
  ```

  ### Endpoints

  | Method | Path | Auth | Description |
  |--------|------|------|-------------|
  | GET | `/api/v1/` | — | API info & endpoint list |
  | GET | `/api/v1/status` | — | System status |
  | GET | `/api/v1/release` | — | Latest GitHub release info |
  | GET | `/api/v1/logs` | — | SSE real-time log stream |
  | POST | `/api/v1/upload` | ✅ | Trigger full download+upload |
  | POST | `/api/v1/upload/url` | ✅ | Upload from a direct APK URL |
  | POST | `/api/v1/cookies` | ✅ | Save Appetize session cookies |
  | DELETE | `/api/v1/cookies` | ✅ | Delete session cookies |
  | POST | `/api/v1/config` | ✅ | Update repo URL / GitHub PAT |
  | POST | `/api/v1/monitor/start` | ✅ | Start auto-monitor |
  | POST | `/api/v1/monitor/stop` | ✅ | Stop auto-monitor |
  | POST | `/api/v1/monitor/check` | ✅ | Force a release check now |
  | POST | `/api/v1/stop` | ✅ | Kill an active upload |

  ### Upload from URL

  ```bash
  curl -X POST https://indigo-sinful-robots--lotovo9439.replit.app/api/v1/upload/url \
    -H "Authorization: Bearer YOUR_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"apkUrl":"https://example.com/app.apk"}'
  ```

  ### Upload with custom cookies (per-request)

  ```bash
  curl -X POST https://indigo-sinful-robots--lotovo9439.replit.app/api/v1/upload \
    -H "Authorization: Bearer YOUR_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"cookies":[{"name":"connect.sid","value":"...","domain":".appetize.io","path":"/"}]}'
  ```

  ### Stream logs

  ```javascript
  const sse = new EventSource('https://indigo-sinful-robots--lotovo9439.replit.app/api/v1/logs');
  sse.onmessage = e => console.log(JSON.parse(e.data));
  ```

  ---

  ## Deployment

  Hosted on [Replit](https://replit.com) — always on, no setup required.

  | URL | Description |
  |-----|-------------|
  | [https://indigo-sinful-robots--lotovo9439.replit.app/api/dashboard/](https://indigo-sinful-robots--lotovo9439.replit.app/api/dashboard/) | Web dashboard |
  | [https://indigo-sinful-robots--lotovo9439.replit.app/docs](https://indigo-sinful-robots--lotovo9439.replit.app/docs) | API documentation |
  | [https://indigo-sinful-robots--lotovo9439.replit.app/api/v1/](https://indigo-sinful-robots--lotovo9439.replit.app/api/v1/) | API root |

  ---

  ## Tech Stack

  - **Node.js + Express** — API server
  - **Playwright + Chromium** — headless browser for Appetize upload
  - **TypeScript** — compiled to ESM via esbuild
  - **SSE** — real-time log streaming

  ---

  *Built for [ferelking242/watchtower](https://github.com/ferelking242/watchtower)*
  