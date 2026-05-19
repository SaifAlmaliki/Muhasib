# Replace Clerk with Native Next.js Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `@clerk/nextjs` and replace with email/password auth backed by a JWT session cookie, with no email verification, password reset, or OAuth.

**Architecture:** Single auth module (`lib/auth.js`) provides `bcryptjs` password helpers, `jose` JWT sign/verify, cookie helpers, and a `requireUserId()` server-action gate. Middleware uses `jose#jwtVerify` directly (Edge runtime). Three server actions (`signUp`/`signIn`/`signOut`) wrap the module. JWT carries the local `User.id` so server actions skip the second DB lookup.

**Tech Stack:** Next.js 15 (App Router) + React 19, JavaScript, Prisma + Postgres, `bcryptjs`, `jose`, Zod, react-hook-form, sonner toasts, ArcJet (kept), Inngest (kept), Resend (kept), Gemini (kept).

**Spec:** `docs/superpowers/specs/2026-05-19-remove-clerk-auth-design.md`

**Repo testing reality:** This repo has no Jest/Vitest/Playwright setup, no test scripts. Verification at every task = `npm run lint` and visual/manual checks through `npm run dev`. The final task is the full manual smoke test from the spec.

**Implementation order rationale:** New code is built first (deps, `lib/auth.js`, `actions/auth.js`, zod schemas, sign-in/up pages). Consumers are migrated next (middleware, layout, header, four actions). Only after all `clerkUserId` references are gone do we run the Prisma migration and uninstall `@clerk/nextjs`. This keeps the codebase compilable at every commit.

---

## Task 1: Install new dependencies

**Files:**
- Modify: `package.json` (via `npm install`)
- Modify: `package-lock.json` (auto)

- [ ] **Step 1: Install bcryptjs and jose**

Run: `npm install bcryptjs jose`
Expected: Both packages added to `dependencies` in `package.json`. No errors.

- [ ] **Step 2: Verify install**

Run: `npm ls bcryptjs jose`
Expected: Both listed with version numbers, no `UNMET DEPENDENCY` warnings.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add bcryptjs and jose for native auth"
```

---

## Task 2: Create the auth module skeleton (`lib/auth.js`)

**Files:**
- Create: `lib/auth.js`

This task creates the full module in one shot because the helpers cross-reference each other (e.g., `requireUserId` calls `getCurrentUserId` which calls `verifySession` and `getSessionCookie`). Splitting them creates broken intermediate states.

- [ ] **Step 1: Create `lib/auth.js`**

```js
import "server-only";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { db } from "@/lib/prisma";

const COOKIE_NAME = "session";
const SESSION_DAYS = 7;
const SESSION_MAX_AGE = 60 * 60 * 24 * SESSION_DAYS;

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_SECRET must be set and at least 32 characters. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  return new TextEncoder().encode(secret);
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export async function signSession(userId) {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(getSecret());
}

export async function verifySession(token) {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (typeof payload.userId !== "string") return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
}

export async function getSessionCookie() {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value ?? null;
}

