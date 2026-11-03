// Server-side search of scholarly databases. Every source returns
// { total, url, items } where items use the same record shape as the front end:
// { title, year, doi, authors[], venue, cites, noCites?, oa, oaKnown?, abstract, type, url, lang, source }

import { HttpError } from "../../lib/http.js";

// DOI prefixes each publisher registers with Crossref
export const PUBLISHERS = {
  sciencedirect: ["10.1016"], tandf: ["10.1080", "10.4324"], wiley: ["10.1002", "10.1111"],
  springer: ["10.1007", "10.1057"], emerald: ["10.1108"], ieee: ["10.1109"], acm: ["10.1145"],
};
export const OPEN_SOURCES = ["openalex", "crossref", "europepmc", "arxiv", ...Object.keys(PUBLISHERS)];

const TIMEOUT_MS = 25000;
const stripTags = s => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const cleanDoi = d => (d || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
const want = (o, kind) => !o.docTypes?.length || o.docTypes.includes(kind);
const CASE_Q = ' AND ("case study" OR "case studies")';
const fullQuery = o => o.query + (o.caseStudy ? CASE_Q : "");

export function invAbstract(inv) {
  if (!inv) return "";
  const words = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) words[p] = w;
  return words.filter(Boolean).join(" ");
}

async function get(fetchImpl, url, { headers = {}, as = "json" } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, { headers: { "User-Agent": "Litview/1.0 (systematic review tool)", ...headers }, signal: ctl.signal });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new HttpError(502, `The database answered with HTTP ${r.status}`, { upstream: body.slice(0, 300) });
    }
    return as === "json" ? r.json() : r.text();
  } catch (e) {
    if (e.name === "AbortError") throw new HttpError(504, "The database took too long to answer");
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, "The database could not be reached");
  } finally {
    clearTimeout(t);
  }
}

/* ---------- open sources ---------- */

async function openalex(o, ctx) {
  const types = new Set();
  if (want(o, "article") || want(o, "conference")) types.add("article");
  if (want(o, "review")) types.add("review");
  if (want(o, "preprint")) types.add("preprint");
  if (want(o, "book")) types.add("book");
  if (want(o, "chapter")) types.add("book-chapter");
  const f = [`from_publication_date:${o.yFrom}-01-01`, `to_publication_date:${o.yTo}-12-31`];
  if (types.size) f.push(`type:${[...types].join("|")}`);
  if (o.oa) f.push("is_oa:true");
  if (o.needAbstract) f.push("has_abstract:true");
  if (o.english) f.push("language:en");
  if (o.minCites) f.push(`cited_by_count:>${o.minCites - 1}`);
  const sort = { relevance: "relevance_score:desc", cited: "cited_by_count:desc", newest: "publication_date:desc" }[o.sort];
  const mail = ctx.config.contactEmail ? `&mailto=${encodeURIComponent(ctx.config.contactEmail)}` : "";
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(fullQuery(o))}&filter=${f.join(",")}&sort=${sort}&per-page=${Math.min(o.perDb, 200)}&select=id,doi,title,publication_year,cited_by_count,primary_location,authorships,open_access,abstract_inverted_index,type,language${mail}`;
  const j = await get(ctx.fetch, url);
  return { total: j.meta?.count ?? j.results.length, url, items: j.results.map(w => ({
    title: w.title, year: w.publication_year, doi: cleanDoi(w.doi),
    authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean),
    venue: w.primary_location?.source?.display_name || "", cites: w.cited_by_count || 0,
    oa: !!w.open_access?.is_oa, abstract: invAbstract(w.abstract_inverted_index), type: w.type,
    url: w.doi || w.id, lang: w.language, source: "openalex",
  })) };
}

async function crossref(o, ctx, prefixes = [], source = "crossref") {
  const types = [];
  if (want(o, "article") || want(o, "review")) types.push("journal-article");
  if (want(o, "conference")) types.push("proceedings-article");
  if (want(o, "preprint")) types.push("posted-content");
  if (want(o, "book")) types.push("book", "monograph", "edited-book");
  if (want(o, "chapter")) types.push("book-chapter");
  const f = [`from-pub-date:${o.yFrom}-01-01`, `until-pub-date:${o.yTo}-12-31`, ...types.map(t => `type:${t}`), ...prefixes.map(p => `prefix:${p}`)];
  if (o.needAbstract && !prefixes.length) f.push("has-abstract:true");
  const sort = { relevance: "relevance", cited: "is-referenced-by-count", newest: "published" }[o.sort];
  const q = o.plain + (o.caseStudy ? " case study" : "");
  const mail = ctx.config.contactEmail ? `&mailto=${encodeURIComponent(ctx.config.contactEmail)}` : "";
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&filter=${f.join(",")}&sort=${sort}&order=desc&rows=${Math.min(o.perDb, 200)}&select=DOI,title,author,issued,container-title,is-referenced-by-count,abstract,type,language,URL${mail}`;
  const j = await get(ctx.fetch, url);
  return { total: j.message["total-results"], url, items: j.message.items.map(w => ({
    title: (w.title || [""])[0], year: w.issued?.["date-parts"]?.[0]?.[0] || null, doi: w.DOI || "",
    authors: (w.author || []).map(a => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean),
    venue: (w["container-title"] || [""])[0] || "", cites: w["is-referenced-by-count"] || 0,
    oa: false, oaKnown: false, abstract: stripTags(w.abstract).replace(/^abstract\s*/i, ""), type: w.type, url: w.URL, lang: w.language, source,
  })) };
}

