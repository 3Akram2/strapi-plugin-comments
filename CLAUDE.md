# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **fork** of [VirtusLab's `strapi-plugin-comments`](https://github.com/VirtusLab-Open-Source/strapi-plugin-comments), published as `@3akram2/strapi-plugin-comments`. It is a **Strapi v5 plugin** providing end-to-end comments (REST + GraphQL), moderation panel, abuse reporting, and bad-words filtering.

Fork-specific enhancements (see README for details): Strapi v5 `documentId` support on all CRUD paths (`authorDocumentId`, `commentDocumentId`), disabled reply-email notifications (to avoid 6-min timeouts — re-enable by removing the early return in `sendResponseNotification`), `reactionsCount` field, `mentions` relation to users. When modifying author/thread lookup logic, preserve the dual numeric-ID / documentId fallback behavior.

## Commands

```bash
yarn build                 # strapi-plugin build --minify (cleans build/ first)
yarn watch                 # strapi-plugin watch (live-link into a host Strapi app)
yarn watch:link            # strapi-plugin watch:link
yarn verify                # strapi-plugin verify
yarn build:admin:watch     # tsc watch for admin
yarn build:server:watch    # tsc watch for server

yarn test:unit             # jest across both server + admin projects (with coverage)
yarn test:unit:watch       # jest watch
yarn test:unit:ci          # CI=true, runInBand
yarn lint                  # prettier --check .
yarn format                # prettier --write .
```

Run a single test file: `yarn jest server/src/services/__tests__/client.service.test.ts`. Use `-t "pattern"` to filter by test name. The root `jest` config is a multi-project setup (`server/jest.server.config.ts` + `admin/jest.admin.config.ts`), both using `ts-jest`.

Node: `>=18.0.0 <=22.x.x` (see `.nvmrc`). Package manager: yarn 1.x. A `postinstall` script runs `yarn build` automatically.

## Architecture

The plugin follows the standard Strapi v5 plugin layout: two separate TS projects under `server/` and `admin/`, each with its own `tsconfig.json` and jest config. The top-level `package.json` `exports` field points `./strapi-server` and `./strapi-admin` at their respective entry points.

### Server (`server/src/`)

Entry `index.ts` exports `{ register, bootstrap, config, controllers, routes, services, contentTypes }`. The lifecycle:

1. **`register/index.ts`** — registers custom fields (`register/custom-fields/`).
2. **`bootstrap.ts`** — (a) wires GraphQL via `graphql/index.ts`, (b) requires `users-permissions` plugin, (c) registers six admin permission actions (`comments.read/moderate`, `reports.read/review`, `settings.read/change`), (d) subscribes Strapi DB lifecycles (`afterCreate`/`afterDelete`) so that when any related content entity is created/deleted, the plugin calls `commonService.perRestore` / `perRemove` keyed by `uid:documentId`.

**Layered design** (controller → service → repository):

- `controllers/` — `admin.controller.ts`, `client.controller.ts`, `settings.controller.ts`. Registered via `controllers/index.ts` as `{ admin, client, settings }`.
- `services/` — `admin/admin.service.ts`, `client.service.ts`, `common.service.ts`, `gql.service.ts`, `settings.service.ts`. Registered as `{ admin, client, common, settings, gql }`. Always retrieve with the typed helper `getPluginService(strapi, '<name>')` from `utils/getPluginService.ts` — it returns properly typed service instances.
- `repositories/` — `comment.repository.ts`, `report.comment.repository.ts`, `store.repository.ts`. Each uses `once()` to memoize the factory and wraps `strapi.query(modelUid).*` calls; results pass through **Zod validators** from `validators/repositories/` when `isValidationEnabled` is true (see `getConfig`). Repo factories are resolved via `getCommentRepository` / `getReportCommentRepository` / `getStoreRepository`.
- `validators/api/` — Zod request schemas for controllers; `validators/repositories/` — Zod response schemas for repositories. All external input and DB output is validated.
- `content-types/comments/schema.ts` — the `plugin::comments.comment` model. Includes fork-added fields: `authorDocumentId`, `authorUsername`, `reactionsCount`, `mentions` (oneToMany to `plugin::users-permissions.user`). Sister model: `content-types/report/`.
- `routes/` — `client.routes.ts` (public content-api, e.g. `GET/POST /:relation`, `PUT/DELETE /:relation/comment/:commentId`) and `admin.routes.ts` (admin `/moderate/*` endpoints). Aggregated in `routes/index.ts` under `content-api` and `admin` types.
- `graphql/index.ts` — disables default shadow CRUD for `comment` and `comment-report` models, then (if any collections are enabled in config) registers types/queries/mutations via the `graphql` plugin's extension service.
- `const/` — `APPROVAL_STATUS`, `REPORT_REASON`, `REGEX`, `CONFIG_PARAMS`.
- `config/index.ts` — Zod-schema-validated plugin config (`CommentsPluginConfig`); fields include `enabledCollections`, `moderatorRoles`, `approvalFlow`, `entryLabel`, `badWords`, `blockedAuthorProps`, `gql`, `client`.

### Admin (`admin/src/`)

Entry `index.ts` registers the menu link at `/plugins/comments` (lazy-loads `pages/App`) and a Settings section at `/settings/comments` (lazy-loads `pages/Settings`). Permissions gating uses `permissions.ts`.

- `pages/App/index.tsx` routes: `/discover`, `/discover/:id` (Details), `/reports`. Wrapped in `CommonProviders` (React Query, intl, etc.).
- `pages/` — `Discover`, `Details`, `Reports`, `Settings`.
- `api/client.ts` — a `once()`-memoized API client built on Strapi's `getFetchClient`. All responses go through Zod schemas from `api/schemas.ts`. URL prefix is `comments`.
- `hooks/` — `useAPI`, `useCommentMutations`, `useCommentsAll`, `useConfig`, `useReports`, `usePermissions`, `useUserContext`, etc. (tanstack-query based).
- `store/` — Zustand stores (e.g. `settings.store.ts`).
- `components/` — moderation UI (CommentRow, DiscussionThreadItem, ApproveFlow, ReviewFlow, SideNav, Wysiwyg, StatusBadge, etc.).

### Shared conventions

- **ID duality**: many server paths accept either a numeric `id` or a Strapi v5 `documentId`. When touching lookup/update/delete logic, follow the existing pattern of trying one, falling back to the other, and returning clear errors.
- **Validation everywhere**: controllers validate input with `validators/api`, repositories validate DB output with `validators/repositories` — gated by `isValidationEnabled` config. Prefer extending existing Zod schemas over adding ad-hoc runtime checks.
- **Error handling**: use `PluginError` from `utils/PluginError.ts` (and `throwError.ts` / `tryCatch.ts`) rather than throwing raw `Error`s.
- **Tests**: colocated under `__tests__/` beside source. `__mocks__/initSetup.ts` at the repo root is the shared Strapi mock harness used by server tests.
- **Husky pre-commit**: `yarn format && yarn test:unit` runs on every commit.