export async function setSessionCookie(token) {
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function getCurrentUserId() {
  const token = await getSessionCookie();
  if (!token) return null;
  const session = await verifySession(token);
  return session?.userId ?? null;
}

export async function requireUserId() {
  const userId = await getCurrentUserId();
  if (!userId) throw new Error("Unauthorized");
  return userId;
}

export async function getCurrentUser() {
  const userId = await getCurrentUserId();
  if (!userId) return null;
  return db.user.findUnique({ where: { id: userId } });
}
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: No errors related to `lib/auth.js`. Pre-existing warnings elsewhere are fine.

- [ ] **Step 3: Commit**

```bash
git add lib/auth.js
git commit -m "feat(auth): add lib/auth.js with bcrypt + jose helpers"
```

---

## Task 3: Add Zod schemas (`app/lib/schema.js`)

**Files:**
- Modify: `app/lib/schema.js`

- [ ] **Step 1: Append sign-in/sign-up schemas**

Open `app/lib/schema.js` and add at the bottom of the file:

```js
export const signInSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
});

export const signUpSchema = z
  .object({
    email: z.string().email("Invalid email"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add app/lib/schema.js
git commit -m "feat(auth): add signIn/signUp zod schemas"
```

---

## Task 4: Create auth server actions (`actions/auth.js`)

**Files:**
- Create: `actions/auth.js`

- [ ] **Step 1: Create `actions/auth.js`**

```js
"use server";

import { db } from "@/lib/prisma";
import {
  hashPassword,
  verifyPassword,
  signSession,
  setSessionCookie,
  clearSessionCookie,
} from "@/lib/auth";

export async function signUp({ email, password }) {
  try {
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await db.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      return { success: false, error: "Email already registered" };
    }

    const passwordHash = await hashPassword(password);
    const user = await db.user.create({
      data: { email: normalizedEmail, password: passwordHash },
    });

    const token = await signSession(user.id);
    await setSessionCookie(token);
    return { success: true };
  } catch (error) {
    console.error("signUp error:", error);
    if (error?.code === "P2002") {
      return { success: false, error: "Email already registered" };
    }
    return { success: false, error: "Failed to create account" };
  }
}

export async function signIn({ email, password }) {
  try {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await db.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (!user) {
      return { success: false, error: "Invalid email or password" };
    }

    const ok = await verifyPassword(password, user.password);
    if (!ok) {
      return { success: false, error: "Invalid email or password" };
    }

    const token = await signSession(user.id);
    await setSessionCookie(token);
    return { success: true };
  } catch (error) {
    console.error("signIn error:", error);
    return { success: false, error: "Failed to sign in" };
  }
}

export async function signOut() {
  await clearSessionCookie();
  return { success: true };
}
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add actions/auth.js
git commit -m "feat(auth): add signUp/signIn/signOut server actions"
```

---

## Task 5: Create the new sign-in page

**Files:**
- Create: `app/(auth)/sign-in/page.jsx`

(The old `app/(auth)/sign-in/[[...sign-in]]/` directory is deleted in Task 14 after all Clerk references are gone, but the new page works alongside it because the catch-all only matches deeper paths.)

- [ ] **Step 1: Create `app/(auth)/sign-in/page.jsx`**

```jsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signInSchema } from "@/app/lib/schema";
import { signIn } from "@/actions/auth";

export default function SignInPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({ resolver: zodResolver(signInSchema) });

  useEffect(() => {
    setFormError(null);
  }, []);

  const onSubmit = async (values) => {
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await signIn(values);
      if (!result.success) {
        setFormError(result.error || "Failed to sign in");
        return;
      }
      toast.success("Welcome back");
      router.push("/dashboard");
      router.refresh();
    } catch (error) {
      setFormError(error.message || "Failed to sign in");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-md rounded-lg border bg-white p-8 shadow-sm">
      <h1 className="mb-6 text-2xl font-semibold">Sign in</h1>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Email</label>
          <Input type="email" autoComplete="email" {...register("email")} />
          {errors.email && (
            <p className="mt-1 text-sm text-red-600">{errors.email.message}</p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Password</label>
          <Input
            type="password"
            autoComplete="current-password"
            {...register("password")}
          />
          {errors.password && (
            <p className="mt-1 text-sm text-red-600">
              {errors.password.message}
            </p>
          )}
        </div>

        {formError && (
          <p className="text-sm text-red-600" role="alert">
            {formError}
          </p>
        )}

        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-gray-600">
        No account?{" "}
        <Link href="/sign-up" className="text-blue-600 hover:underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add app/\(auth\)/sign-in/page.jsx
git commit -m "feat(auth): add native sign-in page"
```

---

## Task 6: Create the new sign-up page

**Files:**
- Create: `app/(auth)/sign-up/page.jsx`

- [ ] **Step 1: Create `app/(auth)/sign-up/page.jsx`**

```jsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signUpSchema } from "@/app/lib/schema";
import { signUp } from "@/actions/auth";

export default function SignUpPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({ resolver: zodResolver(signUpSchema) });

  const onSubmit = async (values) => {
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await signUp({
        email: values.email,
        password: values.password,
      });
      if (!result.success) {
        setFormError(result.error || "Failed to create account");
        return;
      }
      toast.success("Account created");
      router.push("/dashboard");
      router.refresh();
    } catch (error) {
      setFormError(error.message || "Failed to create account");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-md rounded-lg border bg-white p-8 shadow-sm">
      <h1 className="mb-6 text-2xl font-semibold">Create your account</h1>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Email</label>
          <Input type="email" autoComplete="email" {...register("email")} />
          {errors.email && (
            <p className="mt-1 text-sm text-red-600">{errors.email.message}</p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Password</label>
          <Input
            type="password"
            autoComplete="new-password"
            {...register("password")}
          />
          {errors.password && (
            <p className="mt-1 text-sm text-red-600">
              {errors.password.message}
            </p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">
            Confirm password
          </label>
          <Input
            type="password"
            autoComplete="new-password"
            {...register("confirmPassword")}
          />
          {errors.confirmPassword && (
            <p className="mt-1 text-sm text-red-600">
              {errors.confirmPassword.message}
            </p>
          )}
        </div>

        {formError && (
          <p className="text-sm text-red-600" role="alert">
            {formError}
          </p>
        )}

        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? "Creating…" : "Create account"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-gray-600">
        Already have an account?{" "}
        <Link href="/sign-in" className="text-blue-600 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add app/\(auth\)/sign-up/page.jsx
git commit -m "feat(auth): add native sign-up page"
```

---

## Task 7: Replace middleware

**Files:**
- Modify: `middleware.js`

Replace Clerk with `jose#jwtVerify`. Keep ArcJet exactly as-is.

- [ ] **Step 1: Replace `middleware.js` contents**

```js
import arcjet, { createMiddleware, detectBot, shield } from "@arcjet/next";
import { NextResponse } from "next/server";
import { jwtVerify } from "jose";

const PROTECTED_RE = /^\/(dashboard|account|transaction)(\/|$)/;

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    shield({
      mode: process.env.NODE_ENV === "development" ? "DRY_RUN" : "LIVE",
    }),
    detectBot({
      mode: process.env.NODE_ENV === "development" ? "DRY_RUN" : "LIVE",
      allow: ["CATEGORY:SEARCH_ENGINE", "GO_HTTP"],
    }),
  ],
});

async function authMiddleware(req) {
  const { pathname } = req.nextUrl;
  if (!PROTECTED_RE.test(pathname)) return NextResponse.next();

  const token = req.cookies.get("session")?.value;
  if (!token) {
    return NextResponse.redirect(new URL("/sign-in", req.url));
  }

  try {
    await jwtVerify(
      token,
      new TextEncoder().encode(process.env.JWT_SECRET)
    );
    return NextResponse.next();
  } catch {
    const res = NextResponse.redirect(new URL("/sign-in", req.url));
    res.cookies.delete("session");
    return res;
  }
}

export default createMiddleware(aj, authMiddleware);

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: No errors in `middleware.js`. Other files may still import `@clerk/nextjs` — that's fine for now.

- [ ] **Step 3: Commit**

```bash
git add middleware.js
git commit -m "refactor(auth): replace Clerk middleware with jose JWT verify"
```

---

## Task 8: Drop ClerkProvider from root layout

**Files:**
- Modify: `app/layout.js`

- [ ] **Step 1: Replace `app/layout.js` contents**

```js
import { Inter } from "next/font/google";
import "./globals.css";
import Header from "@/components/header";
import { Toaster } from "sonner";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
  title: "Welth",
  description: "One stop shop Finance Platform",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/logo-sm.png" sizes="any" />
      </head>

      <body className={`${inter.className}`}>
        <Header />
        <main className="min-h-screen">{children}</main>
        <Toaster richColors />

        <footer className="bg-blue-50 py-12">
          <div className="container mx-auto px-4 text-center text-gray-600">
            <p>Made with 💗 by CogniTechX Finance</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: No errors in `app/layout.js`.

- [ ] **Step 3: Commit**

```bash
git add app/layout.js
git commit -m "refactor(auth): remove ClerkProvider from root layout"
```

---

## Task 9: Replace header with native auth UI

**Files:**
- Modify: `components/header.jsx`

The header becomes a server component that calls `getCurrentUser()` and renders either authenticated controls (with sign-out) or a Login link. Sign-out uses a `<form action={signOut}>` so it works without client JS.

- [ ] **Step 1: Replace `components/header.jsx` contents**

```jsx
import Link from "next/link";
import Image from "next/image";
import { PenBox, LayoutDashboard, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth";
import { signOut } from "@/actions/auth";

const Header = async () => {
  const user = await getCurrentUser();

  return (
    <header className="fixed top-0 w-full bg-white/80 backdrop-blur-md z-50 border-b">
      <nav className="container mx-auto px-4 py-4 flex items-center justify-between">
        <Link href="/">
          <Image
            src={"/logo.png"}
            alt="Welth Logo"
            width={200}
            height={60}
            className="h-12 w-auto object-contain"
          />
        </Link>

        <div className="hidden md:flex items-center space-x-8">
          {!user && (
            <>
              <a href="#features" className="text-gray-600 hover:text-blue-600">
                Features
              </a>
              <a
                href="#testimonials"
                className="text-gray-600 hover:text-blue-600"
              >
                Testimonials
              </a>
            </>
          )}
        </div>

        <div className="flex items-center space-x-4">
          {user ? (
            <>
              <Link
                href="/dashboard"
                className="text-gray-600 hover:text-blue-600 flex items-center gap-2"
              >
                <Button variant="outline">
                  <LayoutDashboard size={18} />
                  <span className="hidden md:inline">Dashboard</span>
                </Button>
              </Link>

              <Link
                href="/transaction/create"
                className="text-gray-600 hover:text-blue-600 flex items-center gap-2"
              >
                <Button className="flex items-center gap-2">
                  <PenBox size={18} />
                  <span className="hidden md:inline">Add Transaction</span>
                </Button>
              </Link>

              <span
                className="hidden md:inline text-sm text-gray-600"
                title={user.email}
              >
                {user.email}
              </span>

              <form action={signOut}>
                <Button type="submit" variant="outline">
                  <LogOut size={18} />
                  <span className="hidden md:inline">Sign out</span>
                </Button>
              </form>
            </>
          ) : (
            <Link href="/sign-in">
              <Button variant="outline">Login</Button>
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
};

export default Header;
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: No errors in `components/header.jsx`.

- [ ] **Step 3: Commit**

```bash
git add components/header.jsx
git commit -m "refactor(auth): rebuild header on getCurrentUser + signOut form"
```

---

## Task 10: Migrate `actions/account.js`

**Files:**
- Modify: `actions/account.js`

Three call-sites: `getAccountWithTransactions`, `bulkDeleteTransactions`, `updateDefaultAccount`. Each loses the `auth() → findUnique({clerkUserId})` pair and uses `requireUserId()` directly.

- [ ] **Step 1: Replace `actions/account.js` contents**

```js
"use server";

import { db } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";

const serializeDecimal = (obj) => {
  const serialized = { ...obj };
  if (obj.balance) {
    serialized.balance = obj.balance.toNumber();
  }
  if (obj.amount) {
    serialized.amount = obj.amount.toNumber();
  }
  return serialized;
};

export async function getAccountWithTransactions(accountId) {
  const userId = await requireUserId();

  const account = await db.account.findUnique({
    where: {
      id: accountId,
      userId,
    },
    include: {
      transactions: {
        orderBy: { date: "desc" },
      },
      _count: {
        select: { transactions: true },
      },
    },
  });

  if (!account) return null;

  return {
    ...serializeDecimal(account),
    transactions: account.transactions.map(serializeDecimal),
  };
}

export async function bulkDeleteTransactions(transactionIds) {
  try {
    const userId = await requireUserId();

    const transactions = await db.transaction.findMany({
      where: {
        id: { in: transactionIds },
        userId,
      },
    });

    const accountBalanceChanges = transactions.reduce((acc, transaction) => {
      const change =
        transaction.type === "EXPENSE"
          ? transaction.amount
          : -transaction.amount;
      acc[transaction.accountId] = (acc[transaction.accountId] || 0) + change;
      return acc;
    }, {});

    await db.$transaction(async (tx) => {
      await tx.transaction.deleteMany({
        where: {
          id: { in: transactionIds },
          userId,
        },
      });

      for (const [accountId, balanceChange] of Object.entries(
        accountBalanceChanges
      )) {
        await tx.account.update({
          where: { id: accountId },
          data: {
            balance: {
              increment: balanceChange,
            },
          },
        });
      }
    });

    revalidatePath("/dashboard");
    revalidatePath("/account/[id]");

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function updateDefaultAccount(accountId) {
  try {
    const userId = await requireUserId();

    await db.account.updateMany({
      where: {
        userId,
        isDefault: true,
      },
      data: { isDefault: false },
    });

    const account = await db.account.update({
      where: {
        id: accountId,
        userId,
      },
      data: { isDefault: true },
    });

    revalidatePath("/dashboard");
    return {
      success: true,
      data: { ...account, balance: account.balance.toNumber() },
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: No errors in `actions/account.js`.

- [ ] **Step 3: Commit**

```bash
git add actions/account.js
git commit -m "refactor(auth): migrate actions/account.js to requireUserId"
```

---

## Task 11: Migrate `actions/budget.js`

**Files:**
- Modify: `actions/budget.js`

Two call-sites: `getCurrentBudget`, `updateBudget`.

- [ ] **Step 1: Replace `actions/budget.js` contents**

```js
"use server";

import { db } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";

export async function getCurrentBudget(accountId) {
  try {
    const userId = await requireUserId();

    const budget = await db.budget.findFirst({
      where: { userId },
    });

    const currentDate = new Date();
    const startOfMonth = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth(),
      1
    );
    const endOfMonth = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth() + 1,
      0
    );

    const expenses = await db.transaction.aggregate({
      where: {
        userId,
        type: "EXPENSE",
        date: {
          gte: startOfMonth,
          lte: endOfMonth,
        },
        accountId,
      },
      _sum: {
        amount: true,
      },
    });

    return {
      budget: budget ? { ...budget, amount: budget.amount.toNumber() } : null,
      currentExpenses: expenses._sum.amount
        ? expenses._sum.amount.toNumber()
        : 0,
    };
  } catch (error) {
    console.error("Error fetching budget:", error);
    throw error;
  }
}

export async function updateBudget(amount) {
  try {
    const userId = await requireUserId();

    const budget = await db.budget.upsert({
      where: { userId },
      update: { amount },
      create: { userId, amount },
    });

    revalidatePath("/dashboard");
    return {
      success: true,
      data: { ...budget, amount: budget.amount.toNumber() },
    };
  } catch (error) {
    console.error("Error updating budget:", error);
    return { success: false, error: error.message };
  }
}
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: No errors in `actions/budget.js`.

- [ ] **Step 3: Commit**

```bash
git add actions/budget.js
git commit -m "refactor(auth): migrate actions/budget.js to requireUserId"
```

---

## Task 12: Migrate `actions/dashboard.js`

**Files:**
- Modify: `actions/dashboard.js`

Three call-sites: `getUserAccounts`, `createAccount`, `getDashboardData`. The ArcJet block in `createAccount` stays — `userId` is now the local UUID (still a stable per-user key, ArcJet doesn't care about format).

- [ ] **Step 1: Replace `actions/dashboard.js` contents**

```js
"use server";

import aj from "@/lib/arcjet";
import { db } from "@/lib/prisma";
import { request } from "@arcjet/next";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";

const serializeTransaction = (obj) => {
  const serialized = { ...obj };
  if (obj.balance) {
    serialized.balance = obj.balance.toNumber();
  }
  if (obj.amount) {
    serialized.amount = obj.amount.toNumber();
  }
  return serialized;
};

export async function getUserAccounts() {
  const userId = await requireUserId();

  try {
    const accounts = await db.account.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            transactions: true,
          },
        },
      },
    });

    return accounts.map(serializeTransaction);
  } catch (error) {
    console.error(error.message);
  }
}

export async function createAccount(data) {
  try {
    const userId = await requireUserId();

    const req = await request();

    const decision = await aj.protect(req, {
      userId,
      requested: 1,
    });

    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
        const { remaining, reset } = decision.reason;
        console.error({
          code: "RATE_LIMIT_EXCEEDED",
          details: {
            remaining,
            resetInSeconds: reset,
          },
        });
        throw new Error("Too many requests. Please try again later.");
      }
      throw new Error("Request blocked");
    }

    const balanceFloat = parseFloat(data.balance);
    if (isNaN(balanceFloat)) {
      throw new Error("Invalid balance amount");
    }

    const existingAccounts = await db.account.findMany({
      where: { userId },
    });

    const shouldBeDefault =
      existingAccounts.length === 0 ? true : data.isDefault;

    if (shouldBeDefault) {
      await db.account.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const account = await db.account.create({
      data: {
        ...data,
        balance: balanceFloat,
        userId,
        isDefault: shouldBeDefault,
      },
    });

    const serializedAccount = serializeTransaction(account);

    revalidatePath("/dashboard");
    return { success: true, data: serializedAccount };
  } catch (error) {
    throw new Error(error.message);
  }
}

