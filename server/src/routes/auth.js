import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { HttpError, parse } from "../lib/http.js";
import jwt from "jsonwebtoken";
import { authenticate, signToken } from "../middleware/auth.js";
import { tx } from "../db.js";
import { PROVIDERS, enabledProviders, authorizeUrl, exchangeCode, pkcePair, randomToken, sha256 } from "../services/oauth.js";

const Register = z.object({
  name: z.string().trim().min(1, "Enter your name").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(200),
  password: z.string().min(8, "Use at least 8 characters").max(200),
});
const Login = z.object({
  email: z.string().trim().toLowerCase().max(200),
  password: z.string().max(200),
});

const publicUser = u => ({ id: u.id, name: u.name, email: u.email });

const COOKIE = "litview_oauth";
const readCookie = (req, name) => (req.headers.cookie || "").split(/;\s*/).map(c => c.split("=")).find(([k]) => k === name)?.[1];

/** Find the Litview user for a provider account, linking by verified email or creating a new user. */
async function userForProfile(pool, provider, profile) {
  return tx(pool, async c => {
    const { rows: [linked] } = await c.query(
      "SELECT u.id, u.name, u.email FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = $1 AND i.provider_user_id = $2",
      [provider, String(profile.id)]);
    if (linked) return linked;
    const email = profile.emailVerified && profile.email ? profile.email.trim().toLowerCase() : null;
    let user = email && (await c.query("SELECT id, name, email FROM users WHERE lower(email) = $1", [email])).rows[0];
    if (!user) {
      user = (await c.query("INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id, name, email",
        [email, (profile.name || `${PROVIDERS[provider].name} user`).slice(0, 80)])).rows[0];
    }
    await c.query("INSERT INTO user_identities (provider, provider_user_id, user_id, email) VALUES ($1, $2, $3, $4)",
      [provider, String(profile.id), user.id, email]);
    return user;
  });
}

export function authRoutes({ pool, config, fetch = globalThis.fetch }) {
  const r = Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "Too many attempts. Wait a few minutes and try again." } });

  r.post("/register", limiter, async (req, res) => {
    const b = parse(Register, req.body);
    const hash = await bcrypt.hash(b.password, 11);
    try {
      const { rows: [u] } = await pool.query(
        "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name", [b.email, b.name, hash]);
      res.status(201).json({ token: signToken(config, u), user: publicUser(u) });
    } catch (e) {
      if (e.code === "23505") {
        const { rows: [ids] } = await pool.query(
          "SELECT array_agg(i.provider) AS p FROM users u JOIN user_identities i ON i.user_id = u.id WHERE lower(u.email) = $1 AND u.password_hash IS NULL", [b.email]);
        if (ids?.p?.length) throw new HttpError(409, `This email signs in with ${ids.p.map(p => PROVIDERS[p].name).join(" or ")}. Use that button instead.`);
        throw new HttpError(409, "An account with this email already exists. Sign in instead.");
      }
      throw e;
    }
  });

  r.post("/login", limiter, async (req, res) => {
    const b = parse(Login, req.body);
    const { rows: [u] } = await pool.query("SELECT * FROM users WHERE lower(email) = $1", [b.email]);
    // Compare against a dummy hash when the user doesn't exist so timing doesn't reveal which emails are registered.
    const ok = await bcrypt.compare(b.password, u?.password_hash || "$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
    if (!u || !ok) throw new HttpError(401, "That email and password don't match.");
    res.json({ token: signToken(config, u), user: publicUser(u) });
  });

  /* ---------- sign in with Google, Facebook, X or LinkedIn ---------- */

  // Where the provider may send people back to: a page on one of the allowed front-end origins.
  const safeReturn = raw => {
    try {
      const u = new URL(raw);
      if (!["https:", "http:"].includes(u.protocol)) return null;
      if (!config.allowedOrigins.includes(u.origin) && !config.allowedOrigins.includes("*")) return null;
      u.hash = "";
      return u.toString();
    } catch { return null; }
  };
  const back = (res, ret, params) => res.redirect(302, `${ret}#${new URLSearchParams(params)}`);

  r.get("/oauth/:provider/start", limiter, (req, res) => {
    const provider = req.params.provider;
    if (!enabledProviders(config).includes(provider)) throw new HttpError(404, "That sign-in option isn't set up on this server.");
    const ret = safeReturn(String(req.query.return || ""));
    if (!ret) throw new HttpError(400, "Invalid return address.");
    const state = randomToken(24), { verifier, challenge } = pkcePair();
    // The state, PKCE verifier and return address travel in a signed, short-lived cookie.
    const cookie = jwt.sign({ p: provider, s: state, v: verifier, r: ret }, config.jwtSecret, { expiresIn: "10m" });
    res.setHeader("Set-Cookie", `${COOKIE}=${cookie}; Path=/api/auth/oauth; Max-Age=600; HttpOnly; SameSite=Lax${config.production ? "; Secure" : ""}`);
    res.redirect(302, authorizeUrl(config, provider, { state, challenge }));
  });

  r.get("/oauth/:provider/callback", async (req, res) => {
    const provider = req.params.provider;
    let flow;
    try { flow = jwt.verify(readCookie(req, COOKIE) || "", config.jwtSecret); } catch { /* handled below */ }
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/api/auth/oauth; Max-Age=0; HttpOnly; SameSite=Lax${config.production ? "; Secure" : ""}`);
    if (!flow || flow.p !== provider || flow.s !== req.query.state) {
      if (flow?.r) return back(res, flow.r, { error: "The sign-in expired or was started in another window. Try again." });
      throw new HttpError(400, "The sign-in expired or was started in another window. Go back to Litview and try again.");
    }
    if (req.query.error || !req.query.code) return back(res, flow.r, { error: `${PROVIDERS[provider].name} sign-in was cancelled.` });
    try {
      const profile = await exchangeCode(config, provider, String(req.query.code), flow.v, fetch);
      const user = await userForProfile(pool, provider, profile);
      const code = randomToken(32);
      await pool.query("DELETE FROM login_codes WHERE expires_at < now()");
      await pool.query("INSERT INTO login_codes (code_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '2 minutes')", [sha256(code), user.id]);
      back(res, flow.r, { code });
    } catch (e) {
      back(res, flow.r, { error: e instanceof HttpError ? e.message : "Sign-in failed. Try again." });
    }
  });

  // The front end swaps the one-time code for a session token.
  r.post("/oauth/exchange", limiter, async (req, res) => {
    const { code } = parse(z.object({ code: z.string().min(20).max(200) }), req.body);
    const { rows: [row] } = await pool.query("DELETE FROM login_codes WHERE code_hash = $1 RETURNING user_id, expires_at", [sha256(code)]);
    if (!row || new Date(row.expires_at) < new Date()) throw new HttpError(400, "That sign-in link has expired. Sign in again.");
    const { rows: [u] } = await pool.query("SELECT id, email, name FROM users WHERE id = $1", [row.user_id]);
    res.json({ token: signToken(config, u), user: publicUser(u) });
  });

  r.get("/me", authenticate(config), async (req, res) => {
    const { rows: [u] } = await pool.query("SELECT id, email, name FROM users WHERE id = $1", [req.user.id]);
    if (!u) throw new HttpError(401, "Your account no longer exists.");
    res.json({ user: publicUser(u) });
  });

  return r;
}
