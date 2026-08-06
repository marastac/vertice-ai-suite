# Lead AI - Vértice AI Suite

Lead AI is an AI-powered CRM designed for marketing agencies to capture, qualify, manage, and convert leads.

## Features

- 🤖 AI-powered lead qualification
- 💬 Public AI chat widget
- 📋 Lead management
- 📊 Dashboard with KPIs
- 📝 Forms management
- 💾 Local or Supabase persistence
- 🏢 Multi-organization architecture (in progress)
- 🔐 Authentication via Supabase Auth (login, registration, password recovery, protected dashboard routes)

## Tech Stack

- React
- TypeScript
- Vite
- Express
- Supabase
- PostgreSQL
- Anthropic Claude API

# Lead AI

Lead AI is a SaaS product in the Vertice AI Suite that helps digital marketing agencies qualify leads via AI-assisted forms and chat.

See `CLAUDE.md` for the full architecture reference. This file covers day-to-day setup.

## Installation

```sh
# Frontend (repo root)
npm install

# Backend (separate npm package)
npm install --prefix server
```

## Configure the backend

The backend reads the Anthropic API key from `server/.env`, which is git-ignored and never committed.

```sh
cp server/.env.example server/.env
```

Edit `server/.env`:

```
PORT=8787
ANTHROPIC_API_KEY=sk-ant-...    # leave empty to run without AI features
ANTHROPIC_MODEL=claude-opus-4-8
CORS_ORIGIN=http://localhost:5173
```

The app runs fine with `ANTHROPIC_API_KEY` left empty — the backend just reports `aiConfigured: false` and the public chat page shows a Spanish "not configured yet" message instead of crashing. The dashboard, leads, and forms features are unaffected either way.

## Configure authentication (Supabase Auth)

The dashboard (`/dashboard`, `/leads`, `/forms`, `/conversations`, etc.) requires a logged-in user. Authentication is handled entirely by [Supabase Auth](https://supabase.com/docs/guides/auth) — there's no separate auth server.

1. Create a free Supabase project (or reuse the one from Phase 6's optional data persistence) at [supabase.com](https://supabase.com).
2. Copy `.env.example` to `.env` at the repo root and fill in the Supabase values:

   ```
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-key
   ```

   These are the same variables Phase 6 uses for optional data persistence (`VITE_DATA_BACKEND`) — auth works independently of that flag; you can keep `VITE_DATA_BACKEND=local` for leads/forms/chat data while still using Supabase for login.
3. In the Supabase dashboard, go to **Authentication → Providers** and make sure **Email** is enabled (it is by default). No extra provider setup is required.
4. In **Authentication → URL Configuration**, add `http://localhost:5173/reset-password` to the **Redirect URLs** list — this is where Supabase sends users after they click a "reset password" email link. Add your production URL's equivalent there too once you deploy.
5. Restart `npm run dev` after editing `.env` (Vite only reads env vars at startup).

If `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are left empty, the app still starts: every dashboard route redirects to `/login`, and the login/register/forgot-password pages show a Spanish "Supabase no está configurado" message instead of a broken form, the same fallback pattern used elsewhere in the app (see `aiConfigured` below).

### Testing the authentication flow

With `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` set and the dev server running:

1. Go to `http://localhost:5173/register`, create an account. Depending on your Supabase project's email-confirmation setting, you'll either be signed in immediately or asked to confirm your email first (the UI handles both cases).
2. Go to `http://localhost:5173/login` and sign in — you should land on `/dashboard`.
3. Visiting any dashboard URL (`/leads`, `/forms`, …) while logged out redirects to `/login` and returns you to that same page after a successful sign-in.
4. Click your name/avatar in the top-right corner of the dashboard to open the account menu, and use **Cerrar sesión** to log out — you're redirected to `/login`.
5. From `/login`, click "¿Olvidaste tu contraseña?", submit your email, then open the reset link from your inbox — it lands on `/reset-password`, where you can set a new password.

## Running the app

Run frontend and backend together:

```sh
npm run dev:all
```

...or separately, in two terminals:

```sh
npm run dev          # Vite dev server (frontend), default http://localhost:5173
npm run dev:server   # Express backend, default http://localhost:8787
```

## Testing the health endpoint

```sh
curl http://localhost:8787/api/health
```

```json
{ "status": "ok", "aiConfigured": false, "model": null, "timestamp": "..." }
```

`aiConfigured` flips to `true` once `ANTHROPIC_API_KEY` is set in `server/.env` and the backend is restarted.

## Opening the public chat

With both servers running and `ANTHROPIC_API_KEY` configured:

1. Go to `http://localhost:5173/chat-settings` and make sure the chat is toggled **active** (it's active by default until you change it).
2. Open `http://localhost:5173/c/vertice-agency` — this is the only `orgSlug` wired up in this local MVP.
3. Chat data (session + qualification result) shows up under `http://localhost:5173/conversations`, and once the assistant captures an email, a Lead appears under `http://localhost:5173/leads` with a linked conversation on its detail page.

## Building for production

```sh
npm run build          # frontend: type-check + Vite build -> dist/
npm run build:server   # backend: type-check + tsc build -> server/dist/
npm start --prefix server  # run the compiled backend (server/dist/index.js)
```

## Linting

```sh
npm run lint
```

See the "Expanding the Oxlint configuration" section below for opting into type-aware rules.

---

## Frontend tooling notes (from the Vite template)

This app is built on the React + TypeScript + Vite template. Two official plugins are available for HMR:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs) (the one this project uses)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

### React Compiler

The React Compiler is not enabled because of its impact on dev & build performance. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

### Expanding the Oxlint configuration

If needed, enable type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
