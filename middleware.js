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
