# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Lead AI is a SaaS product in the Vertice AI Suite that helps digital marketing agencies qualify leads via AI-assisted forms and chat. **Phase 1** built the frontend foundation (routing, layout, design system, placeholder pages). **Phase 2** built a complete frontend-only Leads Management MVP (full CRUD, search/filter/sort, dashboard KPIs) persisted to `localStorage` behind a typed repository. **Phase 3** built a functional Qualification Forms MVP: a drag-free form builder (question types, scoring points, reordering), a public no-auth submission page at `/f/:formId`, and automatic Lead creation from submissions with a 0–100 score computed from the form's configured points. **Phase 4** added a real AI-assisted qualification chat: a small Express/TypeScript backend under `server/` that talks to the Anthropic API server-side (the API key never reaches the browser), a functional `/chat-settings` page backed by `localStorage`, a public chat at `/c/:orgSlug` (only `vertice-agency` is wired up for this local MVP), an authenticated `/conversations` list, and automatic Lead creation from completed chat qualifications. **Phase 5** made backend chat-session persistence durable (JSON-file-backed at `server/data/sessions.json`, survives a backend restart — see "Backend (`server/`)" below). **Phase 6** added an optional Supabase (Postgres) backend for leads, forms/submissions, chat configuration, and team members, selected by an env flag (`VITE_DATA_BACKEND`) — see "Phase 6: Supabase persistence" below. The `local` (browser `localStorage`) implementation remains the default and stays fully functional; Supabase is opt-in until a user has verified it. There is still no authentication — see "Deliberately not implemented yet".

**The UI is entirely in Spanish** (labels, buttons, empty states, form copy) — this is a deliberate product decision, not a partial translation. Keep new UI text in natural Spanish. Code itself (identifiers, types, comments, status/source enum values like `'qualified'` or `'chat'`) stays in English — only the Spanish *labels* mapped to those enum values are user-facing (see `entities/lead/presentation.ts`).

## Commands

Frontend (run from the repo root):
- `npm run dev` — start the Vite dev server with HMR (frontend only)
- `npm run build` — type-check via project references (`tsc -b`) then production build via Vite
- `npm run lint` — lint with Oxlint
- `npm run preview` — serve the production build locally

Backend (`server/`, its own npm package):
- `npm run dev:server` (from repo root) — runs `npm run dev` inside `server/`, i.e. `tsx watch src/index.ts`
- `npm run build:server` (from repo root) — runs `npm run build` inside `server/`, i.e. `tsc -b` to `server/dist`
- `npm run dev:all` (from repo root) — runs the frontend and backend dev servers together via `concurrently`

There is no test runner configured in this repository yet.

