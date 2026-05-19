# Replace Clerk with Native Next.js Auth — Design

**Date:** 2026-05-19
**Status:** Approved (pending implementation)
**Scope:** Remove `@clerk/nextjs` and replace it with a hand-rolled email/password + JWT-cookie auth system. No email verification, no password reset, no OAuth, no database sessions.

## Goals

- Remove all Clerk dependencies, components, env vars, and routes.
- Provide email + password sign-up, sign-in, sign-out.
- Persist sessions via a signed JWT in an httpOnly cookie (7-day expiry).
- Keep the existing app behavior unchanged: middleware route protection, ArcJet rate limiting, server actions, and the `User → Account → Transaction` data flow.

## Non-goals

- Email verification, password reset, magic links, OAuth providers.
- Database-backed sessions or session revocation lists.
- Any change to ArcJet, Inngest, Resend email, or Gemini integrations.
- Any unrelated refactor.

## Constraints

- Existing DB is fresh — no user data to preserve. Single migration is acceptable.
- Middleware runs in the Edge runtime — JWT verification there must use `jose` (not `bcryptjs`, not `jsonwebtoken`).
- Project is JavaScript (not TypeScript). All new files are `.js` or `.jsx`.
- Path alias `@/*` maps to repo root.

## Architecture

### Data model (`prisma/schema.prisma`)

`User` model becomes:

```prisma
model User {
  id           String        @id @default(uuid())
  email        String        @unique
  password     String        // bcrypt hash
  name         String?
  imageUrl     String?
  transactions Transaction[]
  accounts     Account[]
  budgets      Budget[]
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt

  @@map("users")
}
```

Changes:
- Drop `clerkUserId` column.
- Add required `password` (bcrypt hash, never null).
- Everything else (`Account`, `Transaction`, `Budget`, enums) unchanged.

Migration command: `npx prisma migrate dev --name remove_clerk_add_password`.

### Auth module (`lib/auth.js`)

Single file exposes the entire auth surface used by the rest of the app.

```
hashPassword(plain)           -> Promise<string>          // bcryptjs, 10 rounds
verifyPassword(plain, hash)   -> Promise<boolean>

signSession(userId)           -> Promise<string>          // jose HS256, 7d expiry
verifySession(token)          -> Promise<{userId} | null>

getSessionCookie()            -> string | null            // reads "session" cookie via next/headers
setSessionCookie(token)       -> void                     // httpOnly, secure in prod, sameSite:lax, 7d
clearSessionCookie()          -> void

getCurrentUserId()            -> Promise<string | null>
requireUserId()               -> Promise<string>          // throws "Unauthorized" if missing
getCurrentUser()              -> Promise<User | null>     // DB lookup; replaces lib/checkUser.js
```

- `hashPassword`/`verifyPassword` — pure crypto over `bcryptjs`.
- `signSession`/`verifySession` — JWT helpers over `jose` (Edge-safe — same lib used by middleware).
- Cookie helpers — wrap Next's `cookies()` from `next/headers`. Cookie name: `session`. `httpOnly: true`, `sameSite: "lax"`, `secure: process.env.NODE_ENV === "production"`, `maxAge: 60 * 60 * 24 * 7`, `path: "/"`.
- `requireUserId()` is what every server action calls — the single replacement for the current `auth() → findUnique({clerkUserId})` two-step.

### Auth actions (`actions/auth.js`)

```
signUp({ email, password })   // creates User; sets cookie; returns {success: true}
signIn({ email, password })   // verifies password; sets cookie; returns {success: true}
signOut()                     // clears cookie; returns {success: true}
```

Behavior:
- `signUp` — checks `email` not already taken (Prisma unique constraint catches race), `hashPassword`, `db.user.create`, `signSession(user.id)`, `setSessionCookie`, returns `{success: true}`. On unique-constraint error, returns `{success: false, error: "Email already registered"}`.
- `signIn` — `findUnique({email})`, `verifyPassword`, on either failure returns generic `{success: false, error: "Invalid email or password"}` (no user enumeration). On success, sets cookie and returns `{success: true}`.
- `signOut` — `clearSessionCookie`, returns `{success: true}`.

All three are `"use server"`. Client pages call them via the existing `useFetch` hook and redirect on success via `router.push("/dashboard")` (or `"/"` for sign-out).

### Validation schemas (`app/lib/schema.js`)

Add:

```js
signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});
```

### Middleware (`middleware.js`)

ArcJet stays, Clerk is replaced with a small JWT verifier in the Edge runtime.

```
isProtectedRoute = matches /dashboard, /account, /transaction (and their subpaths)

authMiddleware(req):
  if not protected -> NextResponse.next()
  token = req.cookies.get("session")?.value
  if !token -> redirect /sign-in
  try jwtVerify(token, JWT_SECRET) -> NextResponse.next()
  catch -> redirect /sign-in (and clear cookie)

export default createMiddleware(aj, authMiddleware)
```

- Uses `jose#jwtVerify` directly (not `lib/auth.js#verifySession`) because middleware bundles for Edge and must avoid Node-only deps.
- Order preserved: ArcJet first (shield + bot detection), auth second.
- `config.matcher` unchanged.

### UI

**`app/layout.js`** — remove `<ClerkProvider>` wrapper. Everything else unchanged.

**`components/header.jsx`** — server component. Calls `getCurrentUser()` and renders:
- If `user` — Dashboard button, Add Transaction button, dropdown showing `user.email` with a sign-out form (`<form action={signOut}>` rendering a button).
- If `null` — `<Link href="/sign-in">Login</Link>` button.

Removes imports: `SignedIn`, `SignedOut`, `SignInButton`, `UserButton` from `@clerk/nextjs`.

