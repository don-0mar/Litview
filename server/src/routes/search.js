import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { parse } from "../lib/http.js";
import { authenticate } from "../middleware/auth.js";
import { availableSources, searchSource, enrichDois } from "../services/sources/index.js";

export const SearchOpts = z.object({
  query: z.string().trim().min(1).max(1000),
  plain: z.string().trim().min(1).max(1000),
  yFrom: z.number().int().min(1800).max(2100),
  yTo: z.number().int().min(1800).max(2100),
  docTypes: z.array(z.enum(["article", "conference", "review", "preprint", "book", "chapter"])).default([]),
  caseStudy: z.boolean().default(false),
  oa: z.boolean().default(false),
  needAbstract: z.boolean().default(false),
  english: z.boolean().default(false),
  minCites: z.number().int().min(0).max(100000).default(0),
  perDb: z.number().int().min(1).max(200).default(50),
  sort: z.enum(["relevance", "cited", "newest"]).default("relevance"),
});

export function searchRoutes({ config, fetch, log }) {
  const r = Router();
  const ctx = { config, fetch, log };
  // Searching is open to everyone, but rate limited so the server isn't used as a free proxy.
  const limiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "Too many searches in a minute. Wait a moment and try again." } });
  const optionalAuth = authenticate(config, { required: false });
  const KEYED = new Set(["scopus"]);

  r.get("/sources", (_req, res) => {
    res.json({ ...availableSources(config), ai: !!config.keys.anthropic });
  });

  // Searches that spend a paid API quota need an account.
  const authIfKeyed = (req, res, next) => KEYED.has(req.params.source) ? authenticate(config)(req, res, next) : optionalAuth(req, res, next);

  r.post("/search/:source", limiter, authIfKeyed, async (req, res) => {
    const opts = parse(SearchOpts, req.body);
    if (opts.yFrom > opts.yTo) [opts.yFrom, opts.yTo] = [opts.yTo, opts.yFrom];
    res.json(await searchSource(req.params.source, opts, ctx));
  });

  r.post("/enrich", limiter, async (req, res) => {
    const { dois } = parse(z.object({ dois: z.array(z.string().max(300)).max(50) }), req.body);
    res.json({ results: await enrichDois(dois, ctx) });
  });

  return r;
}
