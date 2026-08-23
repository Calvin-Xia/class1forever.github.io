# Repository Guidelines

## Project Overview
Static classmate-distribution map ("蹭饭地图"). The page shows public province/city aggregate counts; names and schools are returned per-region only after a passphrase-authenticated session provided by Cloudflare Pages Functions + KV. Student data is never shipped as a static asset.

## Project Structure & Module Organization
- `index.html`: single-page entry point and script loading order (Highmaps CDN fallback chain).
- `css/main.css`: layout, theme, tooltip, bottom-sheet, and auth-modal styles.
- `js/map.js`: map init (Highcharts Map), drilldown, tooltip, public-data fetch, passphrase/detail flow, share image.
- `js/china.js`, `js/province/*.js`: national/province geometry (registered as `Highcharts.maps` entries).
- `js/vendor/*.js`: local Highmaps/drilldown/exporting fallbacks.
- `js/data.js`: local-only input for the upload script; gitignored, never loaded by the page.
- `js/data.template.js`: data shape template (`name/school/city/province`).
- `functions/`: Pages Functions routes — `api/map/public`, `api/map/details`, `api/auth/details`, `api/auth/logout`.
- `shared/data-model.mjs`: normalization, province aliases, aggregate build, region filter/sort (used by Functions and the upload script).
- `scripts/upload-kv-data.mjs`: builds `students:raw:v1` / `students:public:v1` and uploads them to `CLASS_MAP_DATA` KV; sources from `js/data.js` or the `STUDENTS_DATA` env var.
- `build.js`: static safety check — fails if `index.html` still loads `js/data.js`.
- `wrangler.jsonc`, `README.md`, `DEPLOYMENT.md`: Cloudflare config, usage, and deployment docs.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run build`: static safety check only; no bundling — files are served as-is from the repo root.
- `npm run cf:dev`: local Cloudflare Pages dev server (serves `/api/*`; use this instead of a plain static server like `python -m http.server`). In non-interactive shells it needs `CLOUDFLARE_API_TOKEN` (or `wrangler login` once interactively) to reach the remote KV.
- `npm run data:upload -- --dry-run`: validate the data source can build both KV datasets.
- `npm run data:upload` / `npm run data:upload:preview`: upload to production / preview KV.
- `git log --oneline -n 10`: inspect recent commit style before committing.

## Coding Style & Naming Conventions
- Use UTF-8 for reads/writes; 4-space indentation in HTML/CSS/JS.
- JavaScript uses camelCase; keep functions focused.
- CSS follows existing component/modifier patterns such as `map-frame__corner--tl`.
- Province map filenames stay lowercase pinyin (example: `zhejiang.js`).
- No linter/formatter; keep changes minimal and consistent with nearby code.

## Security & Data Rules
- Never commit `.dev.vars`, `js/data.js`, or any full student list; never serve them as static assets.
- Passphrase and session secrets come from Cloudflare secrets (`DETAILS_PASSPHRASE`, `DETAILS_SESSION_SECRET`) or local `.dev.vars`; never hardcode them.

## Testing Guidelines
No automated framework; CI (`.github/workflows/ci.yml`) runs `npm run build` plus `node --check` over all app files on push/PR. Manual smoke tests:
1. `npm run cf:dev`, open the page, verify map render + legend (public aggregates only).
2. Verify drilldown and drill-up interactions (province maps are lazy-loaded on drilldown).
3. Verify tooltip behavior (desktop hover) and bottom sheet (mobile).
4. Verify passphrase flow: wrong passphrase rejected, rate limit enforced, region details load after login, "退出查看" clears the session.
5. `npm run build` passes; `npm run data:upload -- --dry-run` succeeds.
If automated tests are introduced later, place them under `tests/` with `*.test.js` naming.

## Commit & Pull Request Guidelines
Recent commits use short imperative subjects (`Add ...`, `Update ...`, `Improve ...`, `Use ...`):
- Keep subject lines concise and action-oriented.
- Scope each commit to one logical change.
- PRs should include a summary, why the change is needed, validation steps, and screenshots for UI updates.
- Link related issues when applicable.
- Never commit sensitive student data; keep `js/data.js` untracked.
