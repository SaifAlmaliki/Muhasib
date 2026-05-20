# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Next.js dev server with --turbopack
npm run build    # Production build
npm run lint     # next lint (extends next/core-web-vitals; no-unused-vars: warn)
npm run email    # react-email dev server for emails/template.jsx
```

`postinstall` runs `prisma generate`. After editing `prisma/schema.prisma`, run `npx prisma migrate dev --name <name>` (migrations are committed under `prisma/migrations/`). There is no test suite configured.

## Required environment

Copy from README.md into `.env`:
`DATABASE_URL`, `DIRECT_URL` (Postgres + Prisma direct URL — Prisma uses `directUrl` for migrations), `JWT_SECRET` (≥16 chars for dev; generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`), `GEMINI_API_KEY`, `RESEND_API_KEY`, `ARCJET_KEY`.

## Stack & conventions

- **Next.js 15 App Router + React 19**, **JavaScript** (not TypeScript). `jsconfig.json` aliases `@/*` to repo root — always import via `@/...`.
- **shadcn/ui** is configured in `components.json`: style `new-york`, base color `neutral`, **`tsx: false`** (generated components are `.jsx`), no class prefix. UI primitives live in `components/ui/`. When adding shadcn components, generate as JSX.
- Component file extensions are mixed: `.jsx` for components with JSX, `.js` for plain modules — match the convention of the directory you are editing.

## Architecture — the parts that span files

### Route structure
`app/` uses two route groups: **`(auth)`** wraps Clerk's `/sign-in` and `/sign-up` pages; **`(main)`** wraps the authenticated app (`/dashboard`, `/account/[id]`, `/transaction/create`). Route-private components are colocated in `_components/` folders (Next.js convention — the underscore excludes them from routing).

### Middleware chain (`middleware.js`)
Requests pass through `createMiddleware(aj, authMiddleware)` — **ArcJet first, JWT auth second**. ArcJet runs `shield` + `detectBot` (DRY_RUN in dev, LIVE in prod; `GO_HTTP` is allowed so Inngest cron callbacks aren't blocked). The auth step verifies a `session` JWT cookie via `jose#jwtVerify` (Edge-compatible) and redirects to `/sign-in` on missing/invalid token. Protected paths are matched via the `PROTECTED_RE` regex covering `/dashboard`, `/account`, `/transaction` and their subpaths. Adding a new protected top-level route requires updating that regex here.

### Auth (`lib/auth.js`)
Email/password auth with a JWT in an httpOnly `session` cookie (7-day expiry). `lib/auth.js` exposes the entire surface: `hashPassword`/`verifyPassword` (bcryptjs), `signSession`/`verifySession` (jose HS256), cookie helpers (`get/set/clearSessionCookie`), and the gates `getCurrentUserId`, `requireUserId`, `getCurrentUser`. The JWT payload carries the local `User.id`, so server actions read `userId` directly from `requireUserId()` — no second `findUnique` lookup is needed unless an action needs additional user fields. Sign-in / sign-up / sign-out actions live in `actions/auth.js` and the pages live at `app/(auth)/sign-in/page.jsx` and `app/(auth)/sign-up/page.jsx`.

### Server actions (`actions/*.js`)
All mutations go through `"use server"` files in `actions/`. Pattern in every action:
1. `requireUserId()` from `@/lib/auth`; throws `Unauthorized` if no valid session.
2. For mutating actions, call ArcJet's `aj.protect(req, { userId, requested: 1 })` (rate-limit token bucket from `lib/arcjet.js`: 10/hour per userId).
3. Use `userId` directly in queries (it is the local `User.id`). Only call `db.user.findUnique({ where: { id: userId } })` if you need fields beyond the id.
4. Wrap multi-row writes in `db.$transaction(async (tx) => { ... })` — especially when a transaction write must also `increment` the `account.balance`. Account balance is the source of truth; **every code path that creates/updates/deletes a `Transaction` must adjust the linked `Account.balance` in the same `db.$transaction`** (see `actions/transaction.js` and `actions/account.js#bulkDeleteTransactions` for the patterns).
5. `revalidatePath("/dashboard")` and `revalidatePath(\`/account/${accountId}\`)` after writes.

### Prisma Decimal serialization
Prisma `Decimal` cannot cross the server→client boundary. Every action that returns an `Account` or `Transaction` runs it through a local `serializeDecimal` / `serializeAmount` / `serializeTransaction` helper that converts `balance` and `amount` via `.toNumber()`. When adding a new action that returns these models, add the same conversion or the client will crash on serialization.

### Prisma client singleton (`lib/prisma.js`)
`db` is a singleton stashed on `globalThis.prisma` to survive hot-reload in dev. Always import `{ db }` from `@/lib/prisma`; never instantiate `new PrismaClient()`.

### Zod schemas (`app/lib/schema.js`)
Validation schemas (`accountSchema`, `transactionSchema`) live here, **not** under `lib/`. Note `transactionSchema` uses `superRefine` to require `recurringInterval` when `isRecurring` is true — preserve this when extending.

### Inngest background jobs (`lib/inngest/`)
Four functions registered at `app/api/inngest/route.js`:
- `processRecurringTransaction` — event-driven, throttled 10/min/user.
- `triggerRecurringTransactions` — daily cron `0 0 * * *`, fans out events to the above.
- `generateMonthlyReports` — monthly cron `0 0 1 * *`; uses Gemini to produce insights and emails via Resend.
- `checkBudgetAlerts` — every 6h cron `0 */6 * * *`; sends an alert at ≥80% budget usage, gated by `lastAlertSent` per month.

The recurring-transaction logic is split: `triggerRecurringTransactions` enqueues events and `processRecurringTransaction` does the actual write. When changing recurrence semantics, update `calculateNextRecurringDate` in **both** `actions/transaction.js` and `lib/inngest/function.js` — the helper is duplicated.

### Gemini AI usage
Two integrations, both via `@google/generative-ai` with model `gemini-1.5-flash`:
- `scanReceipt(file)` in `actions/transaction.js` — base64-encodes an uploaded image and asks Gemini to return structured JSON (amount, date, description, merchantName, category constrained to the categories enum).
- `generateFinancialInsights(stats, month)` in `lib/inngest/function.js` — monthly report insights.

Both strip ` ```json ` fences before `JSON.parse`. Server actions accepting files rely on `next.config.mjs` `serverActions.bodySizeLimit: "5mb"` — increase there if needed.

### Categories (`data/categories.js`)
The category list (id, name, type INCOME/EXPENSE, color, icon, subcategories) is the source of truth used by forms, the Gemini receipt-scan prompt, and chart colors. Adding a category means updating this file *and* the receipt-scan prompt's allowed list in `actions/transaction.js`.

### Client data-fetching hook (`hooks/use-fetch.js`)
`useFetch(serverAction)` returns `{ data, loading, error, fn, setData }` and toasts errors via `sonner`. This is the standard way client components invoke server actions.

### Email
`emails/template.jsx` is a single React Email template that branches on a `type` prop (`"monthly-report" | "budget-alert"`). Sent via `actions/send-email.js` (Resend). Preview locally with `npm run email`.