async function europepmc(o, ctx) {
  let q = `(${fullQuery(o)}) AND PUB_YEAR:[${o.yFrom} TO ${o.yTo}]`;
  if (o.oa) q += " AND OPEN_ACCESS:Y";
  if (o.needAbstract) q += " AND HAS_ABSTRACT:Y";
  if (o.english) q += " AND LANG:eng";
  if (!want(o, "preprint")) q += " AND NOT SRC:PPR";
  const sort = { relevance: "", cited: "&sort=CITED%20desc", newest: "&sort=P_PDATE_D%20desc" }[o.sort];
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&resultType=core&pageSize=${Math.min(o.perDb, 100)}${sort}`;
  const j = await get(ctx.fetch, url);
  return { total: j.hitCount, url, items: (j.resultList?.result || []).map(w => ({
    title: stripTags(w.title).replace(/\.$/, ""), year: +w.pubYear || null, doi: w.doi || "",
    authors: (w.authorList?.author || []).map(a => a.fullName).filter(Boolean),
    venue: w.journalInfo?.journal?.title || w.bookOrReportDetails?.publisher || "", cites: w.citedByCount || 0,
    oa: w.isOpenAccess === "Y", abstract: stripTags(w.abstractText), type: (w.pubTypeList?.pubType || [])[0] || "",
    url: w.doi ? `https://doi.org/${w.doi}` : `https://europepmc.org/article/${w.source}/${w.id}`, lang: w.language, source: "europepmc",
  })) };
}

// Minimal Atom parsing for arXiv; avoids pulling in an XML library.
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : ""; };
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "g"))].map(m => m[1].trim());
const unxml = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