export async function getDashboardData() {
  const userId = await requireUserId();

  const transactions = await db.transaction.findMany({
    where: { userId },
    orderBy: { date: "desc" },
  });

  return transactions.map(serializeTransaction);
}
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: No errors in `actions/dashboard.js`.

- [ ] **Step 3: Commit**

```bash
git add actions/dashboard.js
git commit -m "refactor(auth): migrate actions/dashboard.js to requireUserId"
```

---

## Task 13: Migrate `actions/transaction.js`

**Files:**
- Modify: `actions/transaction.js`

Four call-sites: `createTransaction`, `getTransaction`, `updateTransaction`, `getUserTransactions`. `scanReceipt` does not call `auth()` — leave it untouched.

- [ ] **Step 1: Replace `actions/transaction.js` contents**

```js
"use server";

import { db } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { GoogleGenerativeAI } from "@google/generative-ai";
import aj from "@/lib/arcjet";
import { request } from "@arcjet/next";
import { requireUserId } from "@/lib/auth";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const serializeAmount = (obj) => ({
  ...obj,
  amount: obj.amount.toNumber(),
});

export async function createTransaction(data) {
  try {
    const userId = await requireUserId();

    const req = await request();

    const decision = await aj.protect(req, {
      userId,
      requested: 1,
    });

    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
        const { remaining, reset } = decision.reason;
        console.error({
          code: "RATE_LIMIT_EXCEEDED",
          details: {
            remaining,
            resetInSeconds: reset,
          },
        });
        throw new Error("Too many requests. Please try again later.");
      }
      throw new Error("Request blocked");
    }

    const account = await db.account.findUnique({
      where: {
        id: data.accountId,
        userId,
      },
    });

    if (!account) {
      throw new Error("Account not found");
    }

    const balanceChange = data.type === "EXPENSE" ? -data.amount : data.amount;
    const newBalance = account.balance.toNumber() + balanceChange;

    const transaction = await db.$transaction(async (tx) => {
      const newTransaction = await tx.transaction.create({
        data: {
          ...data,
          userId,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(data.date, data.recurringInterval)
              : null,
        },
      });

      await tx.account.update({
        where: { id: data.accountId },
        data: { balance: newBalance },
      });

      return newTransaction;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${transaction.accountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    throw new Error(error.message);
  }
}

export async function getTransaction(id) {
  const userId = await requireUserId();

  const transaction = await db.transaction.findUnique({
    where: { id, userId },
  });

  if (!transaction) throw new Error("Transaction not found");

  return serializeAmount(transaction);
}

export async function updateTransaction(id, data) {
  try {
    const userId = await requireUserId();

    const originalTransaction = await db.transaction.findUnique({
      where: { id, userId },
      include: { account: true },
    });

    if (!originalTransaction) throw new Error("Transaction not found");

    const oldBalanceChange =
      originalTransaction.type === "EXPENSE"
        ? -originalTransaction.amount.toNumber()
        : originalTransaction.amount.toNumber();

    const newBalanceChange =
      data.type === "EXPENSE" ? -data.amount : data.amount;

    const netBalanceChange = newBalanceChange - oldBalanceChange;

    const transaction = await db.$transaction(async (tx) => {
      const updated = await tx.transaction.update({
        where: { id, userId },
        data: {
          ...data,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(data.date, data.recurringInterval)
              : null,
        },
      });

      await tx.account.update({
        where: { id: data.accountId },
        data: {
          balance: {
            increment: netBalanceChange,
          },
        },
      });

      return updated;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${data.accountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    throw new Error(error.message);
  }
}

export async function getUserTransactions(query = {}) {
  try {
    const userId = await requireUserId();

    const transactions = await db.transaction.findMany({
      where: {
        userId,
        ...query,
      },
      include: {
        account: true,
      },
      orderBy: {
        date: "desc",
      },
    });

    return { success: true, data: transactions };
  } catch (error) {
    throw new Error(error.message);
  }
}

export async function scanReceipt(file) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const arrayBuffer = await file.arrayBuffer();
    const base64String = Buffer.from(arrayBuffer).toString("base64");

    const prompt = `
      Analyze this receipt image and extract the following information in JSON format:
      - Total amount (just the number)
      - Date (in ISO format)
      - Description or items purchased (brief summary)
      - Merchant/store name
      - Suggested category (one of: housing,transportation,groceries,utilities,entertainment,food,shopping,healthcare,education,personal,travel,insurance,gifts,bills,other-expense )
      
      Only respond with valid JSON in this exact format:
      {
        "amount": number,
        "date": "ISO date string",
        "description": "string",
        "merchantName": "string",
        "category": "string"
      }

      If its not a recipt, return an empty object
    `;

    const result = await model.generateContent([
      {
        inlineData: {
          data: base64String,
          mimeType: file.type,
        },
      },
      prompt,
    ]);

    const response = await result.response;
    const text = response.text();
    const cleanedText = text.replace(/```(?:json)?\n?/g, "").trim();

    try {
      const data = JSON.parse(cleanedText);
      return {
        amount: parseFloat(data.amount),
        date: new Date(data.date),
        description: data.description,
        category: data.category,
        merchantName: data.merchantName,
      };
    } catch (parseError) {
      console.error("Error parsing JSON response:", parseError);
      throw new Error("Invalid response format from Gemini");
    }
  } catch (error) {
    console.error("Error scanning receipt:", error);
    throw new Error("Failed to scan receipt");
  }
}

