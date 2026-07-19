# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Lead AI is a SaaS product in the Vertice AI Suite that helps digital marketing agencies qualify leads via AI-assisted forms and chat. **Phase 1** built the frontend foundation (routing, layout, design system, placeholder pages). **Phase 2** built a complete frontend-only Leads Management MVP (full CRUD, search/filter/sort, dashboard KPIs) persisted to `localStorage` behind a typed repository. **Phase 3** built a functional Qualification Forms MVP: a drag-free form builder (question types, scoring points, reordering), a public no-auth submission page at `/f/:formId`, and automatic Lead creation from submissions with a 0–100 score computed from the form's configured points. There is still no backend, no Supabase connection, no authentication, no real AI chat, and no real network calls. Supabase (Postgres + Auth + Edge Functions) is the planned backend for a later phase.

**The UI is entirely in Spanish** (labels, buttons, empty states, form copy) — this is a deliberate product decision, not a partial translation. Keep new UI text in natural Spanish. Code itself (identifiers, types, comments, status/source enum values like `'qualified'` or `'chat'`) stays in English — only the Spanish *labels* mapped to those enum values are user-facing (see `entities/lead/presentation.ts`).

## Commands

- `npm run dev` — start the Vite dev server with HMR
- `npm run build` — type-check via project references (`tsc -b`) then production build via Vite
- `npm run lint` — lint with Oxlint
- `npm run preview` — serve the production build locally

There is no test runner configured in this repository yet.

## Stack

React 19, TypeScript, Vite 8, Tailwind CSS v4 (via `@tailwindcss/vite`, CSS-first config — no `tailwind.config.js`), React Router v7, TanStack Query v5, React Hook Form + Zod v4, `lucide-react` for icons, `clsx` + `tailwind-merge` for the `cn()` class helper.

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
    dashboard/, leads/, forms/, chat-settings/, integrations/, team/, settings/, not-found/, public-form/
      leads/
        LeadsPage.tsx, LeadDetailPage.tsx
        lead-filters.ts      # LeadFilters type + defaults (kept out of components/ so Fast Refresh stays happy)
        components/          # LeadForm, LeadFiltersBar, LeadsTable — used only within this feature
      forms/                 # authenticated forms management (list, builder, submissions/results)
        FormsPage.tsx, FormBuilderPage.tsx, FormSubmissionsPage.tsx
        components/          # FormStatusBadge, QuestionTypeSelector, OptionEditor, QuestionEditor, FormBuilder, FormPreview, FormSubmissionTable
      public-form/           # the *unauthenticated* form-filling experience — deliberately its own feature,
        PublicFormPage.tsx   # not nested under forms/, because its audience (leads) and shell (no sidebar) differ
        components/          # QuestionField (per-question-type input renderer)
  entities/            # cross-feature domain models: types, Zod schemas, mock data, presentation (labels/formatters), repository, TanStack Query hooks
    lead/, team-member/, form/
  shared/
    ui/                 # generic design-system primitives (Button, Input, Select, Textarea, Card, Badge, PageHeader, EmptyState, Modal, ConfirmDialog)
    lib/                 # cn(), local-storage read/write helpers
  assets/              # imported (not public/) static assets
