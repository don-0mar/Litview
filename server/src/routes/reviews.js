import { Router } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { HttpError, parse, recordKey, normTitle } from "../lib/http.js";
import { authenticate } from "../middleware/auth.js";
import { tx } from "../db.js";
import { finalStatuses, agreement } from "../services/screening.js";
import { synthesise } from "../services/ai.js";

/* ---------- validation ---------- */

const Record = z.object({
  title: z.string().max(2000),
  year: z.number().int().nullable().optional(),
  doi: z.string().max(300).optional().default(""),
  authors: z.array(z.string().max(300)).max(200).default([]),
  venue: z.string().max(500).optional().default(""),
  cites: z.number().optional().default(0),
  noCites: z.boolean().optional(),
  oa: z.boolean().optional().default(false),
  oaKnown: z.boolean().optional(),
  abstract: z.string().max(20000).optional().default(""),
  type: z.string().max(60).optional().default(""),
  url: z.string().max(2000).optional().default(""),
  lang: z.string().max(40).nullable().optional(),
  source: z.string().max(40),
  sample: z.boolean().optional(),
}).passthrough();

const Source = z.object({
  items: z.array(Record).max(2000),
  total: z.number().int().nullable().optional(),
  url: z.string().max(4000).nullable().optional(),
  imported: z.boolean().default(false),
});

const SOURCE_NAME = z.string().regex(/^[a-z0-9_-]{1,40}$/, "Invalid source name");
const Opts = z.record(z.string(), z.unknown()).refine(o => JSON.stringify(o).length < 20000, "Options are too large");

const CreateReview = z.object({
  title: z.string().trim().min(1).max(300),
  topic: z.string().trim().min(1).max(1000),
  opts: Opts.default({}),
  sources: z.record(SOURCE_NAME, Source).default({}),
});
const UpdateReview = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  topic: z.string().trim().min(1).max(1000).optional(),
  opts: Opts.optional(),
});
const Decision = z.object({
  key: z.string().min(1).max(600),
  status: z.enum(["included", "excluded"]),
  reason: z.string().max(200).nullable().optional(),
});
const Decisions = z.object({ decisions: z.array(Decision).min(1).max(2000) });
const Synthesis = z.object({ keys: z.array(z.string().max(600)).min(1).max(2000), rqs: z.array(z.string().max(500)).max(20).default([]) });

/* ---------- helpers ---------- */

const newInviteCode = () => crypto.randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8).toUpperCase();

async function membership(pool, reviewId, userId) {
  if (!z.string().uuid().safeParse(reviewId).success) throw new HttpError(404, "Review not found.");
  const { rows: [m] } = await pool.query("SELECT role FROM review_members WHERE review_id = $1 AND user_id = $2", [reviewId, userId]);
  if (!m) throw new HttpError(404, "Review not found.");
  return m.role;
}
async function requireOwner(pool, reviewId, userId) {
  const role = await membership(pool, reviewId, userId);
  if (role !== "owner") throw new HttpError(403, "Only the review's owner can do this.");
}

/** The screening state a reviewer is allowed to see. Other reviewers' individual decisions are only
 *  revealed for records in conflict, so screening stays blind. */
async function screeningState(pool, reviewId, userId) {
  const [{ rows: members }, { rows: decisions }, { rows: resolutions }] = await Promise.all([
    pool.query(`SELECT m.user_id, m.role, u.name, m.joined_at FROM review_members m JOIN users u ON u.id = m.user_id
                WHERE m.review_id = $1 ORDER BY (m.role = 'owner') DESC, m.joined_at`, [reviewId]),
    pool.query("SELECT record_key, user_id, status, reason, updated_at FROM decisions WHERE review_id = $1", [reviewId]),
    pool.query("SELECT record_key, status, reason, resolved_by FROM resolutions WHERE review_id = $1", [reviewId]),
  ]);
  const final = finalStatuses(decisions, resolutions);
  const conflicts = [...final.entries()].filter(([, v]) => v.state === "conflict").map(([key]) => ({
    key, decisions: decisions.filter(d => d.record_key === key).map(d => ({ userId: d.user_id, status: d.status, reason: d.reason })),
  }));
  const counts = Object.fromEntries(members.map(m => [m.user_id, decisions.filter(d => d.user_id === m.user_id).length]));
  return {
    members: members.map(m => ({ id: m.user_id, name: m.name, role: m.role, decisions: counts[m.user_id] })),
    mine: Object.fromEntries(decisions.filter(d => d.user_id === userId).map(d => [d.record_key, { status: d.status, reason: d.reason }])),
    final: Object.fromEntries(final),
    conflicts,
    agreement: agreement(decisions, members),
  };
}

/** Build key -> record from all stored sources, keeping the version with an abstract. */
function recordIndex(sources) {
  const idx = new Map();
  for (const s of sources) for (const r of s.items) {
    for (const k of new Set([recordKey(r), "t:" + normTitle(r.title)])) {
      const prev = idx.get(k);
      if (!prev || (!prev.abstract && r.abstract)) idx.set(k, r);
    }
  }
  return idx;
}