async function arxiv(o, ctx) {
  const words = o.plain.split(/\s+/).filter(Boolean).map(w => `all:${w}`).join(" AND ");
  const q = `(${words})${o.caseStudy ? ' AND (all:"case study" OR all:"case studies")' : ""} AND submittedDate:[${o.yFrom}01010000 TO ${o.yTo}12312359]`;
  const sort = { relevance: "relevance", cited: "relevance", newest: "submittedDate" }[o.sort];
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&max_results=${Math.min(o.perDb, 200)}&sortBy=${sort}&sortOrder=descending`;
  const xml = await get(ctx.fetch, url, { as: "text" });
  const total = +tag(xml, "opensearch:totalResults") || 0;
  const items = tags(xml, "entry").map(e => ({
    title: unxml(tag(e, "title")), year: +tag(e, "published").slice(0, 4) || null, doi: unxml(tag(e, "arxiv:doi")),
    authors: tags(e, "author").map(a => unxml(tag(a, "name"))).filter(Boolean),
    venue: unxml(tag(e, "arxiv:journal_ref")) || "arXiv", cites: 0, noCites: true, oa: true,
    abstract: unxml(tag(e, "summary")), type: "preprint", url: tag(e, "id"), lang: "en", source: "arxiv",
  }));
  return { total: total || items.length, url, items };
}

/* ---------- keyed sources (used when an API key is configured) ---------- */

const SCOPUS_DOC = { article: "ar", review: "re", conference: "cp", book: "bk", chapter: "ch" };
async function scopus(o, ctx) {
  let q = `TITLE-ABS-KEY(${fullQuery(o)}) AND PUBYEAR > ${o.yFrom - 1} AND PUBYEAR < ${o.yTo + 1}`;
  const codes = (o.docTypes || []).map(t => SCOPUS_DOC[t]).filter(Boolean);
  if (codes.length) q += ` AND DOCTYPE(${codes.join(" OR ")})`;
  if (o.english) q += " AND LANGUAGE(english)";
  if (o.oa) q += " AND OPENACCESS(1)";
  const sort = { relevance: "relevancy", cited: "-citedby-count", newest: "-coverDate" }[o.sort];
  const headers = { "X-ELS-APIKey": ctx.config.keys.scopus, Accept: "application/json" };
  if (ctx.config.keys.scopusInstToken) headers["X-ELS-Insttoken"] = ctx.config.keys.scopusInstToken;
  // The STANDARD view returns up to 25 records per page, so page through.
  const items = []; let total = 0;
  const want_n = Math.min(o.perDb, 200);
  const base = `https://api.elsevier.com/content/search/scopus?query=${encodeURIComponent(q)}&sort=${sort}&count=25`;
  for (let start = 0; start < want_n; start += 25) {
    const j = await get(ctx.fetch, `${base}&start=${start}`, { headers });
    const sr = j["search-results"] || {};
    total = +sr["opensearch:totalResults"] || 0;
    const entries = (sr.entry || []).filter(e => !e.error);
    for (const e of entries) items.push({
      title: e["dc:title"] || "", year: +(e["prism:coverDate"] || "").slice(0, 4) || null, doi: e["prism:doi"] || "",
      authors: e["dc:creator"] ? [e["dc:creator"]] : [], venue: e["prism:publicationName"] || "",
      cites: +e["citedby-count"] || 0, oa: e.openaccess === "1" || e.openaccessFlag === true,
      abstract: e["dc:description"] || "", type: { ar: "article", re: "review", cp: "proceedings-article", bk: "book", ch: "book-chapter" }[e.subtype] || "article",
      url: (e.link || []).find(l => l["@ref"] === "scopus")?.["@href"] || "", lang: "en", source: "scopus",
    });
    if (entries.length < 25 || items.length >= total) break;
  }
  return { total, url: base, items: items.slice(0, want_n) };
}

const IEEE_TYPES = { article: "Journals", conference: "Conferences", book: "Books", chapter: "Books" };
async function ieeeApi(o, ctx) {
  const p = new URLSearchParams({ querytext: fullQuery(o), start_year: o.yFrom, end_year: o.yTo, max_records: Math.min(o.perDb, 200) });
  const ct = [...new Set((o.docTypes || []).map(t => IEEE_TYPES[t]).filter(Boolean))];
  if (ct.length === 1) p.set("content_type", ct[0]);
  if (o.oa) p.set("open_access", "true");
  if (o.sort === "newest") { p.set("sort_field", "publication_year"); p.set("sort_order", "desc"); }
  const shown = `https://ieeexploreapi.ieee.org/api/v1/search/articles?${p}`;
  p.set("apikey", ctx.config.keys.ieee);
  const j = await get(ctx.fetch, `https://ieeexploreapi.ieee.org/api/v1/search/articles?${p}`);
  return { total: j.total_records || 0, url: shown, items: (j.articles || []).map(a => ({
    title: a.title || "", year: +a.publication_year || null, doi: a.doi || "",
    authors: (a.authors?.authors || []).map(x => x.full_name).filter(Boolean), venue: a.publication_title || "",
    cites: a.citing_paper_count || 0, oa: a.access_type === "OPEN_ACCESS", abstract: a.abstract || "",
    type: /conference/i.test(a.content_type) ? "proceedings-article" : /book/i.test(a.content_type) ? "book-chapter" : "article",
    url: a.html_url || (a.doi ? `https://doi.org/${a.doi}` : ""), lang: "en", source: "ieee",
  })) };
}

