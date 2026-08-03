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
- 🔐 Authentication (planned)

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
