import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { setup, signUp, rec, OPTS } from "./helpers.js";
import { cohensKappa } from "../src/services/screening.js";

let ctx;
const crossrefItem = (doi, title) => ({ DOI: doi, title: [title], author: [{ given: "Ann", family: "Lee" }], issued: { "date-parts": [[2023]] },
  "container-title": ["J"], "is-referenced-by-count": 4, abstract: "<jats:p>Text</jats:p>", type: "journal-article" });

before(async () => {
  ctx = await setup({
    env: { ANTHROPIC_API_KEY: "test-key", SCOPUS_API_KEY: "scopus-key" },
    routes: [
      [u => u.startsWith("https://api.crossref.org/"), u => ({ json: { message: { "total-results": 42, items: [crossrefItem(`${(u.match(/prefix:(10\.\d+)/) || [])[1] || "10.5"}/x1`, "A Crossref paper")] } } })],
      [u => u.startsWith("https://api.openalex.org/works?filter=doi"), () => ({ json: { results: [{ doi: "https://doi.org/10.1016/x1", abstract_inverted_index: { Hello: [0], world: [1] }, cited_by_count: 9, open_access: { is_oa: true } }] } })],
      [u => u.startsWith("https://api.openalex.org/"), () => ({ json: { meta: { count: 1 }, results: [{ id: "W1", doi: "https://doi.org/10.1/a", title: "OA paper", publication_year: 2024, cited_by_count: 3, authorships: [{ author: { display_name: "Z Ali" } }], open_access: { is_oa: true }, abstract_inverted_index: { An: [0], abstract: [1] }, type: "article", language: "en" }] } })],
      [u => u.startsWith("https://export.arxiv.org/"), () => ({ text: `<feed><opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/abs/1</id><published>2023-01-01</published><title>An arXiv &amp; preprint</title><summary>Sum</summary><author><name>A B</name></author></entry></feed>` })],
      [u => u.startsWith("https://api.elsevier.com/"), (_u, init) => init.headers["X-ELS-APIKey"] === "scopus-key"
        ? { json: { "search-results": { "opensearch:totalResults": "2", entry: [{ "dc:title": "Scopus one", "prism:coverDate": "2022-05-01", "prism:doi": "10.1016/s1", "dc:creator": "Kim J.", "prism:publicationName": "IJIM", "citedby-count": "12", subtype: "ar" }, { "dc:title": "Scopus two", "prism:coverDate": "2021-01-01", subtype: "cp" }] } } }
        : { status: 401, json: {} }],
      [u => u.startsWith("https://api.anthropic.com/"), (_u, init) => {
        const body = JSON.parse(init.body);
        assert.equal(init.headers["x-api-key"], "test-key");
        assert.match(body.messages[0].content, /S1/);
        return { json: { content: [{ type: "text", text: JSON.stringify({
          themes: [{ name: "Vendor management", summary: "Two studies examine vendor trust [S1, S2] and one invented study [S99].", studies: ["S1", "S2", "S99"] }],
          discussion: "Findings converge [S2].", gaps: ["Few longitudinal designs [S1]"], conclusion: "More work is needed." }) }] } };
      }],
    ],
  });
});
after(() => ctx.close());