```

Rules of thumb when adding to this structure:
- A feature folder may import from `entities/` and `shared/`, not from another feature folder directly.
- `entities/` is for domain models actually shared across features (`Lead`, `TeamMember`, `QualificationForm`/`FormSubmission`). Page-local mock data (e.g. mock integrations in `IntegrationsPage.tsx`) stays inline in that page until a second feature needs it — don't pre-emptively promote it.
- `shared/ui` is for generic, brand-styled primitives with no domain knowledge. Domain-aware presentational logic (e.g. `leadStatusLabel`, `formatLeadBudget`, `questionTypeLabel`) belongs in the owning `entities/<name>/presentation.ts`.
- Don't put non-component exports (types, constants) in a file under `features/*/components/` — oxlint's `react/only-export-components` (Fast Refresh) will warn. Put shared filter/state types next to the page instead (see `lead-filters.ts`).
- A page whose audience or shell genuinely differs (public/no-auth vs. the dashboard) gets its own top-level `features/` folder, even if the domain overlaps with an existing feature — see `public-form/` vs `forms/`.

**Routing**: `src/app/router.tsx` has two top-level route trees. The public `/f/:formId` route (`PublicFormPage`) is a sibling to the dashboard tree and renders with **no** `AppShell` — it's the only route without the sidebar/topbar chrome, since leads filling out a public form should never see the agency's dashboard shell. Everything else nests under the `AppShell` layout route (`/` redirects to `/dashboard`, catch-all `NotFoundPage`). `AppShell` (`src/app/layout/AppShell.tsx`) composes `Sidebar` (desktop, `lg:` breakpoint and up), `Topbar` (always visible, has the mobile hamburger trigger), and `MobileNav` (slide-over drawer below `lg:`). Nav items are defined once in `src/app/layout/nav-config.ts` and consumed by both `Sidebar` and `MobileNav`. Forms management routes: `/forms` (list), `/forms/new` and `/forms/:formId/edit` (both handled by one `FormBuilderPage`, switching on whether `:formId` is present), `/forms/:formId/submissions` (results).

**Path alias**: `@/*` maps to `src/*` (configured in both `vite.config.ts` resolve.alias and `tsconfig.app.json` paths — keep both in sync if it changes). Prefer `@/...` imports over deep relative paths.

**Data layer (leads)**: `entities/lead/lead-repository.ts` exports a `LeadRepository` interface and a `localStorageLeadRepository` implementation, storing under the `lead-ai:leads:v1` key and seeding from `mock-data.ts` on first read. `entities/lead/hooks.ts` wraps it in TanStack Query (`useLeadsQuery`, `useLeadQuery`, `useCreateLeadMutation`, `useUpdateLeadMutation`, `useDeleteLeadMutation`) — all keyed on `leadKeys.list()`, so mutations invalidate that one query and every consumer (Dashboard, Leads list, Lead detail) refetches together. **To swap in a real API later**: write a new `LeadRepository` implementation and change what `hooks.ts` calls — the UI (pages/components) never touches `localStorage` or the repository directly. `entities/team-member` is a static (non-persisted) list; leads reference a member by `id` in `assignedTo`.

`Lead.activity` is an append-only timeline the repository maintains itself (`buildUpdateActivity` in `lead-repository.ts`) by diffing `patch` against the existing record on every `update()` call — status changes and assignment changes get their own entries, other field changes collapse into one generic entry. Don't append activity entries from UI code; let the repository do it so it stays consistent.

**Data layer (qualification forms)**: `entities/form/form-repository.ts` (key `lead-ai:forms:v1`, seeded from `mock-data.ts`'s three example forms) and `entities/form/submission-repository.ts` (key `lead-ai:form-submissions:v1`, starts empty — submissions are only ever created live, never seeded) follow the same repository pattern as leads. `useFormsQuery()` joins forms with *all* submissions to compute `submissionCount` per form at read time rather than storing a denormalized counter on the form record — the submissions list is the single source of truth.

**Submission → Lead flow** (`entities/form/submission-service.ts`, `submitQualificationForm()`): this is the one place that touches three repositories in sequence — reads the form, computes the score (`scoring.ts`: per-question points summed and normalized to 0–100; `scoreToLeadStatus()` maps 0–39/40–69/70–100 to `disqualified`/`qualifying`/`qualified`), maps answers to `name`/`email`/`phone`/`company` via `mapAnswersToLeadFields` (matches by question *type* for email/phone, by a label regex like `/nombre/i` for name/company, since there's no dedicated "name" question type), creates the `Lead` (with `formId`/`submissionId` stamped on it — see below), then creates the `FormSubmission` referencing that lead's id. Called through `useSubmitFormMutation()`, whose `onSuccess` invalidates the forms list, that form's submissions, **and** `leadKeys.list()` — this is what makes Dashboard/Leads update automatically after a public submission. A form builder rule (`formBuilderSchema`'s object-level `superRefine`) requires at least one `email`-type question before a form can be saved, specifically so this flow can never fail to produce a valid lead. If you relax that rule, `mapAnswersToLeadFields` will throw instead of silently creating a lead with a fake email — don't paper over that by inventing a placeholder address.

**Lead ⟷ form linkage**: `Lead.formId`/`Lead.submissionId` are optional fields added purely additively — `leadFormSchema` (the manual create/edit form's Zod schema) does *not* include them, so the manual "Nuevo lead" UI can never set them; only `CreateLeadInput` (the repository-level type, `LeadFormValues & { formId?, submissionId? }`) carries them, and only `submission-service.ts` passes them in. `LeadDetailPage` shows a "Ver envío" link back to `/forms/:formId/submissions` when `lead.formId` is set.

**Public form validation**: `PublicFormPage` does *not* use React Hook Form. A form's question set is only known at runtime (built from whatever the agency configured), so there's no static type to hand `useForm<T>` — plain `useState` for answers plus `entities/form/validate-answers.ts` (`validateFormAnswers`, a dependency-free function checking required/email/phone/number) is simpler and avoids fighting RHF's generics for a shape that's inherently dynamic. If a future dynamic form needs the same treatment, follow this pattern rather than trying to force RHF+Zod onto it.

**Styling**: Tailwind CSS v4, configured via `@import "tailwindcss"` + an `@theme` block in `src/index.css` (no JS config file). Brand tokens defined there: `--color-vertice-bg`, `--color-vertice-surface` (dark navy surfaces). The blue-to-purple brand gradient is composed ad hoc with Tailwind's built-in `blue-500`/`purple-600` (e.g. `bg-gradient-to-r from-blue-500 to-purple-600`) rather than a custom token — reuse that exact pair for brand accents (primary buttons, active nav state, avatars) to stay consistent.

**Responsive tables**: the pattern used in `LeadsTable.tsx` — one component renders both a `hidden md:block` `<table>` and a `md:hidden` card-list `<div>` from the same data, rather than a single element with `overflow-x-auto`. Prefer this for any future data-table page.

- `tsconfig.app.json` has `verbatimModuleSyntax` enabled — type-only imports must use `import type`.
- Do not add a `baseUrl` to `tsconfig.app.json` — this TypeScript version deprecates it (TS5101); the `@/*` path alias works without it under `moduleResolution: "bundler"`.
- Assets referenced with root-relative paths (e.g. `/favicon.svg`) live in `public/`; assets imported from JS/TS live in `src/assets/`.

## Linting

Oxlint config is at `.oxlintrc.json` (plugins: `react`, `typescript`, `oxc`). Type-aware lint rules are not currently enabled — see `README.md` for how to opt in via `oxlint-tsgolint` if that becomes necessary.

## Deliberately not implemented yet

Do not add these unless the user explicitly asks — they belong to later phases: Supabase connection (DB/auth/Edge Functions), authentication/session handling, real API calls, AI chat logic, billing/Stripe, CRM integrations, the embeddable widget build target. Placeholder pages for these areas (`ChatSettingsPage`, `IntegrationsPage`, etc.) should stay honest about being non-functional rather than faking success states. The Leads (Phase 2) and Qualification Forms (Phase 3) modules are functional against `localStorage` only — there is still no server persistence, so data does not sync across browsers/devices, and the "public" `/f/:formId` page only works from the same browser that has the form's data in `localStorage` (there is no real hosting/network boundary yet).