/* ---------- routes ---------- */

export function reviewRoutes({ pool, config, fetch, log }) {
  const r = Router();
  r.use(authenticate(config));

  r.get("/", async (req, res) => {
    const { rows } = await pool.query(`
      SELECT rv.id, rv.title, rv.topic, rv.updated_at, rv.created_at, m.role,
             (SELECT count(*)::int FROM review_members x WHERE x.review_id = rv.id) AS member_count,
             (SELECT coalesce(sum(jsonb_array_length(s.items)), 0)::int FROM review_sources s WHERE s.review_id = rv.id) AS record_count,
             (SELECT count(*)::int FROM decisions d WHERE d.review_id = rv.id AND d.user_id = $1) AS my_decisions
      FROM reviews rv JOIN review_members m ON m.review_id = rv.id AND m.user_id = $1
      ORDER BY rv.updated_at DESC`, [req.user.id]);
    res.json({ reviews: rows.map(x => ({ id: x.id, title: x.title, topic: x.topic, role: x.role, updatedAt: x.updated_at,
      createdAt: x.created_at, members: x.member_count, records: x.record_count, myDecisions: x.my_decisions })) });
  });

  r.post("/", async (req, res) => {
    const b = parse(CreateReview, req.body);
    const id = await tx(pool, async c => {
      const { rows: [rv] } = await c.query("INSERT INTO reviews (owner_id, title, topic, opts) VALUES ($1, $2, $3, $4) RETURNING id",
        [req.user.id, b.title, b.topic, b.opts]);
      await c.query("INSERT INTO review_members (review_id, user_id, role) VALUES ($1, $2, 'owner')", [rv.id, req.user.id]);
      for (const [name, s] of Object.entries(b.sources)) {
        await c.query("INSERT INTO review_sources (review_id, source, items, total, query_url, imported, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [rv.id, name, JSON.stringify(s.items), s.total ?? s.items.length, s.url ?? null, s.imported, req.user.id]);
      }
      return rv.id;
    });
    res.status(201).json({ id });
  });

  r.post("/join", async (req, res) => {
    const { code } = parse(z.object({ code: z.string().trim().toUpperCase().min(4).max(20) }), req.body);
    const { rows: [rv] } = await pool.query("SELECT id, title FROM reviews WHERE invite_code = $1", [code]);
    if (!rv) throw new HttpError(404, "No review uses that invite code. Check it with the review's owner.");
    await pool.query("INSERT INTO review_members (review_id, user_id, role) VALUES ($1, $2, 'reviewer') ON CONFLICT DO NOTHING", [rv.id, req.user.id]);
    res.json({ id: rv.id, title: rv.title });
  });

  r.get("/:id", async (req, res) => {
    const role = await membership(pool, req.params.id, req.user.id);
    const [{ rows: [rv] }, { rows: sources }] = await Promise.all([
      pool.query("SELECT id, title, topic, opts, invite_code, synthesis, created_at, updated_at, owner_id FROM reviews WHERE id = $1", [req.params.id]),
      pool.query("SELECT source, items, total, query_url, imported, updated_at FROM review_sources WHERE review_id = $1 ORDER BY source", [req.params.id]),
    ]);
    res.json({
      review: { id: rv.id, title: rv.title, topic: rv.topic, opts: rv.opts, createdAt: rv.created_at, updatedAt: rv.updated_at,
        inviteCode: role === "owner" ? rv.invite_code : undefined, synthesis: rv.synthesis },
      role,
      sources: Object.fromEntries(sources.map(s => [s.source, { items: s.items, total: s.total, url: s.query_url, imported: s.imported, updatedAt: s.updated_at }])),
      screening: await screeningState(pool, req.params.id, req.user.id),
    });
  });

  r.patch("/:id", async (req, res) => {
    await requireOwner(pool, req.params.id, req.user.id);
    const b = parse(UpdateReview, req.body);
    await pool.query(`UPDATE reviews SET title = coalesce($2, title), topic = coalesce($3, topic), opts = coalesce($4, opts), updated_at = now() WHERE id = $1`,
      [req.params.id, b.title ?? null, b.topic ?? null, b.opts ?? null]);
    res.json({ ok: true });
  });

  r.delete("/:id", async (req, res) => {
    await requireOwner(pool, req.params.id, req.user.id);
    await pool.query("DELETE FROM reviews WHERE id = $1", [req.params.id]);
    res.status(204).end();
  });

  r.put("/:id/sources/:source", async (req, res) => {
    await membership(pool, req.params.id, req.user.id);
    const name = parse(SOURCE_NAME, req.params.source);
    const s = parse(Source, req.body);
    await pool.query(`INSERT INTO review_sources (review_id, source, items, total, query_url, imported, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (review_id, source) DO UPDATE SET items = excluded.items, total = excluded.total, query_url = excluded.query_url,
      imported = excluded.imported, added_by = excluded.added_by, updated_at = now()`,
      [req.params.id, name, JSON.stringify(s.items), s.total ?? s.items.length, s.url ?? null, s.imported, req.user.id]);
    await pool.query("UPDATE reviews SET updated_at = now() WHERE id = $1", [req.params.id]);
    res.json({ ok: true, count: s.items.length });
  });

  r.delete("/:id/sources/:source", async (req, res) => {
    await membership(pool, req.params.id, req.user.id);
    await pool.query("DELETE FROM review_sources WHERE review_id = $1 AND source = $2", [req.params.id, req.params.source]);
    res.status(204).end();
  });

  r.get("/:id/screening", async (req, res) => {
    await membership(pool, req.params.id, req.user.id);
    res.json(await screeningState(pool, req.params.id, req.user.id));
  });

  r.put("/:id/decisions", async (req, res) => {
    await membership(pool, req.params.id, req.user.id);
    const { decisions } = parse(Decisions, req.body);
    await tx(pool, async c => {
      for (const d of decisions) {
        await c.query(`INSERT INTO decisions (review_id, record_key, user_id, status, reason) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (review_id, record_key, user_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, updated_at = now()`,
          [req.params.id, d.key, req.user.id, d.status, d.status === "excluded" ? d.reason ?? null : null]);
      }
      await c.query("UPDATE reviews SET updated_at = now() WHERE id = $1", [req.params.id]);
    });
    res.json(await screeningState(pool, req.params.id, req.user.id));
  });

  r.put("/:id/resolutions", async (req, res) => {
    await requireOwner(pool, req.params.id, req.user.id);
    const d = parse(Decision, req.body);
    await pool.query(`INSERT INTO resolutions (review_id, record_key, status, reason, resolved_by) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (review_id, record_key) DO UPDATE SET status = excluded.status, reason = excluded.reason, resolved_by = excluded.resolved_by, updated_at = now()`,
      [req.params.id, d.key, d.status, d.status === "excluded" ? d.reason ?? null : null, req.user.id]);
    res.json(await screeningState(pool, req.params.id, req.user.id));
  });

  r.post("/:id/invite", async (req, res) => {
    await requireOwner(pool, req.params.id, req.user.id);
    for (let i = 0; i < 5; i++) {
      try {
        const code = newInviteCode();
        await pool.query("UPDATE reviews SET invite_code = $2 WHERE id = $1", [req.params.id, code]);
        return res.json({ inviteCode: code });
      } catch (e) { if (e.code !== "23505") throw e; }
    }
    throw new HttpError(500, "Couldn't create an invite code. Try again.");
  });

  r.delete("/:id/invite", async (req, res) => {
    await requireOwner(pool, req.params.id, req.user.id);
    await pool.query("UPDATE reviews SET invite_code = NULL WHERE id = $1", [req.params.id]);
    res.status(204).end();
  });

  r.delete("/:id/members/:userId", async (req, res) => {
    const role = await membership(pool, req.params.id, req.user.id);
    const self = req.params.userId === req.user.id;
    if (!self && role !== "owner") throw new HttpError(403, "Only the review's owner can remove reviewers.");
    if (self && role === "owner") throw new HttpError(400, "The owner can't leave their own review. Delete it instead.");
    await pool.query("DELETE FROM review_members WHERE review_id = $1 AND user_id = $2 AND role = 'reviewer'", [req.params.id, req.params.userId]);
    res.status(204).end();
  });

  const aiLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, keyGenerator: req => req.user.id, standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "You've drafted 10 syntheses in the last hour. Try again later." } });

  r.post("/:id/synthesis", aiLimiter, async (req, res) => {
    await membership(pool, req.params.id, req.user.id);
    const b = parse(Synthesis, req.body);
    const [{ rows: [rv] }, { rows: sources }] = await Promise.all([
      pool.query("SELECT topic FROM reviews WHERE id = $1", [req.params.id]),
      pool.query("SELECT items FROM review_sources WHERE review_id = $1", [req.params.id]),
    ]);
    const idx = recordIndex(sources);
    // Only studies that really belong to this review are sent to the model.
    const records = [...new Set(b.keys)].map(k => idx.get(k) && { ...idx.get(k), key: k }).filter(Boolean).filter(x => !x.sample);
    if (!records.length) throw new HttpError(400, "None of the included studies were found in this review's saved records. Save the review and try again.");
    const result = await synthesise({ topic: rv.topic, rqs: b.rqs, records }, { config, fetch, log });
    await pool.query("UPDATE reviews SET synthesis = $2, updated_at = now() WHERE id = $1", [req.params.id, result]);
    res.json({ synthesis: result });
  });

  r.delete("/:id/synthesis", async (req, res) => {
    await membership(pool, req.params.id, req.user.id);
    await pool.query("UPDATE reviews SET synthesis = NULL WHERE id = $1", [req.params.id]);
    res.status(204).end();
  });

  return r;
}
