# Deploying DNA Outreach

Two parts: **backend → Railway**, **frontend → Netlify**. Deploy the backend first.

## 1) Backend → Railway

1. Create a new Railway project → **Deploy from GitHub repo** (or `railway up`).
2. Set the **Root Directory** to `backend`.  ← the backend lives at the repo root, in `backend/`
3. Add a **PostgreSQL** plugin (Railway → New → Database → Postgres).
   Railway automatically injects `DATABASE_URL`.
4. Railway sets `PORT` automatically — the app reads it.
5. Deploy. You'll get a URL like `https://your-backend.up.railway.app`.

**Environment variables (Railway):**
| Var | Needed | Notes |
|-----|--------|-------|
| `DATABASE_URL` | auto (from Postgres plugin) | Persistent storage |
| `PORT` | auto | Provided by Railway |
| `RESEND_API_KEY` | optional | Or set it later in the app's Settings screen |
| `APP_URL` | recommended | This backend's public URL, for unsubscribe/open links |

> If you don't add Postgres, the app falls back to an embedded SQLite file, but data won't persist across redeploys. Use Postgres in production.

## 2) Frontend → Netlify

1. New site from Git → set **Base directory** to `frontend`.
2. Build command: `bun run build` · Publish directory: `dist` (already in `netlify.toml`).
3. Connect it to the backend — pick ONE:
   - **Proxy (recommended):** in `frontend/netlify.toml`, uncomment the `/api/*` redirect and set it to your Railway URL. No CORS, no env needed.
   - **Env var:** set `VITE_API_URL` = your Railway URL in Netlify → Site settings → Environment.
4. Deploy.

## 3) After deploy
- Open the app → **Settings** → paste your **Resend API key** and set **App URL** to your Railway backend URL.
- Add your **secondary sending domains** (verified in Resend). Never use `dna.systems`.
- Import/crawl contacts, pick a template, and send.

## Local development
```bash
# from the repo root (the folder created when you clone the repo)
bun run install:all   # installs backend + frontend
bun run dev           # backend :3001 + frontend :5173 (proxied)
```
