import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { HttpError, parse } from "../lib/http.js";
import { authenticate, signToken } from "../middleware/auth.js";

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

export function authRoutes({ pool, config }) {
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
      if (e.code === "23505") throw new HttpError(409, "An account with this email already exists. Sign in instead.");
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

  r.get("/me", authenticate(config), async (req, res) => {
    const { rows: [u] } = await pool.query("SELECT id, email, name FROM users WHERE id = $1", [req.user.id]);
    if (!u) throw new HttpError(401, "Your account no longer exists.");
    res.json({ user: publicUser(u) });
  });

  return r;
}
