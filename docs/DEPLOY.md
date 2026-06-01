# Deploy & Run — Assisty backend

Assisty is a NestJS monolith backed by Postgres (with pgvector) and a LiteLLM
proxy. This guide covers local development with Docker Compose and production
deployment on Railway.

---

## Local development

### Prerequisites
- Docker + Docker Compose
- Node >= 20 (only needed if you want to run migrations from the host)

### 1. Configure environment
```bash
cp .env.example .env
```
Edit `.env` and set at minimum:
- `OPENAI_API_KEY` (and optionally `GEMINI_API_KEY`, `OPENROUTER_API_KEY`)
- `LITELLM_MASTER_KEY` — and make `LITELLM_API_KEY` match it
- `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`

For compose, keep `DATABASE_URL` pointing at the `postgres` service:
```
DATABASE_URL=postgresql://assisty:assisty@postgres:5432/assisty
```

### 2. Start the stack
```bash
docker compose up --build
```
This starts three services:
| Service   | Port | Purpose                                   |
|-----------|------|-------------------------------------------|
| postgres  | 5432 | Postgres 16 + pgvector (data store, queue)|
| litellm   | 4000 | OpenAI-compatible model gateway           |
| api       | 3000 | NestJS backend (`npm run start:dev`)      |

The API waits for Postgres to be healthy before starting. `pg-boss` creates its
own schema automatically on first boot — no manual queue setup needed.

### 3. Run migrations
Migrations are raw SQL files in `supabase/migrations/` applied in filename order.
They are idempotent (`IF NOT EXISTS`), so re-running is safe.

From the host (uses `@localhost:5432`):
```bash
cd backend
npm install
DATABASE_URL=postgresql://assisty:assisty@localhost:5432/assisty npm run migrate
```
Or inside the running api container:
```bash
docker compose exec api npm run migrate
```

### 4. Verify
- Health: `curl http://localhost:3000/health`
- DB health: `curl http://localhost:3000/health/db`

---

## Deploy (Railway)

Railway builds the backend from `backend/Dockerfile` per `railway.json`
(builder `DOCKERFILE`, health check at `/health`).

### 1. Database — Supabase hosted Postgres
Use a hosted Supabase Postgres project (pgvector + pgcrypto are available).
Take its connection string and set it as `DATABASE_URL` on the Railway service.
Run the migrations against it once:
```bash
DATABASE_URL="<supabase-connection-string>" npm run migrate
```
> Note: app-level tenant scoping is enforced in the repositories today. Postgres
> RLS is a planned later hardening step.

### 2. LiteLLM
Two options:
- **Second Railway service** running `ghcr.io/berriai/litellm:main-stable` with
  `infra/litellm/config.yaml` and the provider keys; point the backend's
  `LITELLM_BASE_URL` at it.
- **Skip the proxy** and point `LITELLM_BASE_URL` directly at OpenRouter's
  OpenAI-compatible endpoint (`https://openrouter.ai/api/v1`) with
  `LITELLM_API_KEY` set to your OpenRouter key. Simplest for a first deploy.

### 3. Backend service env vars
Set on the Railway backend service:
- `NODE_ENV=production`, `PORT` (Railway injects one), `LOG_LEVEL=info`
- `DATABASE_URL` (Supabase)
- `LITELLM_BASE_URL`, `LITELLM_API_KEY`
- `DEFAULT_CHAT_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_DIM`
- `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_GRAPH_VERSION`

Per-tenant WhatsApp access tokens and phone number IDs live in the
`channel_connections` table, not in env (the `WHATSAPP_ACCESS_TOKEN` /
`WHATSAPP_PHONE_NUMBER_ID` env vars are only a single-tenant dev fallback).

### 4. Deploy
Push to the connected branch (or `railway up`). Railway builds the Dockerfile,
runs `node dist/main.js`, and health-checks `/health`. It restarts on failure
up to 10 times.

---

## WhatsApp webhook setup (Meta)

1. In the Meta App dashboard → WhatsApp → Configuration, set the **Callback URL**
   to your deployed endpoint:
   ```
   https://<your-domain>/webhooks/whatsapp
   ```
2. Set the **Verify Token** to the same value as `WHATSAPP_VERIFY_TOKEN`. Meta
   sends a `GET` with `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`;
   the backend echoes the challenge back when the token matches.
3. Meta signs every `POST` with `X-Hub-Signature-256` using your **App Secret**.
   Set `WHATSAPP_APP_SECRET` to that value — the backend verifies the HMAC
   against the raw request body and rejects mismatches with 403.
4. Subscribe to the `messages` webhook field.

Inbound webhooks are acknowledged with a fast `200`; the actual AI reply is
processed asynchronously via the `pg-boss` queue (idempotent on the WhatsApp
message id `wamid`).
