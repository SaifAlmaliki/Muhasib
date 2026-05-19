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