function calculateNextRecurringDate(startDate, interval) {
  const date = new Date(startDate);

  switch (interval) {
    case "DAILY":
      date.setDate(date.getDate() + 1);
      break;
    case "WEEKLY":
      date.setDate(date.getDate() + 7);
      break;
    case "MONTHLY":
      date.setMonth(date.getMonth() + 1);
      break;
    case "YEARLY":
      date.setFullYear(date.getFullYear() + 1);
      break;
  }

  return date;
}
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: No errors in `actions/transaction.js`.

- [ ] **Step 3: Commit**

```bash
git add actions/transaction.js
git commit -m "refactor(auth): migrate actions/transaction.js to requireUserId"
```

---

## Task 14: Delete Clerk artifacts

**Files:**
- Delete: `lib/checkUser.js`
- Delete: `app/(auth)/sign-in/[[...sign-in]]/` (whole directory)
- Delete: `app/(auth)/sign-up/[[...sign-up]]/` (whole directory)

After this task, no source file references `@clerk/nextjs`.

- [ ] **Step 1: Verify nothing else references checkUser or clerk**

Run: `grep -r "checkUser\|@clerk/nextjs" --include="*.js" --include="*.jsx" --exclude-dir=node_modules --exclude-dir=.next .`
Expected: No matches under repo source. (Matches inside `package-lock.json` are fine — that gets fixed in Task 16.)

