# Ptengine App Starter

> [English](README.md) | [中文](README.zh-CN.md)

[![latest tag](https://img.shields.io/github/v/tag/ptxdev/ptengine-app-starter)](https://github.com/ptxdev/ptengine-app-starter/tags)
[![Node](https://img.shields.io/badge/node-%3E%3D%2020-brightgreen)](https://nodejs.org)

The official scaffold for building a **Ptengine Custom App**: a front end that the platform loads in a cross-origin iframe, plus an optional Cloudflare Worker backend — built, versioned and shipped as **one zip with one version number**, released and rolled back together.

## Quick Start

Clone a released tag rather than the default branch:

```bash
git clone --branch v3.2.0 --depth 1 https://github.com/ptxdev/ptengine-app-starter.git my-app
cd my-app && rm -rf .git && git init
```

```bash
npm install
npm run dev        # front end + backend, with real tokens signed locally
npm run doctor     # health check: did anything break the platform conventions?
npm run build      # type-check + build the front end + bundle the backend
npm run package    # assemble an uploadable zip
```

Upload the zip from `npm run package` on the Ptengine **Custom App management** page, or run `npx ptx deploy --publish` from CI.

> **Platform prerequisite** — uploading and publishing require App Runtime to be enabled on your Ptengine backend; without it `ptx deploy` returns 404 or 401. **Local `npm run dev` is unaffected.**

## Build it with AI

Install the Ptengine skills so your coding agent knows the platform:

```bash
npx skills add ptxdev/ptengine-skills          # most agents
/plugin marketplace add ptxdev/ptengine-skills # Claude Code
```

Then describe what you want — *"a dashboard of the last 7 days of funnel conversion, with a detail drawer per step"* — and let the agent build it. Before it writes code, have it read:

| File | What it gives the agent |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | The hard boundaries of the platform, and what breaking them looks like |
| `node_modules/@ptengine/design-components/llms.txt` | Component inventory and design rules |
| `node_modules/@ptengine/app-sdk/data-query.llms.txt` | The 18 analytics query types and their parameters |

When it is done, make it run `npm run doctor` — that command exists to turn the conventions in `AGENTS.md` into an executable check, because most violations fail *silently*.

## What's inside

| Path | What it is |
|---|---|
| `web/` | Front end. Static build output; the platform loads it in an iframe and injects `window.PtApp` |
| `backend/` | Backend. One Cloudflare Worker, serving `/api/*` only. Optional |
| `shared/api.ts` | The API contract shared by both sides — the single source of truth |
| `manifest.json` | App declaration: version, entry, scopes, backend resources, secrets, egress |
| `scripts/ptx*.mjs` | The `ptx` CLI: `dev` / `build` / `package` / `deploy` / `doctor` |

## Two kinds of apps

|  | Front end only | With a backend |
|---|---|---|
| `manifest.schemaVersion` | `1` | `2` |
| `backend/` directory | removed | present |
| `manifest.backend` section | absent | present |
| Where data comes from | `PtApp.data.query()` | that, plus your own `/api/*` |
| Good for | dashboards, in-app tools | third-party APIs, your own storage, secrets |

Plenty of apps need no backend at all. To go front-end only: `rm -rf backend/`, drop the `backend` section from `manifest.json`, and set `schemaVersion` back to `1`. **Nothing else changes** — no edits to `tsconfig.json`, `package.json` or anything under `scripts/`. Since v3.2.0 every command branches on the manifest automatically: `dev` starts vite alone, `build` runs `tsc -b web`, `package` produces a front-end-only zip. Details in [`AGENTS.md`](./AGENTS.md#轻应用只有前端).

## `ptx` commands

| Command (also `npx ptx <command>`) | What it does |
|---|---|
| `npm run dev` | vite + `wrangler dev` + a local token endpoint. `PTX_WEB_PORT` / `PTX_API_PORT` move the ports |
| `npm run doctor` | Checks conventions and manifest consistency. `--deps` also reports dependency drift |
| `npm run build` | Type-check (web + backend + shared) + vite build + wrangler bundle |
| `npm run package` | Assemble the zip and self-check its structure |
| `npm run deploy` | Upload. `--publish` releases immediately, `--stream` streams progress, `--dry-run` only prints |

## Local development

**Local auth is real, not bypassed.** `npm run dev` generates a throwaway Ed25519 key pair: the public key goes into `backend/.dev.vars` so the worker really verifies signatures, the private key signs real tokens for the front end. `aud` mismatches, expiry and missing scopes therefore surface locally instead of in production.

Your own configuration and secrets go in `backend/.dev.vars`, one `KEY=VALUE` per line; `ptx dev` only rewrites the `PT_`-prefixed keys it manages and leaves your lines untouched. That file and `web/.ptx-dev-key.json` are gitignored — never commit them. Full rules, including how values are injected and why a restart is needed: [`AGENTS.md`](./AGENTS.md#本地配置backenddevvars).

## Front end

The platform injects `window.PtApp`; read it through `web/src/pt-app.ts`:

```ts
const app = getPtApp();
app?.context;                 // { appId, sid, locale, theme, initialPath }
app?.ui.toast('Saved');
app?.nav.syncRoute('detail');

const res = await app?.data.query({
    queryType: 'funnel_insight',
    params: { timeRange: { key: 'lastDays', days: 7 },
              steps: [{ event: 'page_view' }, { event: 'purchase' }] }
});
```

Build the UI with `@ptengine/design-components` — not antd, MUI or hand-rolled controls — so the app looks like the rest of Ptengine. Routing must be hash-based. Both rules, and the four wiring points that make the component library render correctly, are in [`AGENTS.md`](./AGENTS.md).

## Backend

```ts
export default createApp<ApiRoutes>({
    routes: {
        'GET /orders': async (ctx) => {
            const res = await ctx.fetch('https://api.shopify.com/...', {
                headers: { 'X-Shopify-Access-Token': ctx.secrets.SHOPIFY_TOKEN }
            });
            if (!res.ok) throw ctx.error(502, 'SHOPIFY_UNAVAILABLE');
            /* ... */
        }
    }
});
```

`createApp` verifies every token, pins `aud` to your app, 404s undeclared routes, wraps errors so stacks never leak, and exposes a `/api/__health` probe the platform uses to auto-roll-back a bad release. Call it from the front end with `api('GET /orders', { query: { days: '7' } })` from `web/src/api.ts` — typed from `shared/api.ts`, with token refresh and 401 retry already handled.

Databases, KV, R2, secrets and outbound access are **declared in `manifest.json` and provisioned by the platform** — you never need a Cloudflare account, and `backend/wrangler.jsonc` serves local development only. What `ctx` offers, which Workers features are *not* available (Durable Objects, cron triggers, queues, …), and how secrets differ from vars: [`AGENTS.md`](./AGENTS.md#后端能用的东西ctx).

## manifest.json

```json
{
    "schemaVersion": 2,
    "version": "1.0.0",
    "entry": "index.html",
    "icon": "assets/icon.svg",
    "scopes": ["analytics:read", "ui:notify"],
    "backend": { "entry": "_backend/worker.js", "routes": ["/api/*"], "...": "..." }
}
```

`version` must increase on every upload, `schemaVersion` must be `2` whenever a `backend` section is present, and `scopes` accepts only `analytics:read`, `profile:read`, `user:read` and `ui:notify`. Every field, its limits and the validation rules — mirrored byte-for-byte from the platform into `scripts/rules.json` — are documented in [`AGENTS.md`](./AGENTS.md#manifestjson-字段), and `npm run doctor` checks them before you upload.

## Deploy from CI

```yaml
on:
  push:
    tags: ['v*']
jobs:
  deploy:
    steps:
      - run: npm ci
      - run: npx ptx doctor
      - run: npx ptx build && npx ptx package
      - run: npx ptx deploy --publish
        env:
          PTENGINE_TOKEN: ${{ secrets.PTENGINE_TOKEN }}
          PTENGINE_APP_ID: ${{ vars.PTENGINE_APP_ID }}
```

A ready-made workflow ships in [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml). Generate `PTENGINE_TOKEN` on the **Custom App management** page — per-app, revocable, shown once. Never commit it; `ptx doctor` scans tracked files for leaked tokens. On publish the platform validates the package, uploads the front end, provisions resources, runs migrations, deploys the worker, flips the version pointer atomically and health-probes the result — rolling back automatically if the probe fails.

## Versions & upgrading

The scaffold carries its own semantic version, tagged and released in this repo, separate from the `@ptengine/*` package versions — see the [compatibility matrix](./CHANGELOG.md#兼容矩阵) in the [CHANGELOG](./CHANGELOG.md). Three `version` fields coexist in a project: the git tag belongs to **the scaffold**, while `manifest.json` and `package.json` versions belong to **your app**. `manifest.schemaVersion` is the *platform contract* version, not yours.

Projects already under development usually should **not** upgrade the scaffold — it is a starting point, not a runtime dependency. Follow up only on a **major** release (the CHANGELOG carries migration steps) or to pick up a capability you want.

## FAQ

**Blank page after upload?** Almost always `base` in `web/vite.config.ts` changed to an absolute path. `npm run doctor` says so directly.

**Components render with no styling?** One of the four wiring points is missing — see [`AGENTS.md`](./AGENTS.md), or just run `npm run doctor`.

**`window.PtApp` is undefined?** It is only injected when the platform loads your app. Locally, use `npm run dev`.

**Every local `/api/*` call returns 401?** You started `vite` directly instead of `npm run dev`; the `/__ptx/token` endpoint needs the key pair `ptx dev` generates.

**Backend throws `RESOURCE_NOT_DECLARED` / `SECRET_NOT_DECLARED` / `VAR_NOT_DECLARED`?** That name is not declared in `manifest.json` — or, locally, not in `backend/.dev.vars`. `npm run doctor` tells you which one.

More, including publishing and configuration pitfalls: [`docs/troubleshooting.md`](./docs/troubleshooting.md).