**Sign-in page** (`app/(auth)/sign-in/page.jsx`)
Client component. react-hook-form + zod (`signInSchema`). Email + password fields. Submits via `useFetch(signIn)`. On success → `router.push("/dashboard")`. Renders error message on failure. Link at the bottom: "No account? Sign up".

**Sign-up page** (`app/(auth)/sign-up/page.jsx`)
Same shape with email + password + confirm-password (zod `.refine` to compare). Submits `signUp`. Same redirect behavior. Link: "Already have an account? Sign in".

### Server-action migration

All four files in `actions/` follow the same pattern today:

```js
import { auth } from "@clerk/nextjs/server";
const { userId } = await auth();
if (!userId) throw new Error("Unauthorized");
const user = await db.user.findUnique({ where: { clerkUserId: userId } });
if (!user) throw new Error("User not found");
// queries use user.id
```

Becomes:

```js
import { requireUserId } from "@/lib/auth";
const userId = await requireUserId();
// queries use userId directly
```

The JWT carries the local `User.id`, so the second `findUnique` lookup is gone. Where action code references `user.email`, `user.name`, etc., keep an explicit `db.user.findUnique({ where: { id: userId } })` — but only in the few places that actually need fields beyond the id.

Affected files and call-sites:
- `actions/account.js` — `getAccountWithTransactions`, `bulkDeleteTransactions`, `updateDefaultAccount` (3 sites)
- `actions/budget.js` — 2 sites
- `actions/dashboard.js` — `getUserAccounts`, `createAccount`, `getDashboardData` (3 sites)
- `actions/transaction.js` — `createTransaction`, `getTransaction`, `updateTransaction`, `getUserTransactions` (4 sites)

ArcJet calls in `createAccount` and `createTransaction` pass `userId` as the rate-limit key. The key value is now a local UUID instead of a Clerk ID — ArcJet treats both as opaque strings; no change required.

`actions/transaction.js#scanReceipt` does not call `auth()` — leave it alone.

### Files to delete

- `lib/checkUser.js` — lazy upsert no longer needed; users are created explicitly by `signUp`.
- `app/(auth)/sign-in/[[...sign-in]]/` directory — Clerk catch-all, replaced by plain `page.jsx`.
- `app/(auth)/sign-up/[[...sign-up]]/` directory — same.
- `.clerk/` directory — already gitignored; remove if it exists locally.

### Files to edit (full list)

- `prisma/schema.prisma`
- `app/lib/schema.js`
- `app/layout.js`
- `components/header.jsx`
- `middleware.js`
- `actions/account.js`
- `actions/budget.js`
- `actions/dashboard.js`
- `actions/transaction.js`
- `README.md` (drop the six `*_CLERK_*` env vars, add `JWT_SECRET` with generation instructions)
- `CLAUDE.md` (update auth section, server-action pattern, middleware order)

### Files to create

- `lib/auth.js`
- `actions/auth.js`
- `app/(auth)/sign-in/page.jsx`
- `app/(auth)/sign-up/page.jsx`

### Dependency changes (`package.json`)

- Remove: `@clerk/nextjs`
- Add: `bcryptjs`, `jose`

### Environment variables

- **Remove from `.env`**: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`, `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL`.
- **Add to `.env`**: `JWT_SECRET` — minimum 32 characters. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` or `openssl rand -base64 32`.
- Untouched: `DATABASE_URL`, `DIRECT_URL`, `GEMINI_API_KEY`, `RESEND_API_KEY`, `ARCJET_KEY`.

## Security notes

- Generic error message on sign-in failure (`"Invalid email or password"`) — no user enumeration.
- Sign-up returns `"Email already registered"` on unique-constraint failure — accepted tradeoff for a basic app.
- Cookie flags: `httpOnly`, `sameSite: "lax"`, `secure` in production, 7-day expiry.
- JWT signed with `HS256` over `JWT_SECRET`; payload contains only `userId` and standard claims (`iat`, `exp`).
- bcryptjs cost factor: 10 (sufficient for current usage; raise later if needed).
- The middleware verifier and `lib/auth.js#verifySession` use the same `JWT_SECRET` — keep them in sync if signing parameters ever change.

## Manual test plan

No automated tests exist in this repo. Verify manually after implementation:

1. `/` — header renders a Login button.
2. `/sign-up` — register a new user → auto-redirect to `/dashboard`.
3. Refresh `/dashboard` — still authenticated (cookie survives).
4. Sign out from header — redirected; header shows Login again.
5. `/sign-in` with same credentials — signs in and redirects to `/dashboard`.
6. Sign out, then visit `/dashboard` directly — middleware redirects to `/sign-in`.
7. While signed in: create an account, create a transaction, delete a transaction — confirm `Account.balance` updates correctly. This is the regression check on the `userId` swap.
8. `/sign-in` with wrong password — generic error message, no enumeration of which field was wrong.

## Migration sequence (for the implementation plan)

1. Edit `prisma/schema.prisma`; run `npx prisma migrate dev --name remove_clerk_add_password`.
2. `npm uninstall @clerk/nextjs && npm install bcryptjs jose`.
3. Create `lib/auth.js`.
4. Create `actions/auth.js`.
5. Add zod schemas to `app/lib/schema.js`.
6. Replace middleware.
7. Replace sign-in / sign-up pages (delete old Clerk catch-all directories, create new plain pages).
8. Update `app/layout.js` and `components/header.jsx`.
9. Migrate the four `actions/*.js` files.
10. Delete `lib/checkUser.js`.
11. Update `README.md` and `CLAUDE.md`.
12. Run through the manual test plan.

## Open questions

None at design time. All scope decisions were resolved during brainstorming.