async function springerApi(o, ctx) {
  const n = Math.min(o.perDb, 100);
  const q = `${fullQuery(o)} onlinedatefrom:${o.yFrom}-01-01 onlinedateto:${o.yTo}-12-31`;
  const shown = `https://api.springernature.com/meta/v2/json?q=${encodeURIComponent(q)}&p=${n}`;
  const j = await get(ctx.fetch, `${shown}&api_key=${encodeURIComponent(ctx.config.keys.springer)}`);
  const abs = a => typeof a === "string" ? a : a && typeof a === "object" ? [a.p].flat().filter(Boolean).join(" ") : "";
  return { total: +(j.result?.[0]?.total) || (j.records || []).length, url: shown, items: (j.records || []).map(r => ({
    title: stripTags(r.title), year: +(r.publicationDate || r.onlineDate || "").slice(0, 4) || null, doi: r.doi || "",
    authors: (r.creators || []).map(c => { const [last, first] = (c.creator || "").split(/,\s*/); return `${first || ""} ${last}`.trim(); }).filter(Boolean),
    venue: r.publicationName || "", cites: 0, noCites: true, oa: r.openaccess === "true" || r.openAccess === "true",
    abstract: stripTags(abs(r.abstract)), type: /chapter/i.test(r.contentType) ? "book-chapter" : /book/i.test(r.contentType) ? "book" : "article",
    url: (r.url || []).find(u => u.format === "html")?.value || (r.doi ? `https://doi.org/${r.doi}` : ""), lang: r.language || "en", source: "springer",
  })) };
}

/* ---------- registry ---------- */

/** Which sources this server can search, given the configured keys. */
export function availableSources(config) {
  return {
    open: OPEN_SOURCES,
    keyed: { scopus: !!config.keys.scopus, ieee: !!config.keys.ieee, springer: !!config.keys.springer },
  };
}

export async function searchSource(source, opts, ctx) {
  const k = ctx.config.keys;
  if (source === "openalex") return openalex(opts, ctx);
  if (source === "crossref") return crossref(opts, ctx);
  if (source === "europepmc") return europepmc(opts, ctx);
  if (source === "arxiv") return arxiv(opts, ctx);
  if (source === "scopus") {
    if (!k.scopus) throw new HttpError(400, "Scopus needs an API key on the server. Import a Scopus export instead.");
    return scopus(opts, ctx);
  }
  if (source === "ieee" && k.ieee) return ieeeApi(opts, ctx);
  if (source === "springer" && k.springer) return springerApi(opts, ctx);
  if (PUBLISHERS[source]) return crossref(opts, ctx, PUBLISHERS[source], source);
  throw new HttpError(404, `Unknown database: ${source}`);
}

/** Look up abstracts, citation counts and open-access status in OpenAlex for up to 50 DOIs. */
export async function enrichDois(dois, ctx) {
  const clean = [...new Set(dois.map(d => cleanDoi(d).toLowerCase()).filter(d => d && !/[|,]/.test(d)))].slice(0, 50);
  if (!clean.length) return {};
  const mail = ctx.config.contactEmail ? `&mailto=${encodeURIComponent(ctx.config.contactEmail)}` : "";
  const j = await get(ctx.fetch, `https://api.openalex.org/works?filter=doi:${clean.map(d => encodeURIComponent("https://doi.org/" + d)).join("|")}&per-page=50&select=doi,abstract_inverted_index,cited_by_count,open_access${mail}`);
  const out = Object.fromEntries(clean.map(d => [d, null]));
  for (const w of j.results || []) {
    const d = cleanDoi(w.doi).toLowerCase();
    out[d] = { abstract: invAbstract(w.abstract_inverted_index), cites: w.cited_by_count, oa: !!w.open_access?.is_oa };
  }
  return out;
}
