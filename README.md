# zen-cv

A web app for editing Zenika CVs and exporting them to PDF.

The app is a single Node.js project that contains both parts:

- a **Vue 3** front end, where CVs are displayed and edited in the browser;
- a **Hono** back end, which provides a JSON API, stores CVs in **PostgreSQL** and generates PDFs with **Playwright**.

In production, a single process serves both the API and the built front end. It runs on Google Cloud Run and is restricted to `@zenika.com` accounts.

## Getting started

### Prerequisites

- Node.js 24 (see `.nvmrc`). The server is TypeScript run directly by Node, without a build step.
- pnpm 12 (pinned in `package.json` under `packageManager`).
- A PostgreSQL database. Locally, this is usually the Cloud SQL `dev` database reached through the [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/sql-proxy):

  ```sh
  cloud-sql-proxy zen-cv-513014:europe-west9:dev-zen-cv --port 5432
  ```

  Any other Postgres works too, for example a throwaway one in Docker: see [Local environment with Docker](#local-environment-with-docker).

### Setup

```sh
pnpm install
pnpm exec playwright install chromium   # browser used for the PDF export
cp .env.example .env.local              # then fill in DATABASE_URL
pnpm db:migrate                         # creates the tables
pnpm db:seed                            # optional: loads server/db/seed.json, skipping CVs that already exist
pnpm dev
```

Then open http://localhost:5173.

### Local environment with Docker

To work without Cloud SQL, `pnpm db:test` starts a throwaway Postgres in Docker on port 5499. The same database serves the app and the tests: the app uses the `public` schema, the tests their own (`test_…`, then `e2e`), so they don't get in each other's way.

Once, in `.env.local`:

```sh
DATABASE_URL=postgresql://postgres:test@localhost:5499/postgres
TEST_DATABASE_URL=postgresql://postgres:test@localhost:5499/postgres
DEV_USER_EMAIL=prenom.nom@zenika.com    # the signed-in user (there is no IAP locally)
DEV_USER_TITLE=Business Developer       # optional: lets you edit every CV
```

Then, for each session:

```sh
pnpm db:local:init    # starts Postgres, waits for it, creates the tables and loads the sample CVs
pnpm dev
```

`db:local:init` is `pnpm db:test` followed by `pnpm db:seed --wait`: right after `docker run`, Postgres needs a few seconds before it accepts connections, so `--wait` retries for up to 30 seconds.

The container has no volume and is started with `--rm`, so everything is lost when it stops (`docker stop`, a reboot…); `pnpm db:seed` then starts you over from the sample CVs. To stop it, find its name with `docker ps`, then run `docker stop <name>`. Running `pnpm db:test` again while it's up fails with "port is already allocated".

### Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Vite dev server with hot reload. The API runs inside it under `/api`. |
| `pnpm build` | Type-checks (`vue-tsc`) and builds the front end into `dist/`. |
| `pnpm start` | Production server: the API plus `dist/`, on `PORT` (default 3000). Run `pnpm build` first. |
| `pnpm db:migrate` | Creates the database tables. Safe to run more than once. |
| `pnpm db:seed` | Creates the tables if needed, then inserts the CVs from `server/db/seed.json` that don't exist yet. |
| `pnpm db:test` | Starts a throwaway Postgres in Docker on port 5499 (see [Local environment with Docker](#local-environment-with-docker)). |
| `pnpm db:local:init` | `db:test`, then `db:seed --wait` once Postgres accepts connections. |
| `pnpm proxy` | Cloud SQL Auth Proxy to the `dev` database. |
| `pnpm test:unit` | Vitest, in watch mode. The Postgres tests run when `TEST_DATABASE_URL` is set. |
| `pnpm test:e2e` | Playwright end-to-end tests. Needs `TEST_DATABASE_URL`. |
| `pnpm lint` | oxlint, ESLint and stylelint, all with `--fix`. |
| `pnpm format` | Prettier on `src/`. |

### Environment variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | dev, start, db scripts | Postgres connection string, read from `.env.local` locally and from Secret Manager in production. |
| `TEST_DATABASE_URL` | tests | Optional for unit tests: turns on the Postgres tests, which run in a temporary schema dropped afterwards. Required for `pnpm test:e2e`, which uses the `e2e` schema. |
| `PORT` | start | HTTP port. Default `3000`; Cloud Run sets `8080`. |
| `STATIC_ROOT` | start | Folder containing the built front end. Default `dist`. |
| `IAP_AUDIENCE` | production | Expected audience of the IAP token, `/projects/PROJECT_NUMBER/locations/REGION/services/SERVICE`. Set by the deploy workflow. When it is set, every `/api` call must carry a valid IAP token. |
| `DEV_USER_EMAIL` | dev, start | Signed-in user when `IAP_AUDIENCE` is not set. Default `dev@localhost`. In production (`NODE_ENV=production`) the server refuses to start without `IAP_AUDIENCE`, unless this is set. |
| `DEV_USER_TITLE` | dev, start | Job title of `DEV_USER_EMAIL`, e.g. `Business Developer` to edit every CV locally (see [Who can edit a CV](#who-can-edit-a-cv)). Unset by default. |

`.env.local` is ignored by git. Never commit a connection string.

## Project structure

```
src/                 Vue front end
  main.ts            app entry point and router
  App.vue            root component (<RouterView>)
  views/             one component per route
  components/        reusable UI pieces
  composables/       state and behaviour shared by components (useCv)
  service/           HTTP calls to the API (cvApi)
  styles/            global SCSS: variables, mixins, shared blocks
  types.ts           re-exports the shared CV types
shared/
  cv.ts              Zod schemas and types, used by the front end and the back end
server/              Hono back end
  index.ts           production entry point (API + static files)
  app.ts             builds the Hono app and wires its dependencies
  routes/            HTTP layer: routing, validation, responses
  services/          business logic and domain errors
  repository/        data access (Postgres)
  db/                connection pool, migration, seed data
  pdf/               PDF rendering with Playwright
  scripts/           db:migrate and db:seed
  __tests__/         API and repository tests
e2e/                 Playwright end-to-end tests and their database setup
deploy/              one-off GCP setup scripts
Dockerfile           production image
.github/workflows/   CI and deployment
```

## Front end

Vue 3 with TypeScript, Vite and Vue Router.

### Composition API

Every component uses `<script setup lang="ts">`:

- **Props and events are typed:** `defineProps<{ … }>()` and `defineEmits<{ … }>()`.
- **State uses** `ref`, `computed` and `useTemplateRef`; there is no Options API and no global store.
- **Shared logic lives in composables** (see below) rather than in mixins.

### How the layers fit together

```
View  ──uses──▶  Composable  ──calls──▶  Service  ──fetch──▶  /api
 │                   │
 └─ passes state ──▶ Components ──call save()──┘
```

- **Views** (`src/views/`) are the pages, one per route:
  - `HomeView` (`/`) lists the CVs by name only, with a search by name (`shared/names.ts`: accents, case and word order are ignored). The search is kept in the URL (`/?q=…`).
  - `CvView` (`/cv/:id`) shows and edits one CV, and offers the PDF download. It gets the route `id` as a prop (`props: true`).
  - Because `App.vue` keys `<RouterView>` on the full path, switching CV mounts a fresh view.
- **Composables** (`src/composables/`) hold a page's state and behaviour.
  - `useCv(id)` loads the CV and saves changes. It also exposes loading, saving and export errors, and handles the PDF download.
  - `save(patch)` merges the patch into the CV and sends the whole CV. The change is shown once the server confirms it. With `{ optimistic: true }`, as used for drag-and-drop reordering, it is shown immediately and undone if the save fails.
- **Services** (`src/service/`) are the only code that knows about HTTP.
  - `cvApi.ts` wraps `fetch` for each endpoint and turns network and HTTP failures into `Error`s. Their messages are the plain-text French error messages sent by the server.
  - `errorMessage(error)` turns any caught error into displayable text.
- **Components** (`src/components/`) are presentational.
  - They receive data through props. To change the CV, they either call the `save` function they are given or emit events to their parent.
  - The components:
    - `CvHeader`: name, title and bio.
    - `CvSkills`: expertise, methodologies, trainer.
    - `CvExperiences`: list, add, edit, delete, reorder (drag-and-drop with `vue-draggable-plus`).
    - `ExperienceCard`: one experience.
    - `ExperienceForm`: add and edit form.
    - `InlineEdit`: generic click-to-edit field. It exposes an `edit` function through a scoped slot.

The front end shares its types with the back end through `shared/cv.ts`, re-exported by `src/types.ts`, so the API contract has a single definition.

### Styles: SCSS and BEM

- **Global styles** live in `src/styles/`:
  - `_variables.scss`: colours, fonts, widths, and the `mobile` mixin.
  - `cv.scss`: blocks shared between components, such as `.card`, `.button`, `.divider` and `.row`, and the print rules.
- **Component styles** go in the component's `<style lang="scss">` block. They are not scoped, because BEM class names already keep them from clashing. Start the block with `@use '@/styles/variables' as *;`.
- **Class names follow [BEM](https://getbem.com/naming/):**
  - a block named after the component (`.inline-edit`);
  - elements written `__element` (`.inline-edit__field`);
  - modifiers written `--modifier` (`.inline-edit--multiline`).

  In SCSS, nest elements and modifiers under the block with `&__` and `&--`. Don't style tags, and don't nest selectors more deeply than BEM needs.
- **Fonts:** Montserrat (headings) and Open Sans (body) come from `@fontsource-variable`, so the PDF doesn't depend on fonts installed on the server.
- **Linting:** stylelint (`standard-scss` and Vue configs) checks styles. Properties are ordered with `recess-order`, and `pnpm lint` reorders them automatically.

### Print and PDF

The PDF is generated from the same page the user sees.

- Print rules in `cv.scss` (`@media print`) adapt the layout to A4.
- `break-inside: avoid` keeps each section on one page.
- The server adds a red band at the top of every page and the Zenika logo at the bottom.

## Back end

The back end is [Hono](https://hono.dev/) on Node.js (`@hono/node-server`), with [Zod](https://zod.dev/) for validation. The TypeScript files run directly with Node 24's type stripping, so `tsconfig.server.json` only allows syntax that can simply be erased: no `enum` and no parameter properties. Imports use the `.ts` extension.

### API

All routes are under `/api`. Errors are returned as plain text in French. Every route answers `401` without a signed-in user (see [Authentication](#authentication)).

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/api/me` | `200`: the signed-in user, `{ email, name, title?, relations }` (name, job title and relations from the Workspace directory) |
| `GET` | `/api/cvs` | `200`: list of main CVs (no versions), `{ id, firstname, name, title, ownerEmail }` |
| `POST` | `/api/cvs/import` | Body: a PDF from the Zenika template. With `?owner=me`, the CV is the signed-in user's: if the PDF's name doesn't match their account (accents, case and word order aside), the account's name is used instead. `201`: `{ id, warnings }` · `400` if it isn't a PDF · `413` over 10 MB · `422` if it can't be read |
| `GET` | `/api/cvs/:id` | `200`: the full CV, with its version in the `ETag` header and `Allow` telling whether I can edit it · `404` |
| `PUT` | `/api/cvs/:id` | Replaces the whole CV. Needs `If-Match` with the version it replaces. `204` with the new version in `ETag` · `400` if the body is invalid · `404` · `403` if I can't edit it · `412` if someone saved the CV in the meantime · `428` without `If-Match` |
| `GET` | `/api/cvs/:id/versions` | `200`: the main CV then its versions, `[{ id, label }]` (`label` is `null` for the main CV), from the main CV or any of its versions · `404` |
| `POST` | `/api/cvs/:id/versions` | Body `{ label }` (1 to 100 characters). Copies the CV (main or version) into a new version of the main CV. `201`: `{ id }` · `400` · `403` if I can't edit it · `404` |
| `PUT` | `/api/cvs/:id/label` | Body `{ label }`. Renames a version. `204` · `400` · `403` · `404` · `409` for a main CV |
| `POST` | `/api/cvs/:id/claim` | Makes the signed-in user the owner of a CV nobody owns. `204` · `404` · `409` if the CV has an owner, is a version, or the user already owns one |
| `DELETE` | `/api/cvs/:id` | Deleting a main CV deletes its versions too. `204` · `403` if I can't edit it · `404` |
| `GET` | `/api/cvs/:id/pdf` | `200`: `application/pdf` · `404` · `500` if the export fails |

### CV owners

Each CV can have an owner, `owner_email` in the `cvs` table. It's kept outside the CV data, so saving a CV never changes it. A unique index keeps it to one CV per person. A CV gets its owner in two ways:

- imported with "Importer mon CV" (`POST /api/cvs/import?owner=me`): if the PDF's name doesn't match the account (`shared/names.ts`: accents, case and word order are ignored), the account's name is used instead; a second import of one's own CV answers `409`;
- claimed from the home page (`POST /api/cvs/:id/claim`), for CVs created before owners existed or imported for someone else.

### CV versions

Whoever can edit a CV can make versions of it, e.g. one per client: "Nouvelle version" on the CV page copies the CV being viewed under a label. A version is a row of `cvs` with `source_id` pointing to the main CV (always the main one, even when copying a version) and a `label`; its id is `<main id>-v2`, `-v3`… so the label never shows in a URL or a PDF file name. Versions:

- are edited like any CV, independently of the main CV and of each other;
- have no owner of their own: edit rights and ownership come from the main CV;
- aren't listed on the home page; the CV page shows the main CV and its versions in a bar, hidden when printing, so the label never appears on the PDF;
- are deleted with their main CV (`on delete cascade`).

### Who can edit a CV

Everyone signed in can read every CV, export it and import new ones. Changing or deleting a CV (`PUT` and `DELETE /api/cvs/:id`) is allowed only to (`server/auth/permissions.ts`):

- its owner;
- the owner's manager: the signed-in email is a `manager` relation of the owner in the Workspace directory;
- anyone whose directory job title is "Business Developer" or "Directeur d’agence" (case, accents and apostrophe style are ignored). They are the only ones who can change a CV nobody owns.

Anyone else gets a `403`. `GET /api/cvs/:id` answers `Allow: GET, PUT, DELETE` when the signed-in user can edit the CV, `Allow: GET` otherwise; the CV page then hides every edit button. Owners' relations come from the same cached directory lookup as the signed-in user's profile. The e2e user is a Business Developer (`DEV_USER_TITLE` in `playwright.config.ts`).

### First visit

When the signed-in user owns no CV, the home page shows a welcome card. If unowned CVs match their name, it asks "Est-ce le vôtre ?" with a "C'est mon CV" button; it always offers to import their CV. "Plus tard" is remembered in the browser's `localStorage`, per email. The user's own CV is marked "Mon CV" in the list. The e2e tests run as `jeanne.leroy@zenika.com` (`DEV_USER_EMAIL` in `playwright.config.ts`).

### Concurrent edits

Each CV has a `version`, increased by every save. The page keeps the version it loaded and sends it back in `If-Match`; the update only applies `where version = <that version>`, so two saves made from the same version can't both succeed. The second one gets a `412`, and the page offers to reload the CV, losing its unsaved change. Saves from one page are sent one after another, each with the version returned by the previous one.

### Authentication

In production, IAP signs in the user before any request reaches the app, and adds a signed token, `x-goog-iap-jwt-assertion`. `server/auth/identity.ts` checks its signature (Google's public keys), issuer and audience (`IAP_AUDIENCE`), then reads the email. The plain `x-goog-authenticated-user-email` header is never trusted.

- The full name comes from the Google Workspace directory (`server/auth/directory.ts`). The runtime service account has a read-only Workspace admin role (Users > Read): the app asks Cloud Run's metadata server for a token with the `admin.directory.user.readonly` scope and reads the user's name, job title (`organizations[].title`, the primary organization first) and relations (`relations[]`, `{ value, type }`, e.g. their manager). Profiles are cached for 12 hours. If the directory can't be reached, the name is built from the address (`prenom.nom@…` → "Prenom Nom", without accents) with no title and no relations, the reason is logged (`profil de … introuvable dans l’annuaire`) and the directory is asked again 5 minutes later.
- Locally and in the e2e tests there is no IAP: the user is `DEV_USER_EMAIL` (default `dev@localhost`), with the title `DEV_USER_TITLE` if set, and no relations.
- The PDF export loads the CV page from inside the container, without IAP. It sends a random token generated when the server starts (`x-zen-cv-internal-token`), which no one outside the process knows.
- When a token is refused, the server logs the audience it received and the one it expected. If every call answers `401` after a deploy, compare the two in the Cloud Run logs and fix `IAP_AUDIENCE`.

### Layers

```
routes/  ──▶  services/  ──▶  repository/  ──▶  PostgreSQL
                  └──────────▶  pdf/  ──▶  headless Chromium
```

- **Routes** (`routes/cvs.ts`) handle HTTP only. They read parameters, validate the body and turn results into responses.
- **Service** (`services/cvService.ts`) holds the business rules, for example "a missing CV is an error" or "check the CV exists before exporting it". It throws domain errors (`services/errors.ts`), which `app.ts` maps to HTTP statuses in `onError`.
- **Repository** (`repository/`) is the only code that writes SQL.
  - The `CvRepository` interface has one implementation, `postgresRepository.ts`. The tests use an in-memory one.
  - Data read from the database is validated with `cvSchema` too.
- **Dependencies are passed in, not imported.**
  - `createServerApp()` creates the pool, the PDF renderer, the repository and the service, and passes each one to the next.
  - The tests call `createApp(service)` with a fake repository instead.

### Zod

`shared/cv.ts` defines the CV schema once (`cvSchema`, `experienceSchema`, …). The TypeScript types are derived from it with `z.infer`, so they cannot drift apart.

- **Request validation:** `@hono/zod-validator` checks `PUT` bodies. An invalid body gets a `400` with `z.prettifyError`, which lists each invalid field. Error messages are in French (`z.config(z.locales.fr())`).
- **Typed handlers:** after validation, `c.req.valid('json')` is typed as `UserData`.
- **Changing the CV format:** edit the schema. The types, the API validation and the front end all follow. Existing rows that no longer match the schema will fail to load, so update the data too.

### Database

The data is stored in one table, `cvs`:
- `id text primary key`;
- `data jsonb`, which holds the whole CV;
- `created_at` and `updated_at`.

The CV is always read and written as a whole document, so it doesn't need relational tables.

The migration in `db/database.ts` is idempotent, and the production server runs it on every start. `db/seed.json` holds the initial CVs.

### PDF export

`pdf/pdfRenderer.ts` turns a CV into a PDF:

1. It opens the app's own `/cv/:id` page in headless Chromium.
2. It waits for the CV and the fonts to finish loading.
3. It prints the page to an A4 PDF, with the red band at the top of each page and the logo at the bottom.

A single browser is started on the first export and reused. Each export gets its own browser context, so several exports can run at the same time.

### How the dev server works

In development there is no separate back-end process.

- The `apiServer()` plugin in `vite.config.ts` loads `server/app.ts` through Vite and handles every `/api/*` request.
- Back-end code reloads on save, just like the front end.
- `DATABASE_URL` is read from `.env.local`.

## Tests

```sh
pnpm test:unit                          # unit tests, all projects, watch mode
pnpm exec vitest run --project app      # front end only
pnpm exec vitest run --project server   # back end only
pnpm test:e2e                           # end-to-end tests (needs TEST_DATABASE_URL)
```

### Unit tests (Vitest)

Vitest runs two projects (`vitest.config.ts`):

- `app`: front-end tests in jsdom with `@vue/test-utils`, next to the code they test (`src/**/__tests__`):
  - `service/__tests__/cvApi.spec.ts`: URLs, request bodies and error messages, with `fetch` mocked.
  - `composables/__tests__/useCv.spec.ts`: loading, saving (including optimistic saves and their rollback) and the PDF download, with the API service mocked.
  - `components/__tests__/`: `InlineEdit`, `ExperienceForm` (form ↔ experience conversion) and `CvExperiences` (add, edit, keyboard reordering).
- `server`: back-end tests in Node (`server/__tests__`).
  - `cvs.spec.ts` tests the API end to end through `app.request()`, using an in-memory repository and a fake PDF renderer.
  - `postgresRepository.spec.ts` runs against a real Postgres when `TEST_DATABASE_URL` is set, in a temporary schema. Don't point it at a database you care about.

### End-to-end tests (Playwright)

`e2e/cv.spec.ts` drives the real app in Chromium: listing and opening CVs, editing the title, adding and deleting an experience, keyboard reordering, PDF export, and the error shown for an unknown CV.

`pnpm test:e2e` (see `playwright.config.ts`):

1. builds the front end;
2. resets the `e2e` schema of the `TEST_DATABASE_URL` database (`e2e/prepare-db.ts`): drops it, recreates it, migrates and seeds it;
3. starts the production server on port 4173 against that schema;
4. runs the tests one at a time, since they share the database.

Each run starts from the seed data, and nothing outside the `e2e` schema is touched. The first time, install the browser with `pnpm exec playwright install chromium`.

Locally, any throwaway Postgres will do, for example the one from `pnpm db:test` (see [Local environment with Docker](#local-environment-with-docker)).

## Deployment

The app runs on **Google Cloud Run** (`europe-west9`) with **Cloud SQL for PostgreSQL**. **Identity-Aware Proxy** restricts access to `@zenika.com` Google accounts.

### Continuous deployment

`.github/workflows/deploy.yml` has two jobs:

- **check** runs on every push and pull request:
  1. install dependencies;
  2. lint, and fail if lint changes any file;
  3. type-check and build;
  4. run all the Vitest tests, front and back, against a temporary Postgres;
  5. run the Playwright end-to-end tests. If they fail, the report and traces are uploaded as the `playwright-report` artifact.
- **deploy** runs on `main` only:
  1. signs in to GCP through Workload Identity Federation, so no keys are stored in GitHub;
  2. builds the Docker image and pushes it to Artifact Registry;
  3. deploys it to Cloud Run. `DATABASE_URL` comes from Secret Manager (`zen-cv-database-url`).

The workflow reads these GitHub repository variables:
- `GCP_PROJECT_ID`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_DEPLOY_SERVICE_ACCOUNT`
- `GCP_RUNTIME_SERVICE_ACCOUNT`
- `CLOUD_SQL_CONNECTION_NAME`

### Docker image

The `Dockerfile` builds in two stages:

1. Build the front end.
2. Create a Node 24 runtime image with production dependencies and Chromium for the PDF export. The server runs as the non-root `node` user on port 8080.

To try the image locally:

```sh
docker build -t zen-cv .
docker run --rm -p 8080:8080 -e PORT=8080 -e DATABASE_URL=postgresql://… zen-cv
```

When the container runs in Docker on Linux, `localhost` points to the container itself. To reach a database on your machine, add `--network host`.

### Setting up a new GCP project

These scripts are run once, by hand. All are safe to run again.

1. `deploy/setup-gcp.sh` sets up the project:
   - enables the APIs and creates the Artifact Registry repository;
   - creates the service accounts and the `DATABASE_URL` secret;
   - configures Workload Identity Federation for `Zenika/zen-cv`;
   - prints the GitHub variables to set.
2. Deploy once, by pushing to `main` or running the workflow manually.
3. `deploy/enable-iap.sh` turns on IAP and grants access to the `zenika.com` domain.
4. `deploy/enable-directory.sh` lets the app read users' full names (see [Authentication](#authentication)). It enables the Admin SDK API, then prints the last step for a Workspace super admin: create an admin role with only **Admin API privileges → Users → Read**, and assign it to the `zen-cv-run` service account.

The Zenika organisation only allows resources in approved regions (`constraints/gcp.resourceLocations`). Anything that would default to `global` must be pinned to `europe-west9`.

### Cloud Run settings

The Cloud SQL socket URL has the form `postgresql://USER:PASSWORD@/DATABASE?host=/cloudsql/PROJECT:REGION:INSTANCE`.

The service has 2 GiB of memory, for Chromium, and handles at most 10 concurrent requests per instance. It scales to zero, so the first request after a quiet period takes a few seconds.

## Conventions

- **Language:** code is in English; text shown to users, including API error messages, is in French.
- **Comments:** keep them rare.
- **Formatting:** Prettier, with the settings in `.prettierrc.json`. Run `pnpm lint` before committing; CI fails if lint would change anything.