- [ ] **Step 2: Delete files and dirs**

```bash
rm lib/checkUser.js
rm -rf "app/(auth)/sign-in/[[...sign-in]]"
rm -rf "app/(auth)/sign-up/[[...sign-up]]"
```

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add -A lib app/\(auth\)
git commit -m "refactor(auth): remove Clerk pages and checkUser helper"
```

---

## Task 15: Update Prisma schema and run migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_remove_clerk_add_password/migration.sql` (auto-generated)

The DB is fresh per the spec — `prisma migrate dev` will drop `clerkUserId` and add `password` directly.

- [ ] **Step 1: Update the User model in `prisma/schema.prisma`**

Replace the `User` model with:

```prisma
model User {
  id           String        @id @default(uuid())
  email        String        @unique
  password     String
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

- [ ] **Step 2: Verify `JWT_SECRET` exists in `.env`**

Open `.env` and confirm `JWT_SECRET=...` is present (≥32 chars). If missing, generate one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Add the result to `.env` as `JWT_SECRET=<paste>`.

- [ ] **Step 3: Run migration**

Run: `npx prisma migrate dev --name remove_clerk_add_password`
Expected: Migration created under `prisma/migrations/` and applied. Output ends with "Your database is now in sync with your schema."

If Prisma complains about `DIRECT_URL` not being set, add it to `.env` (Neon's non-pooled connection string) — it's referenced by `directUrl = env("DIRECT_URL")` in `schema.prisma`.

- [ ] **Step 4: Regenerate Prisma client**

Run: `npx prisma generate`
Expected: Client regenerated. No errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(db): replace clerkUserId with password on users table"
```

