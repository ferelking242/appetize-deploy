# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Standalone Tools

### `appetize-uploader/`

Node.js + Playwright script that automates APK uploads to Appetize.io from a GitHub URL.

```bash
cd appetize-uploader
npm install
npx playwright install chromium
node script.js <github-apk-url>
```

- Saves session cookies after first manual login — no login required on subsequent runs
- Downloads the APK from GitHub before uploading
- Auto-retries on failure, takes screenshots on error
- All config (timeouts, retries, headless mode) is in the `CONFIG` block at the top of `script.js`
