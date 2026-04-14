# Appetize.io APK Auto-Uploader

Automates uploading any APK from a GitHub URL to your Appetize.io account.  
Stays logged in permanently via saved session cookies.

## Setup (one-time)

```bash
cd appetize-uploader
npm install
npx playwright install chromium
```

## Run

```bash
node script.js <github-apk-url>
```

### Example

```bash
node script.js https://github.com/owner/repo/releases/download/v1.0/app-release.apk
```

GitHub release URLs, artifact download links, and raw CDN links are all supported.

## First Run — Login

On the first run, `cookies.json` does not exist yet.  
The browser will open and navigate to Appetize.io — **log in manually**.  
Once logged in, the script detects the session and saves cookies automatically.

All future runs skip the login step entirely.

## Files

| File | Purpose |
|------|---------|
| `script.js` | Main automation script |
| `cookies.json` | Saved session (auto-created after first login) |
| `app.apk` | Downloaded APK (overwritten each run) |
| `screenshots/` | Error screenshots for debugging |

## Configuration

Edit the `CONFIG` block at the top of `script.js`:

| Option | Default | Description |
|--------|---------|-------------|
| `headless` | `false` | Set `true` to run without opening a browser window |
| `timeouts.navigation` | 60s | Page load timeout |
| `timeouts.uploadConfirmation` | 120s | Upload completion wait |
| `timeouts.manualLogin` | 120s | Time for manual login on first run |
| `retries.upload` | 3 | Retry attempts for the upload flow |
| `retries.download` | 3 | Retry attempts for APK download |

## Troubleshooting

- **Login loop** — Delete `cookies.json` and re-run to force a fresh login
- **Upload button not found** — Appetize.io may have changed their UI; check the `screenshots/` folder
- **File too large** — GitHub has a 2 GB release asset limit; Appetize.io has its own limits too
- **Session expired** — Delete `cookies.json` and run again to re-authenticate
