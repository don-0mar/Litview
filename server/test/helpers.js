import request from "supertest";
import { loadConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
import { createApp } from "../src/app.js";

const TEST_DB = process.env.TEST_DATABASE_URL || "postgres://litview:litview@localhost:5432/litview_test";

/** A fake fetch: routes are [predicate(url, init), handler(url, init) => {status, json|text}]. */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of routes) {
      if (match(String(url), init)) {
        const r = await handler(String(url), init);
        const status = r.status || 200;
        const body = r.text ?? JSON.stringify(r.json);
        return new Response(body, { status, headers: { "content-type": r.text ? "application/xml" : "application/json" } });
      }
    }
    return new Response("not mocked", { status: 500 });
  };
  fn.calls = calls;
  return fn;
}

export async function setup({ env = {}, routes = [] } = {}) {
  const config = loadConfig({ DATABASE_URL: TEST_DB, JWT_SECRET: "test-secret", ALLOWED_ORIGINS: "http://allowed.test", ...env });
  const pool = createPool(config);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool);
  const fetch = fakeFetch(routes);
  const app = createApp({ pool, config, fetch, log: () => {} });
  const api = request(app);
  return { app, api, pool, fetch, config, close: () => pool.end() };
}

export async function signUp(api, name, email = `${name.toLowerCase()}@example.com`) {
  const r = await api.post("/api/auth/register").send({ name, email, password: "correct horse battery" });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.token, user: r.body.user, auth: { Authorization: `Bearer ${r.body.token}` } };
}

export const rec = (n, extra = {}) => ({
  title: `Study ${n} on IT outsourcing`, year: 2022, doi: `10.1000/s${n}`, authors: [`Author ${n}`], venue: "Journal",
  cites: n, oa: false, abstract: `Abstract of study ${n}.`, type: "article", url: "", lang: "en", source: "openalex", ...extra,
});

export const OPTS = { query: '"IT outsourcing" AND SMEs', plain: "IT outsourcing SMEs", yFrom: 2020, yTo: 2025, docTypes: ["article"], perDb: 25, sort: "relevance" };