**Fixed dev ports**: the frontend always runs on `5173` and the backend always runs on `8787` — `vite.config.ts` sets `server.port: 5173` with `server.strictPort: true`, so if `5173` is already taken, `npm run dev` fails immediately instead of silently moving to `5174`/`5175`/etc. (Vite's default behavior). This matters because `server/.env`'s `CORS_ORIGIN` is pinned to `http://localhost:5173` — a silently-drifted frontend port used to surface as a confusing "no se pudo conectar con el servidor" in the public chat rather than an obvious startup error. If `npm run dev` fails with "Port 5173 is already in use", find and stop whatever is still bound to it (`netstat -ano | findstr :5173` on Windows) rather than letting Vite pick a different port.

## Stack

**Frontend**: React 19, TypeScript, Vite 8, Tailwind CSS v4 (via `@tailwindcss/vite`, CSS-first config — no `tailwind.config.js`), React Router v7, TanStack Query v5, React Hook Form + Zod v4, `lucide-react` for icons, `clsx` + `tailwind-merge` for the `cn()` class helper.

**Backend** (`server/`, a separate npm package with its own `package.json`/`tsconfig.json`/`node_modules`): Express 4, TypeScript, the official `@anthropic-ai/sdk`, Zod v4 (request/response validation), `cors`, `dotenv`, run via `tsx` in dev and compiled with `tsc` for production (`server/dist`).

**Zod v4 note**: use `z.email()` (top-level), not the deprecated `.email()` chain method. Custom error messages use `{ error: '...' }`, not `message`/`invalid_type_error`.

**zodResolver + optional/coerced fields**: any schema field that uses `z.preprocess(...)` (e.g. to turn `''` into `undefined`, or coerce a string input into a number) has a different *input* type than *output* type. When that's true, `useForm` must use the three-generic form — `useForm<SchemaInput, unknown, SchemaOutput>(...)` — or TypeScript will reject the resolver. See `entities/lead/schema.ts` (`LeadFormInput` vs `LeadFormValues`) / `entities/form/schema.ts` (`FormBuilderInput` vs `FormBuilderValues`) and their respective form components for the pattern. Skipping this is the most likely source of a `Resolver<...>` type error if you add new form fields.

**Nested `useFieldArray` (dynamic paths)**: the form builder (`features/forms/components/FormBuilder.tsx` → `QuestionEditor.tsx` → `OptionEditor.tsx`) has a `useFieldArray` for `questions`, and each question row has its *own* nested `useFieldArray` for `questions.${index}.options`. RHF's TS types can't verify a runtime-constructed template-literal path like that against the generic `Path<T>` union, so those calls (and the matching `register(...)`/`setValue(...)` calls) use `as never` at the path argument. This is a deliberate, scoped escape hatch for this one friction point — don't spread `as never` elsewhere as a generic fix for unrelated type errors.

## Architecture

The codebase follows a **feature-based** structure — group by domain, not by technical layer:

```
src/
  app/                # composition root: routing, providers, layout shell
    router.tsx         # createBrowserRouter + route tree
    providers/          # QueryClient, etc.
    layout/              # AppShell, Sidebar, Topbar, MobileNav, nav-config
  features/            # one folder per route/domain; owns its own page components
    dashboard/, leads/, forms/, chat-settings/, conversations/, integrations/, team/, settings/, not-found/, public-form/, public-chat/
      leads/
        LeadsPage.tsx, LeadDetailPage.tsx
        lead-filters.ts      # LeadFilters type + defaults (kept out of components/ so Fast Refresh stays happy)
        components/          # LeadForm, LeadFiltersBar, LeadsTable, LeadTranscriptCard, LeadQualificationCard — used only within this feature
      forms/                 # authenticated forms management (list, builder, submissions/results)
        FormsPage.tsx, FormBuilderPage.tsx, FormSubmissionsPage.tsx
        components/          # FormStatusBadge, QuestionTypeSelector, OptionEditor, QuestionEditor, FormBuilder, FormPreview, FormSubmissionTable
      public-form/           # the *unauthenticated* form-filling experience — deliberately its own feature,
        PublicFormPage.tsx   # not nested under forms/, because its audience (leads) and shell (no sidebar) differ
        components/          # QuestionField (per-question-type input renderer)
      chat-settings/         # authenticated /chat-settings — edits the ChatConfiguration singleton
        ChatSettingsPage.tsx
        components/          # CriteriaEditor, CollectedInfoEditor, ChatPreview
      public-chat/           # the *unauthenticated* chat-with-AI experience at /c/:orgSlug — its own feature
        PublicChatPage.tsx   # for the same reason as public-form/: different audience, no AppShell
        components/          # ChatBubble (sanitized plain-text rendering), ChatComposer (Enter/Shift+Enter)
      conversations/         # authenticated /conversations — list of chat sessions + their qualification outcome
        ConversationsPage.tsx, conversation-filters.ts
        components/          # ConversationsTable
  entities/            # cross-feature domain models: types, Zod schemas, mock data, presentation (labels/formatters), repository, TanStack Query hooks
    lead/, team-member/, form/, chat/
      # Each Phase 6-migrated entity (lead, form's form-repository + submission-repository, chat's
      # chat-config-repository, team-member) has this trio: <name>-repository.ts (localStorage,
      # existing), <name>-supabase-repository.ts (Postgres, new), active-<name>-repository.ts
      # (selects between them via VITE_DATA_BACKEND). See "Phase 6: Supabase persistence" below.
  migration/           # src/migration/local-to-supabase.ts — one-time, dev-only, browser-console-invoked
                        # utility to move a real user's accumulated localStorage data into Supabase
  shared/
    ui/                 # generic design-system primitives (Button, Input, Select, Textarea, Card, Badge, PageHeader, EmptyState, Modal, ConfirmDialog, Switch)
    lib/                 # cn(), local-storage read/write helpers, supabase-client.ts, data-backend.ts (VITE_DATA_BACKEND selection)
  assets/              # imported (not public/) static assets
server/                # separate npm package: the Express/TypeScript backend — see "Backend (server/)" below
supabase/              # schema.sql (run once in the Supabase SQL editor) + seed.sql (one-time demo-data seed) —
                        # see "Phase 6: Supabase persistence" below. Not a Supabase CLI project (no supabase/config.toml).
```

Rules of thumb when adding to this structure:
- A feature folder may import from `entities/` and `shared/`, not from another feature folder directly.
- `entities/` is for domain models actually shared across features (`Lead`, `TeamMember`, `QualificationForm`/`FormSubmission`). Page-local mock data (e.g. mock integrations in `IntegrationsPage.tsx`) stays inline in that page until a second feature needs it — don't pre-emptively promote it.
- `shared/ui` is for generic, brand-styled primitives with no domain knowledge. Domain-aware presentational logic (e.g. `leadStatusLabel`, `formatLeadBudget`, `questionTypeLabel`) belongs in the owning `entities/<name>/presentation.ts`.
- Don't put non-component exports (types, constants) in a file under `features/*/components/` — oxlint's `react/only-export-components` (Fast Refresh) will warn. Put shared filter/state types next to the page instead (see `lead-filters.ts`).
- A page whose audience or shell genuinely differs (public/no-auth vs. the dashboard) gets its own top-level `features/` folder, even if the domain overlaps with an existing feature — see `public-form/` vs `forms/`.

**Routing**: `src/app/router.tsx` has two top-level route trees. The public `/f/:formId` route (`PublicFormPage`) is a sibling to the dashboard tree and renders with **no** `AppShell` — it's the only route without the sidebar/topbar chrome, since leads filling out a public form should never see the agency's dashboard shell. Everything else nests under the `AppShell` layout route (`/` redirects to `/dashboard`, catch-all `NotFoundPage`). `AppShell` (`src/app/layout/AppShell.tsx`) composes `Sidebar` (desktop, `lg:` breakpoint and up), `Topbar` (always visible, has the mobile hamburger trigger), and `MobileNav` (slide-over drawer below `lg:`). Nav items are defined once in `src/app/layout/nav-config.ts` and consumed by both `Sidebar` and `MobileNav`. Forms management routes: `/forms` (list), `/forms/new` and `/forms/:formId/edit` (both handled by one `FormBuilderPage`, switching on whether `:formId` is present), `/forms/:formId/submissions` (results).

**Path alias**: `@/*` maps to `src/*` (configured in both `vite.config.ts` resolve.alias and `tsconfig.app.json` paths — keep both in sync if it changes). Prefer `@/...` imports over deep relative paths.

**Data layer (leads)**: `entities/lead/lead-repository.ts` exports the `LeadRepository` interface and the `localStorageLeadRepository` implementation (storing under the `lead-ai:leads:v1` key, seeding from `mock-data.ts` on first read); `entities/lead/lead-supabase-repository.ts` exports `supabaseLeadRepository`, the Postgres-backed implementation — see "Phase 6: Supabase persistence" below for how the two coexist. `entities/lead/hooks.ts` wraps whichever one is active in TanStack Query (`useLeadsQuery`, `useLeadQuery`, `useCreateLeadMutation`, `useUpdateLeadMutation`, `useDeleteLeadMutation`) — all keyed on `leadKeys.list()`, so mutations invalidate that one query and every consumer (Dashboard, Leads list, Lead detail) refetches together. **To add a third backend**: write a new `LeadRepository` implementation and extend `active-lead-repository.ts`'s selector — the UI (pages/components) never touches storage or a concrete repository directly, only `activeLeadRepository`. `entities/team-member` follows the same local/Supabase-repository-plus-selector pattern (`team-member-repository.ts` / `team-member-supabase-repository.ts` / `active-team-member-repository.ts`); leads reference a member by `id` in `assignedTo`.

`Lead.activity` is an append-only timeline. The decision logic for *what* message to log lives in `entities/lead/lead-activity.ts` (`buildCreateActivityMessage`, `buildUpdateActivityMessages` — pure functions, diffing a patch against the existing record), shared by both repository implementations; each implementation decides *how* to store the result (an embedded array for localStorage, rows in a separate `lead_activity` table for Supabase — see below). Don't append activity entries from UI code; let the repository do it so it stays consistent.

**Data layer (qualification forms)**: `entities/form/form-repository.ts` (key `lead-ai:forms:v1`, seeded from `mock-data.ts`'s three example forms) and `entities/form/submission-repository.ts` (key `lead-ai:form-submissions:v1`, starts empty — submissions are only ever created live, never seeded) follow the same repository pattern as leads, each with a `-supabase-repository.ts` counterpart and an `active-*-repository.ts` selector. `useFormsQuery()` joins forms with *all* submissions to compute `submissionCount` per form at read time rather than storing a denormalized counter on the form record — the submissions list is the single source of truth.

**Submission → Lead flow** (`entities/form/submission-service.ts`, `submitQualificationForm()`): this is the one place that touches three repositories in sequence — reads the form, computes the score (`scoring.ts`: per-question points summed and normalized to 0–100; `scoreToLeadStatus()` maps 0–39/40–69/70–100 to `disqualified`/`qualifying`/`qualified`), maps answers to `name`/`email`/`phone`/`company` via `mapAnswersToLeadFields` (matches by question *type* for email/phone, by a label regex like `/nombre/i` for name/company, since there's no dedicated "name" question type), creates the `Lead` (with `formId`/`submissionId` stamped on it — see below), then creates the `FormSubmission` referencing that lead's id. Called through `useSubmitFormMutation()`, whose `onSuccess` invalidates the forms list, that form's submissions, **and** `leadKeys.list()` — this is what makes Dashboard/Leads update automatically after a public submission. A form builder rule (`formBuilderSchema`'s object-level `superRefine`) requires at least one `email`-type question before a form can be saved, specifically so this flow can never fail to produce a valid lead. If you relax that rule, `mapAnswersToLeadFields` will throw instead of silently creating a lead with a fake email — don't paper over that by inventing a placeholder address. **The Lead is always created before the FormSubmission** (the submission's id is minted client-side and stamped onto the Lead first) — this ordering is why `leads.submission_id` has no foreign key in the Supabase schema; see "Phase 6" below.

**Lead ⟷ form linkage**: `Lead.formId`/`Lead.submissionId` are optional fields added purely additively — `leadFormSchema` (the manual create/edit form's Zod schema) does *not* include them, so the manual "Nuevo lead" UI can never set them; only `CreateLeadInput` (the repository-level type, `LeadFormValues & { formId?, submissionId? }`) carries them, and only `submission-service.ts` passes them in. `LeadDetailPage` shows a "Ver envío" link back to `/forms/:formId/submissions` when `lead.formId` is set.

**Public form validation**: `PublicFormPage` does *not* use React Hook Form. A form's question set is only known at runtime (built from whatever the agency configured), so there's no static type to hand `useForm<T>` — plain `useState` for answers plus `entities/form/validate-answers.ts` (`validateFormAnswers`, a dependency-free function checking required/email/phone/number) is simpler and avoids fighting RHF's generics for a shape that's inherently dynamic. If a future dynamic form needs the same treatment, follow this pattern rather than trying to force RHF+Zod onto it.

## Backend (`server/`)

`server/` is a **separate npm package** (own `package.json`, `tsconfig.json`, `node_modules`) — not an npm workspace of the root project. It exists solely to keep the Anthropic API key server-side; the frontend never talks to Anthropic directly.

```
server/
  src/
    index.ts            # entry point: creates the app, starts listening
    app.ts               # express() + cors + json body parsing + route mounting + error handler
    config.ts            # reads server/.env (PORT, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, CORS_ORIGIN)
    routes/
      health.ts           # GET /api/health
      chat.ts              # POST /api/chat/sessions, POST /api/chat/sessions/:sessionId/messages (SSE)
    services/
      ai-provider.ts       # AIProvider interface + AnthropicProvider implementation (swap the provider here later)
      chat-service.ts       # orchestrates: append turn -> stream reply -> append turn -> extract qualification
      system-prompt.ts       # builds the chat + extraction system prompts from ChatConfiguration fields only
      scoring.ts              # statusForScore()/clampScore() — mirrors entities/chat's client-side status thresholds
    repositories/
      session-repository.ts # ChatSession/ChatMessage store, JSON-file-backed at server/data/sessions.json (SessionRepository interface + impl)
    schemas/
      chat.ts               # Zod schemas: request bodies + ChatQualificationResult (the server never trusts raw model text)
    lib/
      errors.ts, rate-limit.ts, logger.ts
  data/
    sessions.json          # Runtime state, git-ignored. Whole in-memory Map serialized to disk after every mutation
                            # (create/appendTurn/setQualification) and reloaded on startup, so sessions survive a
                            # backend restart. Contains conversation transcripts — treat it as PII, never commit it.
```

- **No external database yet, but sessions are durable.** `sessionRepository` (`FileSessionRepository`) keeps its state in an in-memory `Map` for fast reads and writes the whole map to `server/data/sessions.json` after every mutation, reloading it on startup — so a backend restart no longer orphans an in-progress conversation. This is still a single-process, single-file store (no real database yet); a later phase would swap this repository for a real one without touching the routes, since callers only see the `SessionRepository` interface.
- **Provider abstraction**: routes and services never import `@anthropic-ai/sdk` directly — they depend on the `AIProvider` interface (`streamAssistantReply`, `extractStructuredText`) in `services/ai-provider.ts`. Swapping AI vendors later means writing a new class that implements that interface.
- **The frontend can never choose the model or inject a raw system prompt.** `POST /api/chat/sessions` accepts a structured `ChatConfiguration` object (validated with `chatConfigurationSchema`); the server itself assembles the system prompt from those fields (`buildChatSystemPrompt`/`buildExtractionSystemPrompt`). There is no field anywhere in the request schema for a raw prompt string, and the model ID always comes from `ANTHROPIC_MODEL` in `server/.env`.
- **Structured qualification results are never trusted as-is**: `extractQualification()` asks the model for JSON, then parses and validates it with `chatQualificationResultSchema` (`server/src/schemas/chat.ts`) before it's stored or returned. A response that fails validation is treated as "not enough information yet", not surfaced as an error.

## Chat architecture (end-to-end)

1. `ChatSettingsPage` (`/chat-settings`) edits a single `ChatConfiguration` record kept in the browser's `localStorage` (`entities/chat/chat-config-repository.ts`, key `lead-ai:chat-config:v1`) — same read/seed-defaults-once pattern as the lead/form repositories.
2. `PublicChatPage` (`/c/:orgSlug`, only `orgSlug === 'vertice-agency'` is wired up) reads that `ChatConfiguration` from `localStorage`, checks `GET /api/health` for `aiConfigured`, and if both are OK calls `POST /api/chat/sessions` with the full config. The backend validates it, builds the system prompt itself, and returns a `sessionId` — the frontend never sends or receives a system prompt string.
3. Each message goes to `POST /api/chat/sessions/:sessionId/messages`, which streams the assistant's reply back over **SSE** (hand-rolled `event:`/`data:` framing over a `fetch` `ReadableStream` in `entities/chat/api-client.ts::streamChatMessage` — no extra dependency, since the browser's native `EventSource` can't send a POST body). After the reply finishes, the server makes one more (non-streamed) call asking the model for a structured qualification result, validates it with Zod, and sends it down as a final SSE event.
4. The frontend mirrors the conversation into its own `localStorage` (`entities/chat/chat-session-repository.ts`, key `lead-ai:chat-sessions:v1`) for display in `/conversations` and on the lead detail page. This is a **display copy** — the backend's `server/data/sessions.json`-backed session is the one actually sent to Claude as conversation context. Since that file now survives a backend restart, the two stay in sync across restarts too (the earlier "sending a new message 404s after a restart" limitation only applies if `server/data/` itself is deleted).
5. When a qualification result includes an email, `entities/chat/qualification-service.ts::syncLeadFromQualification` calls `activeLeadRepository.upsertByChatSession()` to create or update a `Lead`, deduping by `Lead.chatSessionId` (an additive field, same pattern as `formId`/`submissionId`) so the same conversation never produces two leads. **If the model hasn't captured a real email yet, no lead is created** — same "don't invent a placeholder" rule as the form-submission flow in `submission-service.ts`. On the Supabase backend this dedup is a real atomic upsert (backed by a partial unique index on `leads.chat_session_id`), not a list-then-write race — see "Phase 6: Supabase persistence" below.

## Phase 6: Supabase persistence (leads, forms, chat configuration)

Leads, forms/form-submissions, chat configuration, and team members can optionally be backed by Supabase (Postgres) instead of `localStorage`. This is **opt-in**, selected by `VITE_DATA_BACKEND` (`local` | `supabase`, default `local`) — the `local` implementation is untouched and remains fully functional on its own. Chat sessions are **not** part of this — they stay exactly as Phase 5 left them (`server/data/sessions.json`), regardless of `VITE_DATA_BACKEND`.

**Selector pattern**: every migrated entity has three files — a `localStorage*Repository` (existing), a `supabase*Repository` (new), and an `active-*-repository.ts` that picks between them once at module load based on `dataBackend` (`shared/lib/data-backend.ts`). Every consumer — `hooks.ts` files, **and** the two cross-entity services that import repositories directly instead of going through hooks (`entities/form/submission-service.ts`, `entities/chat/qualification-service.ts`) — imports the `active*Repository`, never a concrete implementation. To add a third backend for an entity, implement its repository interface and extend that entity's selector; nothing else changes.

**Schema**: `supabase/schema.sql` (run once in the Supabase SQL editor) defines six tables — `leads`, `lead_activity`, `forms`, `form_submissions`, `chat_configuration`, `team_members`. `supabase/seed.sql` (run once, after `schema.sql`) ports the same demo data the `local` repositories seed on first read — but as a one-time script, **not** baked into any Supabase repository's read path (see next point for why). Two schema decisions worth knowing before touching this area:
- **`leads.submission_id` has no foreign key.** `submission-service.ts` creates the Lead first (stamped with a client-generated `submissionId`), then the FormSubmission second — a straightforward FK would fail on every single form submission, since the referenced row doesn't exist yet at insert time. `form_submissions.lead_id → leads.id` is the safe direction and *is* a real FK.
- **`leads.chat_session_id` has a plain (non-partial) unique index.** This is what makes `LeadRepository.upsertByChatSession()` (called from `qualification-service.ts`) race-free on Supabase: `entities/lead/lead-supabase-repository.ts` performs a real `.upsert(row, { onConflict: 'chat_session_id' })`, so two qualification events arriving close together for the same session can never produce two lead rows — whichever resolves second lands on the same row via `ON CONFLICT`. The `local` implementation keeps its original list-then-write logic (moved into `lead-repository.ts::upsertByChatSession`, unchanged) since a single browser tab was never at risk. **Do not make this a partial index** (e.g. `where chat_session_id is not null`) — it's tempting since only chat-linked leads need the constraint, but PostgREST's `onConflict` option issues a plain `ON CONFLICT (chat_session_id)`, which Postgres only matches against a non-partial unique constraint/index; against a partial one it fails with `42P10` ("no unique or exclusion constraint matching the ON CONFLICT specification") on every single upsert call. This was caught live during the Phase 6 Supabase regression pass — a plain unique index already allows unlimited leads with a `NULL` chat_session_id (Postgres never treats `NULL = NULL` in a unique index), so the partial predicate was never actually necessary.

**Seeding vs. importing real data — different problems, don't conflate them.** `supabase/seed.sql` is for bootstrapping a *fresh* project with the same demo data `mock-data.ts` provides — it must never be baked into a repository's `get()`/`list()` methods, because the `local` repositories' "seed on first empty read" pattern would race if ported literally to a shared database (two clients' concurrent empty reads could both try to insert duplicate mock rows; `chat_configuration`'s Supabase repository avoids exactly this by using `upsert(..., { onConflict: 'org_slug', ignoreDuplicates: true })` followed by a plain re-`select`, never a naive check-then-insert). Moving a *real* user's already-accumulated `localStorage` data into Supabase is a separate, one-time operation: `src/migration/local-to-supabase.ts::migrateLocalDataToSupabase()`, exposed on `window` in dev builds only (dead-code-eliminated from production). It inserts directly with the original `id`/`createdAt` values preserved — not through `create()`, which always mints a fresh id — because `Lead.formId`/`submissionId` and `FormSubmission.formId`/`leadId` are real cross-references in exported data, and minting new ids would silently break every "Ver envío" link. Chat configuration is deliberately excluded from this migration (it's a single settings record with no cross-references — simplest safe path is just re-saving it once through `/chat-settings` after switching backends).

**⚠️ Row Level Security is open in this phase — read before deploying anywhere but local dev.** `supabase/schema.sql` enables RLS on every table but with permissive policies (`using (true)`) for select/insert/update/delete, because there's no authentication yet to scope access by. This is a **new class of exposure** versus `localStorage`, not the same risk restated: today, one visitor's browser storage is structurally unreachable by anyone else; with an open-policy Supabase project, anyone who has the `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` pair (both ship in the client bundle — the anon key is not a secret, but it does grant this access under these policies) can read and write every lead/form/submission/setting directly via Supabase's REST API, not just through the app UI. This is an accepted, time-boxed trade-off for a single-tenant internal tool — **do not put a Supabase-backed deployment on a public/discoverable URL** until an auth phase adds real per-user RLS policies. Every table already has a nullable `created_by uuid` column (always `NULL` today, deliberately **not** a foreign key to `auth.users(id)` yet — referencing the `auth` schema from a SQL-editor paste is a known Supabase permission/grants friction point, and since the editor runs a whole pasted script as one implicit transaction, that single failure would silently roll back every table in the script; add the FK via a plain `ALTER TABLE` once the auth phase confirms the right grants) specifically so that later phase is mostly a policy change plus one small constraint addition, not a schema rewrite.

## Environment variables

- **`server/.env`** (git-ignored; copy from `server/.env.example`): `PORT`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `CORS_ORIGIN`. `ANTHROPIC_API_KEY` is read only here, only server-side, and is never logged. Untouched by Phase 6 — no new backend env vars.
- **Frontend `.env`** (git-ignored; copy from root `.env.example`):
  - `VITE_API_BASE_URL` (optional, defaults to `http://localhost:8787`) — the chat backend's base URL, not a secret.
  - `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (optional, required only if `VITE_DATA_BACKEND=supabase`) — from the Supabase project's Settings → API page. The anon key is **not a secret** in the credential sense (it's designed to ship in the client bundle and be governed by RLS), but see the RLS warning above for what it does grant access to under this phase's open policies.
  - `VITE_DATA_BACKEND` (`local` | `supabase`, defaults to `local` if unset or if set to `supabase` without the two Supabase vars present — `shared/lib/data-backend.ts` logs a console warning and falls back rather than throwing).
  - **Never** add a Vite-exposed variable that carries the Anthropic API key, a Supabase `service_role` key, or any other true secret; anything prefixed `VITE_` ends up in the client bundle.
- If `ANTHROPIC_API_KEY` is unset, the backend still starts: `GET /api/health` reports `aiConfigured: false`, `POST /api/chat/sessions` returns `503` with a Spanish message, and `PublicChatPage` shows a Spanish "IA no configurada" message instead of crashing. The rest of the app (dashboard, leads, forms) is unaffected either way.

**Styling**: Tailwind CSS v4, configured via `@import "tailwindcss"` + an `@theme` block in `src/index.css` (no JS config file). Brand tokens defined there: `--color-vertice-bg`, `--color-vertice-surface` (dark navy surfaces). The blue-to-purple brand gradient is composed ad hoc with Tailwind's built-in `blue-500`/`purple-600` (e.g. `bg-gradient-to-r from-blue-500 to-purple-600`) rather than a custom token — reuse that exact pair for brand accents (primary buttons, active nav state, avatars) to stay consistent.

**Responsive tables**: the pattern used in `LeadsTable.tsx` — one component renders both a `hidden md:block` `<table>` and a `md:hidden` card-list `<div>` from the same data, rather than a single element with `overflow-x-auto`. Prefer this for any future data-table page.

- `tsconfig.app.json` has `verbatimModuleSyntax` enabled — type-only imports must use `import type`.
- Do not add a `baseUrl` to `tsconfig.app.json` — this TypeScript version deprecates it (TS5101); the `@/*` path alias works without it under `moduleResolution: "bundler"`.
- Assets referenced with root-relative paths (e.g. `/favicon.svg`) live in `public/`; assets imported from JS/TS live in `src/assets/`.

## Linting

Oxlint config is at `.oxlintrc.json` (plugins: `react`, `typescript`, `oxc`). Type-aware lint rules are not currently enabled — see `README.md` for how to opt in via `oxlint-tsgolint` if that becomes necessary.

## Deliberately not implemented yet

Do not add these unless the user explicitly asks — they belong to later phases: authentication/session handling (and the real per-user RLS policies that depend on it — see the Phase 6 RLS warning above), billing/Stripe, CRM integrations, the embeddable widget build target, multi-tenant support for `/c/:orgSlug` beyond the hardcoded `vertice-agency`, and moving chat sessions/messages into Postgres (they're intentionally still `server/data/sessions.json`-backed — see "Backend (`server/`)" — a schema sketch exists in `supabase/schema.sql` as a comment but is not created). Placeholder pages for the areas still not built (`IntegrationsPage`, etc.) should stay honest about being non-functional rather than faking success states. The "public" `/f/:formId` and `/c/:orgSlug` pages only work from the same browser that has the relevant `localStorage` data **when `VITE_DATA_BACKEND=local`** (the default); with `VITE_DATA_BACKEND=supabase` those pages work from any browser, subject to the open-RLS caveat above.

## Security constraints (chat feature)

- The Anthropic API key lives only in `server/.env` and is read only by `server/src/config.ts`. It must never appear in frontend code, in a `VITE_`-prefixed env var, in a log line, or in an error response sent to the browser (`server/src/lib/errors.ts` centralizes error responses specifically to enforce this — always throw/pass errors through it rather than hand-writing `res.json({ error: ... })` in a route).
- The frontend cannot choose the model or the system prompt — see "Chat architecture" above. If you add a new field to the session-creation payload, it must be a structured, whitelisted field validated by `chatConfigurationSchema`, never a raw prompt/model string.
- `POST /api/chat/sessions` and `POST /api/chat/sessions/:sessionId/messages` are rate-limited per IP (`server/src/lib/rate-limit.ts`, in-memory sliding window) since they're public, unauthenticated endpoints.
- Chat message content is rendered in `ChatBubble`/`LeadTranscriptCard` as plain text only (`whitespace-pre-wrap`, no `dangerouslySetInnerHTML`) — never render model output as HTML.