describe("auth", () => {
  test("register, reject duplicate, log in, read profile", async () => {
    const { api } = ctx;
    const a = await signUp(api, "Omar");
    const dup = await api.post("/api/auth/register").send({ name: "X", email: "OMAR@example.com", password: "12345678" });
    assert.equal(dup.status, 409);
    const bad = await api.post("/api/auth/login").send({ email: "omar@example.com", password: "wrong-password" });
    assert.equal(bad.status, 401);
    const ok = await api.post("/api/auth/login").send({ email: "Omar@Example.com", password: "correct horse battery" });
    assert.equal(ok.status, 200);
    const me = await api.get("/api/auth/me").set(a.auth);
    assert.equal(me.body.user.name, "Omar");
    assert.equal((await api.get("/api/auth/me")).status, 401);
    assert.equal((await api.get("/api/auth/me").set({ Authorization: "Bearer nonsense" })).status, 401);
  });
  test("validation errors are readable", async () => {
    const r = await ctx.api.post("/api/auth/register").send({ name: "", email: "nope", password: "short" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /email/i);
    assert.match(r.body.error, /8 characters/);
  });
});

describe("reviews and team screening", () => {
  let owner, rev2, outsider, id;
  before(async () => {
    owner = await signUp(ctx.api, "Owner");
    rev2 = await signUp(ctx.api, "Second");
    outsider = await signUp(ctx.api, "Outsider");
  });

  test("create a review with sources and list it", async () => {
    const r = await ctx.api.post("/api/reviews").set(owner.auth).send({
      title: "IT outsourcing SLR", topic: "IT outsourcing in SMEs", opts: { yFrom: 2020 },
      sources: { openalex: { items: [rec(1), rec(2), rec(3), rec(4)], total: 100, url: "https://api.openalex.org/works?x" } },
    });
    assert.equal(r.status, 201);
    id = r.body.id;
    const list = await ctx.api.get("/api/reviews").set(owner.auth);
    assert.equal(list.body.reviews.length, 1);
    assert.equal(list.body.reviews[0].records, 4);
    assert.equal(list.body.reviews[0].role, "owner");
  });

  test("other users can't see it", async () => {
    assert.equal((await ctx.api.get(`/api/reviews/${id}`).set(outsider.auth)).status, 404);
    assert.equal((await ctx.api.get(`/api/reviews/not-a-uuid`).set(outsider.auth)).status, 404);
    assert.equal((await ctx.api.put(`/api/reviews/${id}/decisions`).set(outsider.auth).send({ decisions: [{ key: "doi:x", status: "included" }] })).status, 404);
  });

  test("import a source and add a second reviewer by invite code", async () => {
    const imp = await ctx.api.put(`/api/reviews/${id}/sources/scopus`).set(owner.auth).send({ items: [rec(5, { source: "scopus" })], imported: true });
    assert.equal(imp.status, 200);
    const inv = await ctx.api.post(`/api/reviews/${id}/invite`).set(owner.auth);
    assert.match(inv.body.inviteCode, /^[A-Z0-9]{8}$/);
    assert.equal((await ctx.api.post(`/api/reviews/${id}/invite`).set(rev2.auth)).status, 404);
    const join = await ctx.api.post("/api/reviews/join").set(rev2.auth).send({ code: inv.body.inviteCode.toLowerCase() });
    assert.equal(join.status, 200);
    assert.equal(join.body.id, id);
    const got = await ctx.api.get(`/api/reviews/${id}`).set(rev2.auth);
    assert.equal(got.body.role, "reviewer");
    assert.equal(got.body.review.inviteCode, undefined, "reviewers don't see the invite code");
    assert.deepEqual(Object.keys(got.body.sources).sort(), ["openalex", "scopus"]);
    assert.equal(got.body.screening.members.length, 2);
  });

  test("blind screening, conflicts, resolution and kappa", async () => {
    const put = (u, decisions) => ctx.api.put(`/api/reviews/${id}/decisions`).set(u.auth).send({ decisions });
    await put(owner, [
      { key: "doi:10.1000/s1", status: "included" }, { key: "doi:10.1000/s2", status: "excluded", reason: "Off topic" },
      { key: "doi:10.1000/s3", status: "included" }, { key: "doi:10.1000/s4", status: "excluded", reason: "Wrong population" },
    ]);
    // Before the second reviewer decides, they can't see the owner's decisions.
    const blind = await ctx.api.get(`/api/reviews/${id}/screening`).set(rev2.auth);
    assert.deepEqual(blind.body.mine, {});
    assert.equal(blind.body.conflicts.length, 0);

    const r = await put(rev2, [
      { key: "doi:10.1000/s1", status: "included" }, { key: "doi:10.1000/s2", status: "excluded", reason: "Off topic" },
      { key: "doi:10.1000/s3", status: "excluded", reason: "Wrong outcome" }, { key: "doi:10.1000/s4", status: "excluded", reason: "Off topic" },
    ]);
    assert.equal(r.status, 200);
    assert.equal(Object.keys(r.body.mine).length, 4);
    assert.equal(r.body.conflicts.length, 1);
    assert.equal(r.body.conflicts[0].key, "doi:10.1000/s3");
    assert.equal(r.body.final["doi:10.1000/s1"].state, "agreed");
    assert.equal(r.body.final["doi:10.1000/s3"].state, "conflict");
    const ag = r.body.agreement[0];
    assert.equal(ag.n, 4);
    assert.equal(ag.agreement, 0.75);
    assert.equal(ag.kappa, 0.5);
    assert.equal(ag.label, "moderate");

    assert.equal((await ctx.api.put(`/api/reviews/${id}/resolutions`).set(rev2.auth).send({ key: "doi:10.1000/s3", status: "included" })).status, 403);
    const res = await ctx.api.put(`/api/reviews/${id}/resolutions`).set(owner.auth).send({ key: "doi:10.1000/s3", status: "excluded", reason: "Wrong outcome" });
    assert.equal(res.body.conflicts.length, 0);
    assert.equal(res.body.final["doi:10.1000/s3"].state, "resolved");
    assert.equal(res.body.final["doi:10.1000/s3"].status, "excluded");
  });

  test("AI synthesis only cites the review's own studies", async () => {
    const r = await ctx.api.post(`/api/reviews/${id}/synthesis`).set(rev2.auth)
      .send({ keys: ["doi:10.1000/s1", "doi:10.1000/s5", "doi:10.9999/not-in-review"], rqs: ["RQ1: What drives success?"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = r.body.synthesis;
    assert.equal(s.basedOn, 2, "the unknown key is dropped before calling the model");
    assert.deepEqual(s.themes[0].studies.sort(), ["S1", "S2"]);
    assert.doesNotMatch(s.themes[0].summary, /S99/);
    assert.equal(Object.keys(s.studyIds).length, 2);
    const saved = await ctx.api.get(`/api/reviews/${id}`).set(owner.auth);
    assert.equal(saved.body.review.synthesis.themes[0].name, "Vendor management");
  });

  test("reviewer can leave, owner can't; only owner deletes", async () => {
    assert.equal((await ctx.api.delete(`/api/reviews/${id}/members/${owner.user.id}`).set(owner.auth)).status, 400);
    assert.equal((await ctx.api.delete(`/api/reviews/${id}`).set(rev2.auth)).status, 403);
    assert.equal((await ctx.api.delete(`/api/reviews/${id}/members/${rev2.user.id}`).set(rev2.auth)).status, 204);
    assert.equal((await ctx.api.get(`/api/reviews/${id}`).set(rev2.auth)).status, 404);
    assert.equal((await ctx.api.delete(`/api/reviews/${id}`).set(owner.auth)).status, 204);
    assert.equal((await ctx.api.get("/api/reviews").set(owner.auth)).body.reviews.length, 0);
  });
});

describe("search proxy", () => {
  test("lists available sources", async () => {
    const r = await ctx.api.get("/api/sources");
    assert.equal(r.body.keyed.scopus, true);
    assert.equal(r.body.keyed.ieee, false);
    assert.equal(r.body.ai, true);
  });
  test("searches open sources and publishers through Crossref", async () => {
    const oa = await ctx.api.post("/api/search/openalex").send(OPTS);
    assert.equal(oa.status, 200);
    assert.equal(oa.body.items[0].abstract, "An abstract");
    const els = await ctx.api.post("/api/search/sciencedirect").send(OPTS);
    assert.equal(els.body.items[0].source, "sciencedirect");
    assert.match(ctx.fetch.calls.at(-1).url, /prefix:10\.1016/);
    const ax = await ctx.api.post("/api/search/arxiv").send(OPTS);
    assert.equal(ax.body.items[0].title, "An arXiv & preprint");
  });
  test("Scopus needs an account and uses the key", async () => {
    assert.equal((await ctx.api.post("/api/search/scopus").send(OPTS)).status, 401);
    const u = await signUp(ctx.api, "Searcher");
    const r = await ctx.api.post("/api/search/scopus").set(u.auth).send(OPTS);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.items.length, 2);
    assert.equal(r.body.items[1].type, "proceedings-article");
    assert.doesNotMatch(r.body.url, /scopus-key/, "the API key never goes back to the browser");
  });
  test("rejects bad options and unknown databases", async () => {
    assert.equal((await ctx.api.post("/api/search/openalex").send({ ...OPTS, perDb: 5000 })).status, 400);
    assert.equal((await ctx.api.post("/api/search/nowhere").send(OPTS)).status, 404);
  });
  test("fills in abstracts from OpenAlex", async () => {
    const r = await ctx.api.post("/api/enrich").send({ dois: ["https://doi.org/10.1016/X1", "10.2/none"] });
    assert.equal(r.body.results["10.1016/x1"].abstract, "Hello world");
    assert.equal(r.body.results["10.2/none"], null);
  });
  test("CORS only allows configured origins", async () => {
    const ok = await ctx.api.get("/api/sources").set("Origin", "http://allowed.test");
    assert.equal(ok.headers["access-control-allow-origin"], "http://allowed.test");
    const no = await ctx.api.get("/api/sources").set("Origin", "http://evil.test");
    assert.equal(no.headers["access-control-allow-origin"], undefined);
  });
});

test("Cohen's kappa matches a worked example", () => {
  // 50 items: both include 20, both exclude 15, A inc/B exc 5, A exc/B inc 10 -> po=0.7, pe=0.5, kappa=0.4
  const a = new Map(), b = new Map(); let i = 0;
  const add = (n, x, y) => { for (let k = 0; k < n; k++, i++) { a.set(i, x); b.set(i, y); } };
  add(20, "included", "included"); add(15, "excluded", "excluded"); add(5, "included", "excluded"); add(10, "excluded", "included");
  const r = cohensKappa(a, b);
  assert.equal(r.agreement, 0.7);
  assert.equal(r.kappa, 0.4);
});