---

## Task 16: Uninstall `@clerk/nextjs`

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Uninstall Clerk**

Run: `npm uninstall @clerk/nextjs`
Expected: `@clerk/nextjs` removed from `dependencies`. `package-lock.json` updated.

- [ ] **Step 2: Verify no source imports remain**

Run: `grep -rn "@clerk" --include="*.js" --include="*.jsx" --exclude-dir=node_modules --exclude-dir=.next .`
Expected: No matches in source files. Matches inside `package-lock.json` should also be gone now.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: remove @clerk/nextjs dependency"
```

---

## Task 17: Update README.md and CLAUDE.md

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the env block in `README.md`**

Replace the entire `.env` example block with:

```
DATABASE_URL=
DIRECT_URL=

# Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
JWT_SECRET=

GEMINI_API_KEY=

RESEND_API_KEY=

ARCJET_KEY=
```

- [ ] **Step 2: Update `CLAUDE.md`**

In `CLAUDE.md`:

1. Replace the **Required environment** section with:

```markdown
## Required environment

Copy from README.md into `.env`:
`DATABASE_URL`, `DIRECT_URL` (Postgres + Prisma direct URL — Prisma uses `directUrl` for migrations), `JWT_SECRET` (≥32 chars; generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`), `GEMINI_API_KEY`, `RESEND_API_KEY`, `ARCJET_KEY`.
```

2. Replace the **Middleware chain** paragraph (under Architecture) with:

```markdown
### Middleware chain (`middleware.js`)
Requests pass through `createMiddleware(aj, authMiddleware)` — **ArcJet first, JWT auth second**. ArcJet runs `shield` + `detectBot` (DRY_RUN in dev, LIVE in prod; `GO_HTTP` is allowed so Inngest cron callbacks aren't blocked). The auth step verifies a `session` JWT cookie via `jose#jwtVerify` (Edge-compatible) and redirects to `/sign-in` on missing/invalid token. The protected-path regex covers `/dashboard`, `/account`, `/transaction` and their subpaths. Adding a new protected top-level route requires updating that regex here.
```

3. Replace the **Auth → DB user sync** section with:

```markdown
### Auth (`lib/auth.js`)
The repo uses email/password auth with a JWT in an httpOnly `session` cookie (7-day expiry). `lib/auth.js` exposes the entire surface: `hashPassword`/`verifyPassword` (bcryptjs), `signSession`/`verifySession` (jose HS256), cookie helpers (`get/set/clearSessionCookie`), and the gates `getCurrentUserId`, `requireUserId`, `getCurrentUser`. The JWT payload carries the local `User.id`, so server actions read `userId` directly from `requireUserId()` — no second `findUnique` lookup is needed unless an action needs additional user fields.
```

4. Update the **Server actions** numbered list — replace step 1 and 3 to read:

```markdown
1. `requireUserId()` from `@/lib/auth`; throws `Unauthorized` if no valid session.
2. For mutating actions, call ArcJet's `aj.protect(req, { userId, requested: 1 })` (rate-limit token bucket from `lib/arcjet.js`: 10/hour per userId).
3. Use `userId` directly in queries (it is the local `User.id`). Only call `db.user.findUnique({ where: { id: userId } })` if you need fields beyond the id.
```

(Step 4 about `db.$transaction` and step 5 about `revalidatePath` stay as-is.)

- [ ] **Step 3: Lint and verify build**

Run: `npm run lint && npm run build`
Expected: Lint passes. Build completes — confirms all imports resolve, schema/Prisma client are in sync, no dangling Clerk references.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: update README/CLAUDE.md for native auth"
```

---

## Task 18: Manual smoke test

This is the verification gate — the spec calls out 8 manual checks. Run all of them. The dev server must already be running.

- [ ] **Step 1: Start dev server**

Run: `npm run dev`
Expected: Server starts on `http://localhost:3000`. No startup errors.

- [ ] **Step 2: Run through the spec's manual test plan**

Verify each item works end-to-end:

1. Visit `/` — header renders a Login button (not signed in).
2. Click Login → `/sign-in`. Click "Sign up" link → `/sign-up`. Register a new user with a valid email and a password ≥8 chars. Expect redirect to `/dashboard`.
3. Hard-refresh `/dashboard` — still authenticated (session cookie persists).
4. Click Sign out in the header — redirects, header now shows Login.
5. Visit `/sign-in`. Sign in with the same credentials — back at `/dashboard`.
6. Sign out, then manually navigate to `/dashboard` in the URL bar. Middleware should redirect to `/sign-in`.
7. Sign back in. Create an account (use the existing UI). Create a transaction. Delete the transaction. The account balance should adjust correctly each time. (This is the regression check on the userId migration.)
8. Sign out, then `/sign-in` with the right email but wrong password — generic `"Invalid email or password"` error appears, no enumeration of which field was wrong.

- [ ] **Step 3: Stop dev server**

Stop `npm run dev` when all 8 checks pass.

- [ ] **Step 4: Final commit (if any docs/notes were touched during smoke testing)**

```bash
git status
# If clean, no commit needed.
# If anything was tweaked, commit it as fix(auth): ...
```

---

## Self-review notes

Cross-checked against the spec's "Files to edit" / "Files to create" / "Files to delete" lists — every item maps to a task:

| Spec item | Task |
|---|---|
| `prisma/schema.prisma` | 15 |
| `app/lib/schema.js` | 3 |
| `app/layout.js` | 8 |
| `components/header.jsx` | 9 |
| `middleware.js` | 7 |
| `actions/account.js` | 10 |
| `actions/budget.js` | 11 |
| `actions/dashboard.js` | 12 |
| `actions/transaction.js` | 13 |
| `README.md` | 17 |
| `CLAUDE.md` | 17 |
| Create `lib/auth.js` | 2 |
| Create `actions/auth.js` | 4 |
| Create `app/(auth)/sign-in/page.jsx` | 5 |
| Create `app/(auth)/sign-up/page.jsx` | 6 |
| Delete `lib/checkUser.js` | 14 |
| Delete `app/(auth)/sign-in/[[...sign-in]]/` | 14 |
| Delete `app/(auth)/sign-up/[[...sign-up]]/` | 14 |
| Add `bcryptjs`, `jose` | 1 |
| Remove `@clerk/nextjs` | 16 |
| Manual test plan | 18 |

Property/method-name consistency check: `requireUserId`, `getCurrentUser`, `getCurrentUserId`, `signSession`, `verifySession`, `hashPassword`, `verifyPassword`, `signUp`, `signIn`, `signOut`, `signInSchema`, `signUpSchema` — all spelled the same wherever they appear. Cookie name is `"session"` in middleware, `lib/auth.js#COOKIE_NAME`, and the redirect-cleanup branch.
