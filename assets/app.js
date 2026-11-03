(() => {
"use strict";
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const NOW = new Date().getFullYear();
const DB_NAMES = {openalex:"OpenAlex", crossref:"Crossref", sciencedirect:"ScienceDirect", tandf:"Taylor & Francis", wiley:"Wiley", springer:"Springer", emerald:"Emerald", ieee:"IEEE Xplore", acm:"ACM Digital Library", europepmc:"Europe PMC", arxiv:"arXiv", scopus:"Scopus", proquest:"ProQuest", jstor:"JSTOR", ebsco:"EBSCOhost", sample:"Sample data"};
// DOI prefixes each publisher registers with Crossref
const PUBLISHERS = {sciencedirect:["10.1016"], tandf:["10.1080","10.4324"], wiley:["10.1002","10.1111"], springer:["10.1007","10.1057"], emerald:["10.1108"], ieee:["10.1109"], acm:["10.1145"]};
const Api = window.LitviewApi;
const OPEN_DBS = ["openalex","crossref","europepmc","arxiv",...Object.keys(PUBLISHERS)];
const LOGIN_DBS = ["scopus","proquest","jstor","ebsco"];
const keyed = d => !!(Api.enabled && Api.capabilities?.keyed?.[d]);
const isLive = d => OPEN_DBS.includes(d) || (d === "scopus" && keyed("scopus"));
const isImport = d => LOGIN_DBS.includes(d) && !isLive(d);
const TYPE_LABEL = t => ({"book": "Book", "monograph": "Book", "edited-book": "Book", "reference-book": "Book", "book-chapter": "Book chapter", "proceedings-article": "Conference paper", "preprint": "Preprint", "posted-content": "Preprint", "review": "Review"})[t] || "Article";
const isBook = t => /^(book|monograph|edited-book|reference-book)$/.test(t);
const REASONS = ["Off topic","Wrong study type","Wrong population","Wrong outcome","Not peer reviewed","Full text unavailable","Other"];

const state = { opts:null, records:[], raw:{}, identified:{}, dupes:0, view:"all", filter:"", shown:40, sample:false, decisions:{}, enriched:{}, imported:{},
  totals:{}, urls:{}, reviewId:null, review:null, role:null, team:null, synthesis:null };

/* ---------- query box ---------- */
const topic = $("#topic");
const autosize = () => { topic.style.height = "auto"; topic.style.height = topic.scrollHeight + "px"; };
topic.addEventListener("input", () => { autosize(); const c = $("#customString"); c.placeholder = topic.value.trim() ? autoString(topic.value) : "Built from your topic"; });
topic.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#queryForm").requestSubmit(); } });

$("#yFrom").value = NOW - 5; $("#yTo").value = NOW;
$$("[data-years]").forEach(b => b.onclick = () => { $("#yFrom").value = NOW - +b.dataset.years; $("#yTo").value = NOW; renderChips(); });

const refineBtn = $("#refineBtn");
refineBtn.onclick = () => {
  const open = $("#refine").classList.toggle("open");
  refineBtn.setAttribute("aria-expanded", open);
  refineBtn.textContent = open ? "Hide options" : "Refine search";
};
$("#queryForm").addEventListener("change", renderChips);

function readOpts() {
  const list = s => s.split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  let yFrom = +$("#yFrom").value || 1900, yTo = +$("#yTo").value || NOW;
  if (yFrom > yTo) [yFrom, yTo] = [yTo, yFrom];
  return {
    topic: topic.value.trim(),
    yFrom, yTo,
    dbs: $$("input[name=db]:checked").map(i => i.value),
    types: $$("input[name=type]:checked").map(i => i.value),
    docTypes: $$("input[name=type]:checked").map(i => i.value).filter(v => v !== "case"),
    caseStudy: $("input[name=type][value=case]").checked,
    oa: $("#oaOnly").checked, needAbstract: $("#needAbstract").checked, english: $("#englishOnly").checked,
    minCites: Math.max(0, +$("#minCites").value || 0),
    perDb: +$("#perDb").value, sort: $("#sortBy").value,
    inc: list($("#incTerms").value), exc: list($("#excTerms").value),
    title: $("#reviewTitle").value.trim(),
    rqs: $("#rqs").value.split("\n").map(s => s.trim()).filter(Boolean),
    custom: $("#customString").value.trim(),
  };
}
function applyOpts(o) {
  topic.value = o.topic || ""; autosize();
  $("#yFrom").value = o.yFrom; $("#yTo").value = o.yTo;
  $$("input[name=db]").forEach(i => i.checked = (o.dbs || []).includes(i.value));
  $$("input[name=type]").forEach(i => i.checked = (o.types || []).includes(i.value));
  $("#oaOnly").checked = !!o.oa; $("#needAbstract").checked = !!o.needAbstract; $("#englishOnly").checked = !!o.english;
  $("#minCites").value = o.minCites || 0; $("#perDb").value = String(o.perDb || 50); $("#sortBy").value = o.sort || "relevance";
  $("#incTerms").value = (o.inc || []).join(", "); $("#excTerms").value = (o.exc || []).join(", ");
  $("#reviewTitle").value = o.title || ""; $("#rqs").value = (o.rqs || []).join("\n"); $("#customString").value = o.custom || "";
  renderChips();
}
function renderChips() {
  const o = readOpts();
  const c = [`${o.yFrom}–${o.yTo}`, o.dbs.length > 3 ? `${o.dbs.length} databases` : o.dbs.map(d => DB_NAMES[d]).join(", ") || "No database selected", `${o.perDb} per database`];
  if (o.oa) c.push("Open access");
  if (o.minCites) c.push(`${o.minCites}+ citations`);
  if (o.exc.length) c.push(`Excluding ${o.exc.length} term${o.exc.length > 1 ? "s" : ""}`);
  $("#chips").innerHTML = c.map(x => `<span class="chip">${esc(x)}</span>`).join("");
}
renderChips();

/* ---------- search string ---------- */
const STOP = new Set("a an the of in on for to and or with without by from at as is are was were be been being this that these those its it their into using use via vs versus among between within about over under how what which who whom why when where do does did can could should would may might study studies research review systematic literature effect effects impact role analysis based toward towards new also than then such more most other some any not no our we they i you he she them his her has have had".split(" "));
function keyConcepts(t) {
  // split the topic into concept groups on "and" / commas / semicolons, keep quoted phrases
  const parts = t.replace(/[“”]/g, '"').split(/\s*(?:,|;|\band\b|\bin\b|\bon\b|\bfor\b|\bamong\b|\bof\b)\s*/i).map(s => s.trim()).filter(Boolean);
  const groups = parts.map(p => p.split(/\s+/).filter(w => (/^[A-Z]{2,}s?$/.test(w)) || !STOP.has(w.toLowerCase())).join(" ")).filter(Boolean);
  return groups.length ? groups.slice(0, 5) : [t];
}
function booleanString(t) {
  const custom = $("#customString").value.trim();
  return custom || autoString(t);
}
function autoString(t) {
  return keyConcepts(t).map(g => g.includes(" ") ? `"${g}"` : g).join(" AND ");
}
function plainQuery(t) { return booleanString(t).replace(/\b(AND|OR|NOT)\b|[()"]/g, " ").replace(/\s+/g, " ").trim(); }

/* ---------- fetchers ---------- */
const typeMatch = (o, kind) => o.docTypes.length === 0 || o.docTypes.includes(kind);
const CASE_Q = ' AND ("case study" OR "case studies")';
const qString = o => booleanString(o.topic) + (o.caseStudy ? CASE_Q : "");
async function getJSON(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try { const r = await fetch(url, {signal: ctl.signal}); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); }
  finally { clearTimeout(t); }
}
function invAbstract(inv) {
  if (!inv) return "";
  const words = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) words[p] = w;
  return words.filter(Boolean).join(" ");
}
const stripTags = s => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function fromOpenAlex(o) {
  const types = [];
  if (typeMatch(o,"article")) types.push("article");
  if (typeMatch(o,"review")) types.push("review");
  if (typeMatch(o,"preprint")) types.push("preprint");
  if (typeMatch(o,"conference")) types.push("article"); // OpenAlex files proceedings papers as articles
  if (typeMatch(o,"book")) types.push("book");
  if (typeMatch(o,"chapter")) types.push("book-chapter");
  const f = [`from_publication_date:${o.yFrom}-01-01`, `to_publication_date:${o.yTo}-12-31`];
  if (types.length) f.push(`type:${[...new Set(types)].join("|")}`);
  if (o.oa) f.push("is_oa:true");
  if (o.needAbstract) f.push("has_abstract:true");
  if (o.english) f.push("language:en");
  if (o.minCites) f.push(`cited_by_count:>${o.minCites - 1}`);
  const sort = {relevance:"relevance_score:desc", cited:"cited_by_count:desc", newest:"publication_date:desc"}[o.sort];
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(qString(o))}&filter=${f.join(",")}&sort=${sort}&per-page=${Math.min(o.perDb,200)}&select=id,doi,title,publication_year,cited_by_count,primary_location,authorships,open_access,abstract_inverted_index,type,language`;
  const j = await getJSON(url);
  return { total: j.meta?.count ?? j.results.length, url, items: j.results.map(w => ({
    title: w.title, year: w.publication_year, doi: (w.doi || "").replace("https://doi.org/", ""),
    authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean),
    venue: w.primary_location?.source?.display_name || "", cites: w.cited_by_count || 0,
    oa: !!w.open_access?.is_oa, abstract: invAbstract(w.abstract_inverted_index), type: w.type,
    url: w.doi || w.id, lang: w.language, source: "openalex",
  }))};
}

async function fromCrossref(o, prefixes = [], source = "crossref") {
  const types = [];
  if (typeMatch(o,"article") || typeMatch(o,"review")) types.push("journal-article");
  if (typeMatch(o,"conference")) types.push("proceedings-article");
  if (typeMatch(o,"preprint")) types.push("posted-content");
  if (typeMatch(o,"book")) types.push("book", "monograph", "edited-book");
  if (typeMatch(o,"chapter")) types.push("book-chapter");
  const f = [`from-pub-date:${o.yFrom}-01-01`, `until-pub-date:${o.yTo}-12-31`, ...types.map(t => `type:${t}`)];
  prefixes.forEach(p => f.push(`prefix:${p}`));
  // Some publishers share few abstracts with Crossref; those are filled in from OpenAlex later, so don't filter them out here
  if (o.needAbstract && !prefixes.length) f.push("has-abstract:true");
  const sort = {relevance:"relevance", cited:"is-referenced-by-count", newest:"published"}[o.sort];
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(plainQuery(o.topic) + (o.caseStudy ? " case study" : ""))}&filter=${f.join(",")}&sort=${sort}&order=desc&rows=${Math.min(o.perDb,200)}&select=DOI,title,author,issued,container-title,is-referenced-by-count,abstract,type,language,URL`;
  const j = await getJSON(url);
  return { total: j.message["total-results"], url, items: j.message.items.map(w => ({
    title: (w.title || [""])[0], year: w.issued?.["date-parts"]?.[0]?.[0] || null, doi: w.DOI || "",
    authors: (w.author || []).map(a => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean),
    venue: (w["container-title"] || [""])[0] || "", cites: w["is-referenced-by-count"] || 0,
    oa: false, oaKnown: false, abstract: stripTags(w.abstract).replace(/^abstract\s*/i, ""), type: w.type, url: w.URL, lang: w.language, source,
  }))};
}

async function fromEuropePMC(o) {
  let q = `(${qString(o)}) AND PUB_YEAR:[${o.yFrom} TO ${o.yTo}]`;
  if (o.oa) q += " AND OPEN_ACCESS:Y";
  if (o.needAbstract) q += " AND HAS_ABSTRACT:Y";
  if (o.english) q += " AND LANG:eng";
  if (!typeMatch(o,"preprint")) q += " AND NOT SRC:PPR";
  const sort = {relevance:"", cited:"&sort=CITED%20desc", newest:"&sort=P_PDATE_D%20desc"}[o.sort];
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&resultType=core&pageSize=${Math.min(o.perDb,100)}${sort}`;
  const j = await getJSON(url);
  return { total: j.hitCount, url, items: (j.resultList?.result || []).map(w => ({
    title: stripTags(w.title).replace(/\.$/, ""), year: +w.pubYear || null, doi: w.doi || "",
    authors: (w.authorList?.author || []).map(a => a.fullName).filter(Boolean),
    venue: w.journalInfo?.journal?.title || w.bookOrReportDetails?.publisher || "", cites: w.citedByCount || 0,
    oa: w.isOpenAccess === "Y", abstract: stripTags(w.abstractText), type: (w.pubTypeList?.pubType || [])[0] || "",
    url: w.doi ? `https://doi.org/${w.doi}` : `https://europepmc.org/article/${w.source}/${w.id}`, lang: w.language, source: "europepmc",
  }))};
}

async function fromArxiv(o) {
  const terms = ($("#customString").value.trim() ? plainQuery(o.topic).split(" ") : keyConcepts(o.topic)).map(g => g.includes(" ") ? `all:"${g}"` : `all:${g}`).join(" AND ");
  const q = `(${terms})${o.caseStudy ? ' AND (all:"case study" OR all:"case studies")' : ""} AND submittedDate:[${o.yFrom}01010000 TO ${o.yTo}12312359]`;
  const sort = {relevance:"relevance", cited:"relevance", newest:"submittedDate"}[o.sort];
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&max_results=${Math.min(o.perDb,200)}&sortBy=${sort}&sortOrder=descending`;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  let txt; try { const r = await fetch(url, {signal: ctl.signal}); if (!r.ok) throw new Error(`HTTP ${r.status}`); txt = await r.text(); } finally { clearTimeout(t); }
  const x = new DOMParser().parseFromString(txt, "application/xml");
  const total = +(x.getElementsByTagName("opensearch:totalResults")[0]?.textContent || 0);
  const items = [...x.getElementsByTagName("entry")].map(e => {
    const g = n => e.getElementsByTagName(n)[0]?.textContent?.trim() || "";
    const doi = e.getElementsByTagName("arxiv:doi")[0]?.textContent || "";
    const jr = e.getElementsByTagName("arxiv:journal_ref")[0]?.textContent || "";
    return { title: g("title").replace(/\s+/g, " "), year: +g("published").slice(0,4) || null, doi,
      authors: [...e.getElementsByTagName("author")].map(a => a.getElementsByTagName("name")[0]?.textContent).filter(Boolean),
      venue: jr || "arXiv", cites: 0, noCites: true, oa: true, abstract: g("summary").replace(/\s+/g, " "), type: "preprint",
      url: g("id"), lang: "en", source: "arxiv" };
  });
  return { total: total || items.length, url, items };
}
const FETCHERS = {openalex: fromOpenAlex, crossref: o => fromCrossref(o), europepmc: fromEuropePMC, arxiv: fromArxiv};
for (const [k, pre] of Object.entries(PUBLISHERS)) FETCHERS[k] = o => fromCrossref(o, pre, k);

/* fill in missing abstracts, citation counts and open-access status from OpenAlex, 50 DOIs per request */
async function enrich(records, onProgress) {
  const need = [...new Set(records.filter(r => !r.sample && r.doi && (!r.abstract || r.noCites || (state.opts?.oa && r.oaKnown === false)) && !(r.doi.toLowerCase() in state.enriched) && !/[|,]/.test(r.doi)).map(r => r.doi.toLowerCase()))];
  let added = 0;
  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50);
    try {
      batch.forEach(d => state.enriched[d] = state.enriched[d] || null);
      if (Api.enabled) {
        const { results } = await Api.enrich(batch);
        for (const [d, v] of Object.entries(results)) { if (v) { state.enriched[d] = v; if (v.abstract) added++; } }
      } else {
        const j = await getJSON(`https://api.openalex.org/works?filter=doi:${batch.map(d => encodeURIComponent("https://doi.org/" + d)).join("|")}&per-page=50&select=doi,abstract_inverted_index,cited_by_count,open_access`);
        for (const w of j.results) {
          const d = (w.doi || "").replace("https://doi.org/", "").toLowerCase();
          const abs = invAbstract(w.abstract_inverted_index);
          state.enriched[d] = {abstract: abs, cites: w.cited_by_count, oa: !!w.open_access?.is_oa};
          if (abs) added++;
        }
      }
    } catch { /* leave these records as they are */ }
    onProgress?.(added, Math.min(i + 50, need.length), need.length);
  }
  return added;
}

/* ---------- import databases ---------- */
const DOC_CODES = {
  scopus: {article: "ar", review: "re", conference: "cp", book: "bk", chapter: "ch"},
};
function importString(db, o) {
  const q = qString(o);
  const years = `${o.yFrom}-${o.yTo}`;
  if (db === "scopus") {
    let s = `TITLE-ABS-KEY(${q}) AND PUBYEAR > ${o.yFrom - 1} AND PUBYEAR < ${o.yTo + 1}`;
    const codes = o.docTypes.map(t => DOC_CODES.scopus[t]).filter(Boolean);
    if (codes.length) s += ` AND DOCTYPE(${codes.join(" OR ")})`;
    if (o.english) s += " AND LANGUAGE(english)";
    if (o.oa) s += " AND OPENACCESS(1)";
    return s;
  }
  if (db === "proquest") return `noft(${q})`;
  if (db === "jstor") return `ti:(${q}) OR ab:(${q})`;
  if (db === "ebsco") return `TI (${q}) OR AB (${q})`;
  return q;
}
const IMPORT_INFO = {
  scopus: {url: "https://www.scopus.com/search/form.uri?display=advanced", how: "Paste into Advanced document search. Export all results as RIS or CSV with abstracts included."},
  proquest: {url: "https://www.proquest.com/advanced", how: `Paste into Advanced Search, then set the publication date filter to ${"{years}"}. Export as RIS.`},
  jstor: {url: "https://www.jstor.org/action/doAdvancedSearch", how: `Paste into Advanced Search and set the date range to ${"{years}"}. Export citations as RIS.`},
  ebsco: {url: "https://search.ebscohost.com/", how: `Sign in through your library, paste into Advanced Search and limit publication dates to ${"{years}"}. Export as RIS.`},
};
function renderImports() {
  const o = state.opts;
  const dbs = o.dbs.filter(d => isImport(d));
  if (!dbs.length) { $("#importWrap").innerHTML = ""; return; }
  $("#importWrap").innerHTML = `<h3>Add results from databases that need your login</h3>
    <p class="sub" style="margin-bottom:6px">Run each search string in its database, export the results, and import the file here. Imported records join the same duplicate check, screening and flow diagram. RIS, BibTeX and CSV files work.</p>
    <div class="imports">${dbs.map(d => {
      const n = state.imported[d];
      return `<div class="imp" data-db="${d}">
        <h4>${DB_NAMES[d]}</h4>
        <p class="hint" style="margin:0">${esc(IMPORT_INFO[d].how.replace("{years}", `${o.yFrom}–${o.yTo}`))}</p>
        <div class="searchstring mono">${esc(importString(d, o))}</div>
        <div class="acts">
          <button type="button" class="btn small" data-copystr="${d}">Copy search string</button>
          <a class="btn small" href="${IMPORT_INFO[d].url}" target="_blank" rel="noopener">Open ${DB_NAMES[d]}</a>
          <label class="btn small primary filebtn">${n != null ? "Replace file" : "Import results"}<input type="file" accept=".ris,.bib,.bibtex,.csv,.txt,.nbib" multiple data-import="${d}" aria-label="Import ${DB_NAMES[d]} results"></label>
          ${n != null ? `<span class="done">${n} records imported</span>` : ""}
        </div>
      </div>`; }).join("")}</div>`;
}
$("#importWrap").addEventListener("click", async e => {
  const b = e.target.closest("[data-copystr]"); if (!b) return;
  try { await navigator.clipboard.writeText(importString(b.dataset.copystr, state.opts)); toast(`${DB_NAMES[b.dataset.copystr]} search string copied`); }
  catch { toast("Copying is blocked here. Select the text and copy it instead."); }
});
$("#importWrap").addEventListener("change", async e => {
  const inp = e.target.closest("[data-import]"); if (!inp || !inp.files.length) return;
  const db = inp.dataset.import;
  let items = [];
  for (const f of inp.files) {
    const txt = await f.text();
    try { items.push(...parseCitations(txt, f.name)); } catch { /* skip unreadable file */ }
  }
  items = items.filter(r => r.title).map(r => ({...r, source: db}));
  if (!items.length) { toast(`No records found in that file. Export as RIS, BibTeX or CSV and try again.`); inp.value = ""; return; }
  state.raw[db] = items; state.imported[db] = items.length; state.totals[db] = items.length;
  toast(`Imported ${items.length} records from ${DB_NAMES[db]}`);
  if (!state.sample) await enrich(items);
  rebuild(); renderAll();
  if (state.reviewId) Api.putSource(state.reviewId, db, sourcePayload(db)).catch(e => toast(`Not saved: ${e.message}`));
});

function parseCitations(txt, name = "") {
  txt = txt.replace(/^\uFEFF/, "");
  if (/\.bib(tex)?$/i.test(name) || /^\s*@\w+\s*[{(]/m.test(txt) && !/^TY  - /m.test(txt)) return parseBib(txt);
  if (/^TY  ?- /m.test(txt)) return parseRIS(txt);
  if (/\.csv$/i.test(name) || /,/.test(txt.split("\n")[0])) return parseCSV(txt);
  return [];
}
const flipName = n => { n = n.trim(); if (!n.includes(",")) return n; const [last, first] = n.split(/,\s*/); return `${first || ""} ${last}`.trim(); };
const RIS_TYPES = {JOUR: "article", JFULL: "article", BOOK: "book", EBOOK: "book", EDBOOK: "book", CHAP: "book-chapter", ECHAP: "book-chapter", CONF: "proceedings-article", CPAPER: "proceedings-article", THES: "dissertation", RPRT: "report"};
function parseRIS(txt) {
  const out = []; let r = null;
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9])  ?- ?(.*)$/);
    if (!m) { if (r && r._last && line.trim()) r[r._last] += " " + line.trim(); continue; }
    const [, tag, val] = m;
    if (tag === "TY") { r = {authors: [], abstract: "", title: "", venue: "", doi: "", url: "", type: RIS_TYPES[val.trim()] || "article", cites: 0, noCites: true, oa: false, oaKnown: false}; continue; }
    if (!r) continue;
    if (tag === "ER") { delete r._last; out.push(r); r = null; continue; }
    const v = val.trim(); r._last = null;
    if (tag === "TI" || tag === "T1") { r.title = r.title || v; r._last = "title"; }
    else if (tag === "AU" || tag === "A1") r.authors.push(flipName(v));
    else if ((tag === "PY" || tag === "Y1" || tag === "DA") && !r.year) r.year = +(v.match(/\d{4}/) || [])[0] || null;
    else if (["JO", "JF", "T2", "BT", "JA"].includes(tag) && !r.venue) r.venue = v;
    else if (tag === "PB" && !r.venue && /book/.test(r.type)) r.venue = v;
    else if (tag === "DO") r.doi = v.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    else if (tag === "AB" || tag === "N2") { r.abstract = r.abstract || v; r._last = "abstract"; }
    else if (tag === "UR" && !r.url) r.url = v;
    else if (tag === "LA") r.lang = /^en/i.test(v) ? "en" : v;
  }
  return out;
}
function parseBib(txt) {
  const out = []; let i = 0;
  const clean = v => v.replace(/[{}]/g, "").replace(/\\&/g, "&").replace(/\s+/g, " ").trim();
  while ((i = txt.indexOf("@", i)) !== -1) {
    const m = txt.slice(i).match(/^@(\w+)\s*[{(]/); if (!m) { i++; continue; }
    const type = m[1].toLowerCase(); let j = i + m[0].length, depth = 1;
    const startBody = j;
    while (j < txt.length && depth) { if (txt[j] === "{" || txt[j] === "(") depth++; else if (txt[j] === "}" || txt[j] === ")") depth--; j++; }
    const body = txt.slice(startBody, j - 1); i = j;
    if (["comment", "preamble", "string"].includes(type)) continue;
    const f = {}; const re = /(\w+)\s*=\s*/g; let mm;
    while ((mm = re.exec(body))) {
      let k = mm[1].toLowerCase(), p = re.lastIndex, v = "";
      if (body[p] === "{") { let d = 0, q = p; do { if (body[q] === "{") d++; else if (body[q] === "}") d--; q++; } while (d && q < body.length); v = body.slice(p + 1, q - 1); re.lastIndex = q; }
      else if (body[p] === '"') { const q = body.indexOf('"', p + 1); v = body.slice(p + 1, q); re.lastIndex = q + 1; }
      else { const q = body.slice(p).search(/[,\n]/); v = body.slice(p, q < 0 ? undefined : p + q); re.lastIndex = p + (q < 0 ? 0 : q); }
      f[k] = clean(v);
    }
    out.push({ title: f.title || "", authors: (f.author || "").split(/\s+and\s+/i).map(flipName).filter(Boolean), year: +(f.year || "").slice(0, 4) || null,
      venue: f.journal || f.booktitle || f.publisher || "", doi: (f.doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""), abstract: f.abstract || "", url: f.url || "",
      type: {article: "article", book: "book", incollection: "book-chapter", inbook: "book-chapter", inproceedings: "proceedings-article", conference: "proceedings-article"}[type] || "article",
      cites: 0, noCites: true, oa: false, oaKnown: false, lang: f.language && !/^en/i.test(f.language) ? f.language : "en" });
  }
  return out;
}
function parseCSVRows(txt) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && txt[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(Boolean));
}
function parseCSV(txt) {
  const [head, ...rows] = parseCSVRows(txt); if (!head) return [];
  const h = head.map(x => x.trim().toLowerCase());
  const col = (...names) => { for (const n of names) { const k = h.indexOf(n); if (k >= 0) return k; } return -1; };
  const C = { title: col("title", "article title", "document title"), authors: col("authors", "author", "author full names"), year: col("year", "publication year", "pubyear"),
    venue: col("source title", "journal", "publication title", "source"), doi: col("doi"), abstract: col("abstract"), cites: col("cited by", "citations", "times cited"),
    type: col("document type", "type"), url: col("link", "url"), lang: col("language of original document", "language") };
  return rows.map(r => {
    const g = k => C[k] >= 0 ? (r[C[k]] || "").trim() : "";
    const au = g("authors"); const cites = g("cites");
    const dt = g("type").toLowerCase();
    return { title: g("title"), authors: (au.includes(";") ? au.split(";") : au.split(/,(?=\s*[A-Z][a-z])/)).map(x => flipName(x.trim())).filter(Boolean),
      year: +(g("year").match(/\d{4}/) || [])[0] || null, venue: g("venue"), doi: g("doi").replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""),
      abstract: /^\[no abstract/i.test(g("abstract")) ? "" : g("abstract"), cites: +cites || 0, noCites: cites === "", oa: false, oaKnown: false, url: g("url"),
      type: /chapter/.test(dt) ? "book-chapter" : /book/.test(dt) ? "book" : /conference/.test(dt) ? "proceedings-article" : /review/.test(dt) ? "review" : "article",
      lang: g("lang") && !/^en/i.test(g("lang")) ? g("lang") : "en" };
  });
}

/* ---------- sample data (clearly labelled, for previews where live search is blocked) ---------- */
function sampleRecords(o) {
  const c = keyConcepts(o.topic); const A = c[0] || "the topic", B = c[1] || "outcomes";
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const frames = [
    `${cap(A)} and ${B}: a cross-sectional survey`, `Determinants of ${A} adoption: evidence from a structural equation model`,
    `A qualitative study of barriers to ${A}`, `${cap(A)} in developing economies: a panel data analysis`,
    `Measuring ${B} in the context of ${A}`, `The moderating role of trust in ${A} and ${B}`,
    `${cap(A)}: a bibliometric review`, `Longitudinal effects of ${A} on ${B}`, `Mixed-methods evaluation of ${A} programmes`,
    `Antecedents of ${A}: a meta-analysis`, `${cap(A)} during the COVID-19 period`, `A conceptual framework for ${A} and ${B}`,
    `Comparing ${A} practices across sectors`, `Stakeholder perspectives on ${A}`, `${cap(A)} and firm performance: a PLS-SEM approach`,
    `Digital transformation and ${A}`, `Policy implications of ${A}`, `Study protocol for a trial of ${A}`,
    `${cap(A)} among small and medium enterprises`, `${cap(A)} implementation: a case study`, `Risk factors in ${A}`,
    `Institutional theory perspectives on ${A}`, `Machine learning approaches to ${A}`, `${cap(B)} after ${A}: a quasi-experiment`,
  ];
  const venues = ["Sample Journal of Management", "Sample Review of Information Systems", "Sample Conference Proceedings", "Sample Journal of Applied Research", "Sample Policy Quarterly"];
  const names = ["A. Rahman","L. Tan","M. Okafor","S. Müller","J. Silva","K. Ito","P. Novak","R. Gupta","E. Haddad","C. Lim"];
  let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const recs = [];
  const span = Math.max(1, o.yTo - o.yFrom + 1);
  frames.forEach((t, i) => {
    const src = ["openalex","crossref","openalex","crossref"][i % 4];
    recs.push({ title: t, year: o.yFrom + Math.floor(rnd() * span), doi: `10.0000/sample.${i + 1}`,
      authors: [names[i % 10], names[(i + 3) % 10], names[(i + 6) % 10]].slice(0, 1 + (i % 3)),
      venue: venues[i % venues.length], cites: Math.floor(rnd() * rnd() * 300), oa: rnd() > .5,
      abstract: `This illustrative abstract stands in for a real one. It describes a study of ${A} with attention to ${B}, the sample, the method and the main finding, so that screening and term analysis have text to work with. ${i % 3 === 0 ? "The case study draws on interviews with managers and employees." : "Data came from a survey of organisations analysed with regression."}`,
      type: ["article","article","proceedings-article","article","book-chapter","article","book"][i % 7], url: "", lang: "en", source: src, sample: true });
    if (i % 6 === 0) recs.push({...recs[recs.length - 1], source: src === "openalex" ? "crossref" : "openalex"}); // duplicates to show dedup
  });
  return recs;
}

/* ---------- pipeline ---------- */
const normTitle = t => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function dedupe(items) {
  const seen = new Map(); let d = 0;
  for (const r of items) {
    if (!r.title) continue;
    const k = r.doi ? "doi:" + r.doi.toLowerCase() : "t:" + normTitle(r.title);
    const k2 = "t:" + normTitle(r.title);
    const hit = seen.get(k) || seen.get(k2);
    if (hit) {
      d++;
      if (hit.noCites && !r.noCites) { hit.cites = r.cites; hit.noCites = false; } else if (!r.noCites) hit.cites = Math.max(hit.cites, r.cites);
      hit.oa = hit.oa || r.oa; hit.oaKnown = hit.oaKnown !== false || r.oaKnown !== false;
      if (!hit.abstract && r.abstract) hit.abstract = r.abstract; if (!hit.doi && r.doi) hit.doi = r.doi;
      hit.foundIn.add(r.source); continue;
    }
    const rec = {...r, foundIn: new Set([r.source])};
    const e = rec.doi && state.enriched[rec.doi.toLowerCase()];
    if (e) { if (!rec.abstract && e.abstract) rec.abstract = e.abstract; if (rec.noCites || rec.oaKnown === false) { rec.cites = Math.max(rec.cites, e.cites || 0); rec.noCites = false; } if (rec.oaKnown === false) { rec.oa = e.oa; rec.oaKnown = true; } }
    seen.set(k, rec); seen.set(k2, rec);
  }
  return { unique: [...new Set(seen.values())], dupes: d };
}
function autoScreen(r, o) {
  const text = (r.title + " " + r.abstract).toLowerCase();
  if (r.year && (r.year < o.yFrom || r.year > o.yTo)) return "Outside year range";
  if (o.needAbstract && !r.abstract) return "No abstract";
  if (o.english && r.lang && !/^en/.test(r.lang)) return "Not in English";
  if (o.minCites && !r.noCites && r.cites < o.minCites) return `Fewer than ${o.minCites} citations`;
  if (o.oa && !r.oa && r.oaKnown !== false) return "Not open access";
  if (o.caseStudy && !/case[\s-]+stud(y|ies)/.test(text)) return "Not a case study";
  const ex = o.exc.find(t => text.includes(t)); if (ex) return `Mentions “${ex}”`;
  if (o.inc.length && !o.inc.some(t => text.includes(t))) return "Missing required terms";
  return null;
}

let uid = 0;
const recKey = r => r.doi ? "doi:" + r.doi.toLowerCase() : "t:" + normTitle(r.title);
function rebuild() {
  const o = state.opts;
  // Merge sources in a fixed order so every reviewer sees the records in the same order.
  const rank = d => { const i = [...OPEN_DBS, ...LOGIN_DBS].indexOf(d); return i < 0 ? 99 : i; };
  const order = Object.keys(state.raw).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const all = order.flatMap(k => state.raw[k]);
  state.identified = Object.fromEntries(order.map(k => [k, state.raw[k].length]));
  const {unique, dupes} = dedupe(all);
  state.dupes = dupes;
  state.records = unique.map(r => ({...r, key: recKey(r), id: ++uid, autoReason: autoScreen(r, o)}));
  applyStatuses();
  const sortFn = {relevance: null, cited: (a, b) => b.cites - a.cites, newest: (a, b) => (b.year || 0) - (a.year || 0)}[o.sort];
  if (sortFn) state.records.sort(sortFn);
}
/* A record's status comes from, in order: the team's final call (when two or more people screen),
   your own decision, then the automatic eligibility check. */
const teamMode = () => !!(state.team && state.team.members.length > 1);
function applyStatuses() {
  const team = teamMode();
  for (const r of state.records) {
    r.mine = state.decisions[r.key] || null;
    const f = team ? state.team.final[r.key] : null;
    r.teamState = f?.state || null;
    r.conflict = r.teamState === "conflict";
    const d = r.conflict ? null : (f || r.mine);
    if (r.conflict) { r.status = "included"; r.reason = null; r.auto = false; }
    else if (d) { r.status = d.status; r.reason = d.reason || (d.status === "excluded" ? REASONS[0] : null); r.auto = false; }
    else { r.status = r.autoReason ? "excluded" : "included"; r.reason = r.autoReason; r.auto = !!r.autoReason; }
  }
}
function showWorkspace() {
  document.body.classList.add("has-results");
  state.view = "all"; state.filter = ""; state.shown = 40; $("#recFilter").value = "";
  $$(".seg button").forEach(x => x.setAttribute("aria-pressed", x.dataset.view === "all"));
  renderAll(); selectTab("t-search");
  $("#workspace").scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start"});
}
function searchBody(o) {
  return { query: booleanString(o.topic), plain: plainQuery(o.topic), yFrom: o.yFrom, yTo: o.yTo, docTypes: o.docTypes, caseStudy: o.caseStudy,
    oa: o.oa, needAbstract: o.needAbstract, english: o.english, minCites: o.minCites, perDb: o.perDb, sort: o.sort };
}
const searchSource = (d, o) => Api.enabled ? Api.search(d, searchBody(o)) : FETCHERS[d](o);
async function run(o, forceSample = false) {
  detachReview();
  state.opts = o; state.sample = forceSample; state.raw = {}; state.decisions = {}; state.imported = {}; state.totals = {};
  const live = o.dbs.filter(d => isLive(d));
  const hasImports = o.dbs.some(d => isImport(d));
  const st = $("#status");
  const lines = Object.fromEntries((forceSample ? ["sample"] : live).map(d => [d, {cls: "busy", msg: "Searching…"}]));
  const draw = () => st.innerHTML = Object.entries(lines).map(([d, l]) => `<div class="line"><span class="dot ${l.cls}"></span><strong>${esc(DB_NAMES[d] || d)}</strong><span>${esc(l.msg)}</span></div>`).join("");
  draw();
  $("#runBtn").disabled = true;
  state.urls = {};
  if (forceSample) {
    for (const r of sampleRecords(o)) (state.raw[r.source] = state.raw[r.source] || []).push(r);
    lines.sample = {cls: "ok", msg: `${Object.values(state.raw).flat().length} illustrative records generated`}; draw();
  } else {
    await Promise.all(live.map(async d => {
      try {
        const res = await searchSource(d, o);
        state.raw[d] = res.items; state.urls[d] = res.url; state.totals[d] = res.total;
        lines[d] = {cls: "ok", msg: `${res.items.length} retrieved of ${Number(res.total).toLocaleString()} matches`};
      } catch (e) {
        lines[d] = {cls: "err", msg: e.name === "AbortError" ? "Timed out after 20 seconds" : e.status === 401 ? "Sign in to search this database" : e.status ? e.message : "Could not be reached"};
      }
      draw();
    }));
    const all = Object.values(state.raw).flat();
    if (all.some(r => !r.abstract && r.doi)) {
      lines.enrich = {cls: "busy", msg: "Looking up missing abstracts in OpenAlex…"}; DB_NAMES.enrich = "Abstract lookup"; draw();
      const added = await enrich(all, (a, done, total) => { lines.enrich.msg = `Looking up missing abstracts in OpenAlex… ${done} of ${total}`; draw(); });
      lines.enrich = {cls: "ok", msg: `${added} missing abstract${added === 1 ? "" : "s"} filled in`}; draw();
    }
  }
  $("#runBtn").disabled = false;

  const total = Object.values(state.raw).flat().length;
  if (!total && !(hasImports && !live.length)) {
    const blocked = live.length && live.every(d => lines[d].cls === "err");
    st.insertAdjacentHTML("beforeend", blocked
      ? `<div class="notice"><p><strong>No database could be reached.</strong> ${Api.enabled ? "The Litview server may be waking up, which takes about a minute. Try again shortly." : "This usually means the page is running somewhere that blocks outside requests, such as an embedded preview. Host the file (for example on GitHub Pages) or open it directly in your browser to search for real."}</p><p><button type="button" class="btn small" id="trySample">Try the interface with sample records</button>${hasImports ? ` <button type="button" class="btn small" id="importOnly">Continue with imports only</button>` : ""}</p></div>`
      : `<div class="notice"><p><strong>No records matched.</strong> Widen the year range, select more databases, or use fewer words in your topic.</p>${hasImports ? `<p><button type="button" class="btn small" id="importOnly">Continue with imports only</button></p>` : ""}</div>`);
    $("#trySample")?.addEventListener("click", () => run(o, true));
    $("#importOnly")?.addEventListener("click", () => { rebuild(); showWorkspace(); });
    return;
  }
  rebuild();
  if (forceSample) st.insertAdjacentHTML("beforeend", `<div class="notice sample"><p><strong>You're looking at sample records.</strong> Titles, authors and venues are made up so you can try screening, analysis and the report. Host the page to search real databases.</p></div>`);
  if (hasImports) st.insertAdjacentHTML("beforeend", `<div class="notice"><p>${list(o.dbs.filter(d => isImport(d)).map(d => DB_NAMES[d]))} need${o.dbs.filter(d => isImport(d)).length > 1 ? "" : "s"} your login. Their search strings and import buttons are in the search log below.</p></div>`);
  showWorkspace();
}

$("#queryForm").addEventListener("submit", e => {
  e.preventDefault();
  const o = readOpts();
  if (!o.topic) { topic.focus(); toast("Describe your research topic first"); return; }
  if (!o.dbs.length) { toast("Select at least one database"); $("#refine").classList.contains("open") || refineBtn.click(); return; }
  if ($("#refine").classList.contains("open")) refineBtn.click();
  run(o);
});

/* ---------- tabs ---------- */
const tabs = $$(".tab");
function selectTab(id) {
  tabs.forEach(t => { const on = t.id === id; t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; $("#" + t.getAttribute("aria-controls")).hidden = !on; });
}
tabs.forEach((t, i) => {
  t.onclick = () => selectTab(t.id);
  t.onkeydown = e => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]; selectTab(n.id); n.focus(); } };
});

/* ---------- counts ---------- */
function counts() {
  const r = state.records;
  const identified = Object.values(state.identified).reduce((a, b) => a + b, 0);
  const autoEx = r.filter(x => x.status === "excluded" && x.auto).length;
  const manEx = r.filter(x => x.status === "excluded" && !x.auto).length;
  const inc = r.filter(x => x.status === "included");
  const reasons = {};
  r.filter(x => x.status === "excluded").forEach(x => { const k = x.auto ? x.reason.replace(/“.*”/, "excluded term") : x.reason; reasons[k] = (reasons[k] || 0) + 1; });
  return { identified, dupes: state.dupes, screened: r.length, autoEx, manEx, included: inc.length, inc, reasons };
}

function renderAll() { renderReviewBar(); renderAiBox(); renderImports(); renderProtocol(); renderPrisma(); renderRecs(); renderAnalysis(); renderReport(); }
function refreshCounts() { renderPrisma(); renderCountsOnly(); renderAnalysis(); renderReport(); renderProtocol(); }

/* ---------- search log ---------- */
function renderProtocol() {
  const o = state.opts;
  const typeNames = {article: "Journal articles", conference: "Conference papers", review: "Reviews", preprint: "Preprints", book: "Books", chapter: "Book chapters", case: "Case studies"};
  const rows = [
    ["Topic", esc(o.topic)],
    ["Databases", (state.sample ? ["Sample data"] : o.dbs.map(d => DB_NAMES[d] + (isImport(d) ? (state.imported[d] != null ? " (imported)" : " (awaiting import)") : ""))).join(", ")],
    ["Years", `${o.yFrom}–${o.yTo}`],
    ["Study types", o.types.map(t => typeNames[t]).join(", ") || "Any"],
    ["Language", o.english ? "English" : "Any"],
    ["Other criteria", [o.oa && "Open access only", o.needAbstract && "Abstract available", o.minCites && `${o.minCites}+ citations`].filter(Boolean).join("; ") || "None"],
    ["Inclusion terms", esc(o.inc.join(", ")) || "None"],
    ["Exclusion terms", esc(o.exc.join(", ")) || "None"],
    ["Searched on", new Date().toLocaleDateString(undefined, {day: "numeric", month: "long", year: "numeric"})],
    ...(teamMode() ? [["Screening", esc(agreementText() || `${state.team.members.length} reviewers, screening independently`)]] : []),
  ];
  $("#protocol").innerHTML = rows.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join("");
  $("#searchString").textContent = qString(o);
}

function renderPrisma() {
  const c = counts();
  const dbLines = Object.entries(state.identified).map(([d, n]) => `${DB_NAMES[d]} (n = ${n})`);
  const W = 560, bw = 300, sx = 210, gap = 26;
  const box = (x, y, w, h, title, lines, fill = "#fff", stroke = "#1C2333") =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>` +
    `<text x="${x + 12}" y="${y + 22}" font-size="13.5" font-weight="700" fill="#1C2333">${esc(title)}</text>` +
    lines.map((l, i) => `<text x="${x + 12}" y="${y + 42 + i * 17}" font-size="12.5" fill="#3a4356">${esc(l)}</text>`).join("");
  const arrow = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#1C2333" stroke-width="1.5" marker-end="url(#ah)"/>`;
  const h1 = 50 + dbLines.length * 17, y1 = 30;
  const y2 = y1 + h1 + gap, h2 = 62;
  const y3 = y2 + h2 + gap, h3 = 62;
  const y4 = y3 + h3 + gap, h4 = 62;
  const exLines = Object.entries(c.reasons).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} (n = ${n})`);
  const label = (y, h, t) => `<text transform="translate(16 ${y + h / 2}) rotate(-90)" text-anchor="middle" font-size="12" font-weight="700" fill="#2F5D8A">${t}</text>`;
  const H = y4 + h4 + 14;
  const leftX = 36, lw = sx - leftX - 30;
  $("#prisma").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="PRISMA flow diagram: ${c.identified} records identified, ${c.dupes} duplicates removed, ${c.screened} screened, ${c.autoEx + c.manEx} excluded, ${c.included} included.">
    <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#1C2333"/></marker></defs>
    ${label(y1, h1, "Identification")}${label(y2, h2 + gap + h3, "Screening")}${label(y4, h4, "Included")}
    ${box(leftX, y1, 300, h1, `Records identified (n = ${c.identified})`, dbLines)}
    ${box(366, y1 + (h1 - 62) / 2, W - 370, 62, "Duplicates removed", [`n = ${c.dupes}`], "#EEF1F4")}
    ${arrow(leftX + 300, y1 + h1 / 2, 364, y1 + h1 / 2)}
    ${arrow(leftX + 110, y1 + h1, leftX + 110, y2 - 2)}
    ${box(leftX, y2, 240, h2, `Records screened`, [`n = ${c.screened}`])}
    ${box(300, y2, W - 304, h2 + gap + h3, `Records excluded (n = ${c.autoEx + c.manEx})`, [`By criteria: ${c.autoEx}`, `By you: ${c.manEx}`, ...exLines], "#F4DEDB", "#A9443A")}
    ${arrow(leftX + 240, y2 + h2 / 2, 298, y2 + h2 / 2)}
    ${arrow(leftX + 110, y2 + h2, leftX + 110, y3 - 2)}
    ${box(leftX, y3, 240, h3, `Assessed for eligibility`, [`n = ${c.screened - c.autoEx}`])}
    ${arrow(leftX + 240, y3 + h3 / 2, 298, y3 + h3 / 2)}
    ${arrow(leftX + 110, y3 + h3, leftX + 110, y4 - 2)}
    ${box(leftX, y4, 240, h4, `Studies included in review`, [`n = ${c.included}`], "#F2D03B")}
  </svg>`;
}

/* ---------- screening ---------- */
function renderCountsOnly() {
  const r = state.records;
  $("#c-all").textContent = `(${r.length})`;
  $("#c-inc").textContent = `(${r.filter(x => x.status === "included").length})`;
  $("#c-exc").textContent = `(${r.filter(x => x.status === "excluded").length})`;
  const nc = r.filter(x => x.conflict).length;
  $("#c-con").textContent = `(${nc})`;
  $("#conflictBtn").hidden = !teamMode();
  if (!teamMode() && state.view === "conflict") state.view = "all";
}
function visibleRecs() {
  const f = state.filter.toLowerCase();
  return state.records.filter(r => (state.view === "all" || (state.view === "conflict" ? r.conflict : r.status === state.view && !r.conflict)) &&
    (!f || (r.title + " " + r.authors.join(" ") + " " + r.venue + " " + r.abstract).toLowerCase().includes(f)));
}
function authorLine(a) { return a.length > 3 ? `${a.slice(0, 3).join(", ")} et al.` : a.join(", "); }
function recHTML(r) {
  const link = r.doi ? `https://doi.org/${r.doi}` : r.url;
  const titleHTML = link && !r.sample ? `<a href="${esc(link)}" target="_blank" rel="noopener"><span class="t">${esc(r.title)}</span></a>` : `<span class="t">${esc(r.title)}</span>`;
  return `<li class="rec ${r.status}${r.conflict ? " conflict" : ""}" data-id="${r.id}" data-sig="${rowSig(r)}">
    <div>
      <h4>${titleHTML}</h4>
      <div class="meta">${esc(authorLine(r.authors) || "Unknown authors")} (${r.year || "n.d."})${r.venue ? ". " + esc(r.venue) : ""}. ${r.noCites ? "Citations not reported" : `Cited ${r.cites}`}.</div>
      ${r.abstract ? `<p class="abs clamp">${esc(r.abstract)}</p>` : ""}
      <div class="tags">
        <span class="tag">${TYPE_LABEL(r.type)}</span>
        ${[...r.foundIn].map(s => `<span class="tag">${DB_NAMES[s]}</span>`).join("")}
        ${r.oa ? `<span class="tag oa">Open access</span>` : ""}
        ${r.sample ? `<span class="tag sample">Sample record</span>` : ""}
        ${r.status === "excluded" && r.reason ? `<span class="tag reason">${esc(r.reason)}</span>` : ""}
        ${teamTags(r)}
        ${r.abstract && r.abstract.length > 260 ? `<button type="button" class="btn ghost small" data-act="expand">Show full abstract</button>` : ""}
      </div>
    </div>
    ${decideHTML(r)}
  </li>`;
}
const rowSig = r => [r.status, r.reason, r.conflict, r.teamState, r.mine?.status, r.mine?.reason, state.role].join("|");
/** Re-render only the rows whose status changed, so focus and scroll stay put. */
function syncRows() {
  for (const li of $$("#recs .rec")) {
    const r = state.records.find(x => x.id === +li.dataset.id);
    if (r && li.dataset.sig !== rowSig(r)) li.outerHTML = recHTML(r);
  }
}
function decideHTML(r) {
  const team = teamMode();
  // In a team, the buttons show your own decision; on your own they show the record's status.
  const mine = team ? r.mine?.status : r.status;
  const myReason = team ? r.mine?.reason : r.reason;
  const showReason = team ? mine === "excluded" : r.status === "excluded" && !r.auto;
  const canResolve = team && r.conflict && state.role === "owner";
  return `<div class="decide" role="group" aria-label="${team ? "Your decision" : "Decision"} for this record">
      <button type="button" class="inc" data-act="include" aria-pressed="${mine === "included"}">Include</button>
      <button type="button" class="exc" data-act="exclude" aria-pressed="${mine === "excluded"}">Exclude</button>
      ${showReason ? `<label class="sr" for="rs${r.id}">Reason</label><select id="rs${r.id}" data-act="reason">${REASONS.map(x => `<option ${x === myReason ? "selected" : ""}>${x}</option>`).join("")}</select>` : ""}
      ${canResolve ? `<div class="resolve">Final decision</div>
        <button type="button" class="inc" data-act="resolve-inc">Include</button>
        <button type="button" class="exc" data-act="resolve-exc">Exclude</button>` : ""}
    </div>`;
}
function teamTags(r) {
  if (!teamMode()) return "";
  const out = [];
  if (r.conflict) {
    out.push(`<span class="tag conflict">Reviewers disagree</span>`);
    const c = state.team.conflicts.find(x => x.key === r.key);
    for (const d of c?.decisions || []) {
      const who = state.team.members.find(m => m.id === d.userId)?.name || "Reviewer";
      out.push(`<span class="tag vote">${esc(who)}: ${d.status === "included" ? "include" : "exclude"}${d.reason ? ` (${esc(d.reason)})` : ""}</span>`);
    }
  } else if (r.teamState === "resolved") out.push(`<span class="tag">Resolved by owner</span>`);
  else if (r.teamState === "agreed") out.push(`<span class="tag">Reviewers agree</span>`);
  if (!r.mine && !r.auto && !r.conflict) out.push(`<span class="tag pending">Not screened by you yet</span>`);
  return out.join("");
}
function renderRecs() {
  renderCountsOnly();
  const v = visibleRecs();
  $("#recs").innerHTML = v.length ? v.slice(0, state.shown).map(recHTML).join("") : `<li class="empty">No records here. ${state.filter ? "Clear the filter to see more." : ""}</li>`;
  $("#more").innerHTML = v.length > state.shown ? `<button type="button" class="btn" id="showMore">Show ${Math.min(40, v.length - state.shown)} more of ${v.length - state.shown}</button>` : "";
  $("#showMore")?.addEventListener("click", () => { state.shown += 40; renderRecs(); });
}
$("#recs").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if (!b || b.tagName === "SELECT") return;
  const li = b.closest(".rec"); const r = state.records.find(x => x.id === +li.dataset.id);
  if (b.dataset.act === "expand") { const p = li.querySelector(".abs"); const c = p.classList.toggle("clamp"); b.textContent = c ? "Show full abstract" : "Show less"; return; }
  if (b.dataset.act === "resolve-inc" || b.dataset.act === "resolve-exc") return resolveConflict(r, b.dataset.act === "resolve-inc" ? "included" : "excluded");
  const current = teamMode() ? r.mine?.status : r.status;
  if (b.dataset.act === "include") { if (current === "included" && r.mine) return; state.decisions[r.key] = {status: "included", reason: null}; }
  if (b.dataset.act === "exclude") { if (current === "excluded" && r.mine) return; state.decisions[r.key] = {status: "excluded", reason: REASONS[0]}; }
  applyStatuses();
  li.outerHTML = recHTML(r);
  const nli = $(`.rec[data-id="${r.id}"]`); nli?.querySelector(`[data-act=${b.dataset.act}]`)?.focus();
  refreshCounts();
  queueDecision(r.key);
});
$("#recs").addEventListener("change", e => {
  if (e.target.dataset.act !== "reason") return;
  const r = state.records.find(x => x.id === +e.target.closest(".rec").dataset.id);
  state.decisions[r.key] = {status: "excluded", reason: e.target.value}; applyStatuses();
  const li = e.target.closest(".rec"); li.outerHTML = recHTML(r); refreshCounts(); queueDecision(r.key);
});
$$(".seg button").forEach(b => b.onclick = () => { $$(".seg button").forEach(x => x.setAttribute("aria-pressed", x === b)); state.view = b.dataset.view; state.shown = 40; renderRecs(); });
let ft; $("#recFilter").addEventListener("input", e => { clearTimeout(ft); ft = setTimeout(() => { state.filter = e.target.value; state.shown = 40; renderRecs(); }, 150); });

/* ---------- analysis ---------- */
const TERM_STOP = new Set([...STOP, ..."results result findings finding paper article authors author data method methods approach model models using used use significant significantly however therefore thus found show shows shown provide provides important first second two three one level levels high low large small well many much both each per also among total sample participants purpose aim aims objective objectives conclusion conclusions background methodology design originality value implications limitations proposed present current recent year years paper's et al www http https doi org copyright rights reserved elsevier springer wiley taylor francis ltd inc published journal illustrative abstract stands real describes attention main work so text came interviews analysed screening term organisations draws case".split(" ")]);
function terms(recs, o) {
  const own = new Set(o.topic.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const tally = new Map();
  for (const r of recs) {
    const words = (r.title + ". " + r.abstract).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(w => w.length > 2 && !/^\d+$/.test(w));
    const seen = new Set();
    for (let i = 0; i < words.length; i++) {
      const w = words[i]; if (TERM_STOP.has(w) || own.has(w)) continue;
      seen.add(w);
      const n = words[i + 1]; if (n && !TERM_STOP.has(n) && !own.has(n) && n.length > 2) seen.add(w + " " + n);
    }
    seen.forEach(k => tally.set(k, (tally.get(k) || 0) + 1));
  }
  let list = [...tally.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || (b[0].includes(" ") - a[0].includes(" ")));
  // prefer phrases: drop single words fully covered by a phrase with the same count
  const phrases = list.filter(([k]) => k.includes(" "));
  list = list.filter(([k, n]) => k.includes(" ") || !phrases.some(([p, pn]) => pn >= n * .8 && p.split(" ").includes(k)));
  return list.slice(0, 12);
}
function barsHTML(list, max) { return list.map(([k, n]) => `<li><span class="name" title="${esc(k)}">${esc(k)}</span><span class="track"><span class="fill" style="width:${(n / max * 100).toFixed(1)}%"></span></span><span class="n">${n}</span></li>`).join(""); }
function yearData(inc, o) { const m = {}; for (let y = o.yFrom; y <= o.yTo; y++) m[y] = 0; inc.forEach(r => { if (r.year in m) m[r.year]++; }); return Object.entries(m); }
function yearSVG(data) {
  const W = 520, H = 200, pl = 30, pb = 26, pt = 10;
  const max = Math.max(1, ...data.map(d => d[1]));
  const bw = (W - pl) / data.length;
  const ticks = [0, Math.ceil(max / 2), max];
  const step = Math.ceil(data.length / 10);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Included studies per year: ${data.map(([y, n]) => `${y}: ${n}`).join(", ")}">
    ${ticks.map(t => { const y = H - pb - (t / max) * (H - pb - pt); return `<line x1="${pl}" x2="${W}" y1="${y}" y2="${y}" stroke="#CBD2DC"/><text x="${pl - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="#5E6779">${t}</text>`; }).join("")}
    ${data.map(([y, n], i) => { const h = (n / max) * (H - pb - pt); const x = pl + i * bw + bw * .18; return `<rect x="${x}" y="${H - pb - h}" width="${bw * .64}" height="${h}" fill="#2F5D8A"><title>${y}: ${n}</title></rect>${i % step === 0 ? `<text x="${x + bw * .32}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#5E6779">${y}</text>` : ""}`; }).join("")}
  </svg>`;
}
function topVenues(inc) { const m = {}; inc.forEach(r => { if (r.venue) m[r.venue] = (m[r.venue] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8); }
function renderAnalysis() {
  const c = counts(), inc = c.inc, o = state.opts;
  const oa = inc.filter(r => r.oa).length;
  const median = (() => { const s = inc.map(r => r.cites).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; })();
  $("#stats").innerHTML = [[c.included, "studies included"], [`${inc.length ? Math.round(oa / inc.length * 100) : 0}%`, "open access"], [median, "median citations"], [topVenues(inc).length ? new Set(inc.map(r => r.venue).filter(Boolean)).size : 0, "distinct venues"]]
    .map(([n, l]) => `<div class="stat"><strong>${n}</strong><span>${l}</span></div>`).join("");
  $("#yearChart").innerHTML = yearSVG(yearData(inc, o));
  const t = terms(inc, o); $("#terms").innerHTML = t.length ? barsHTML(t, t[0][1]) : `<li class="empty">Not enough text yet.</li>`;
  const v = topVenues(inc); $("#venues").innerHTML = v.length ? barsHTML(v, v[0][1]) : `<li class="empty">No venue data.</li>`;
  const top = [...inc].sort((a, b) => b.cites - a.cites).slice(0, 8);
  $("#cited").innerHTML = `<thead><tr><th>Study</th><th class="num">Cited</th></tr></thead><tbody>${top.map(r => `<tr><td>${esc(shortCite(r))}. <em>${esc(r.title)}</em></td><td class="num">${r.cites}</td></tr>`).join("")}</tbody>`;
}

/* ---------- report ---------- */
function surname(n) { const p = n.trim().split(/\s+/); return p[p.length - 1]; }
function initials(n) { const p = n.trim().split(/\s+/); return p.slice(0, -1).map(x => x[0].toUpperCase() + ".").join(" "); }
function shortCite(r) { const a = r.authors; const s = !a.length ? "Anon." : a.length === 1 ? surname(a[0]) : a.length === 2 ? `${surname(a[0])} & ${surname(a[1])}` : `${surname(a[0])} et al.`; return `${s} (${r.year || "n.d."})`; }
function apa(r) {
  const a = r.authors.slice(0, 20).map(n => `${surname(n)}, ${initials(n)}`.replace(/, $/, ""));
  const auth = a.length > 1 ? a.slice(0, -1).join(", ") + ", & " + a[a.length - 1] : (a[0] || "Anonymous");
  return `${auth} (${r.year || "n.d."}). ${r.title.replace(/\.$/, "")}.${r.venue ? ` ${r.venue}.` : ""}${r.doi ? ` https://doi.org/${r.doi}` : r.url ? ` ${r.url}` : ""}`;
}
function cap1(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function list(arr) { return arr.length < 2 ? arr.join("") : arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1]; }
function buildReport() {
  const o = state.opts, c = counts(), inc = [...c.inc].sort((a, b) => b.cites - a.cites);
  const usedDbs = state.sample ? [] : o.dbs.filter(d => !isImport(d) || state.imported[d] != null);
  const dbs = state.sample ? ["sample data"] : usedDbs.map(d => DB_NAMES[d]);
  const apiDbs = usedDbs.filter(d => ["openalex", "crossref", "europepmc", "arxiv"].includes(d)).map(d => DB_NAMES[d]);
  const pubDbs = usedDbs.filter(d => d in PUBLISHERS).map(d => DB_NAMES[d]);
  const impDbs = usedDbs.filter(d => isImport(d));
  const title = o.title || `${cap1(o.topic.replace(/[.?!]+$/, ""))}: a systematic literature review`;
  const yd = yearData(inc, o); const peak = yd.reduce((a, b) => b[1] > a[1] ? b : a, ["", 0]);
  const half = Math.floor(yd.length / 2); const early = yd.slice(0, half).reduce((s, d) => s + d[1], 0), late = yd.slice(half).reduce((s, d) => s + d[1], 0);
  const trend = late > early * 1.25 ? "rising over the period" : early > late * 1.25 ? "declining over the period" : "fairly steady over the period";
  const v = topVenues(inc); const t = terms(inc, o).slice(0, 8).map(x => x[0]);
  const oaPct = inc.length ? Math.round(inc.filter(r => r.oa).length / inc.length * 100) : 0;
  const typeNames = {article: "journal articles", conference: "conference papers", review: "reviews", preprint: "preprints", book: "books", chapter: "book chapters"};
  const S = []; // blocks: [kind, text]
  S.push(["h1", title]);
  if (state.sample) S.push(["todo", "This draft was built from sample records. Run the search on a hosted copy of Litview to produce a real review."]);
  S.push(["h2", "1. Introduction"]);
  S.push(["p", `This review systematically identifies and synthesises published research on ${o.topic.replace(/[.?!]+$/, "")}, covering work published between ${o.yFrom} and ${o.yTo}.`]);
  S.push(["todo", "Add the background: why this topic matters, what earlier reviews have found, and the gap this review fills."]);
  if (o.rqs.length) { S.push(["p", "The review addresses the following research questions:"]); S.push(["ul", o.rqs]); }
  else S.push(["todo", "State your research questions (RQ1, RQ2…). You can add them under Refine search and the draft will update."]);
  S.push(["h2", "2. Method"]);
  S.push(["p", `The review follows the PRISMA 2020 statement for reporting systematic reviews (Page et al., 2021).`]);
  S.push(["h3", "2.1 Search strategy"]);
  const when = new Date().toLocaleDateString(undefined, {day: "numeric", month: "long", year: "numeric"});
  const order = {relevance: "relevance", cited: "citation count", newest: "publication date"}[o.sort];
  if (state.sample) S.push(["p", `Sample data was searched on ${when} using the search string ${qString(o)}.`]);
  else {
    const parts = [];
    if (apiDbs.length) parts.push(`${list(apiDbs)} ${apiDbs.length > 1 ? "were" : "was"} searched through ${apiDbs.length > 1 ? "their public APIs" : "its public API"}`);
    if (pubDbs.length) parts.push(`the ${list(pubDbs)} collection${pubDbs.length > 1 ? "s were" : " was"} searched through the metadata ${pubDbs.length > 1 ? "these publishers register" : "the publisher registers"} with Crossref, filtered by DOI prefix`);
    if (parts.length) S.push(["p", `${cap1(list(parts))} on ${when}, using the search string ${qString(o)}. Up to ${o.perDb} records were retrieved from each source, ordered by ${order}.${pubDbs.length ? " Missing abstracts were retrieved from OpenAlex by DOI." : ""}`]);
    if (impDbs.length) {
      S.push(["p", `${cap1(list(impDbs.map(d => DB_NAMES[d])))} ${impDbs.length > 1 ? "were" : "was"} searched through ${impDbs.length > 1 ? "their own interfaces" : "its own interface"} with the following database-specific search strings, limited to ${o.yFrom}–${o.yTo}. The results were exported and imported for screening.`]);
      S.push(["ul", impDbs.map(d => `${DB_NAMES[d]}: ${importString(d, o)} (${state.imported[d]} records)`)]);
    }
  }
  S.push(["h3", "2.2 Eligibility criteria"]);
  const incl = [`Published between ${o.yFrom} and ${o.yTo}`, `Document type: ${o.docTypes.map(x => typeNames[x]).join(", ") || "any"}`];
  if (o.caseStudy) incl.push("Study design: case study, as stated in the title or abstract");
  if (o.english) incl.push("Written in English"); if (o.needAbstract) incl.push("Abstract available");
  if (o.oa) incl.push("Available open access"); if (o.minCites) incl.push(`Cited at least ${o.minCites} times`);
  if (o.inc.length) incl.push(`Title or abstract mentions ${list(o.inc.map(x => `“${x}”`))}`);
  S.push(["p", "Studies were included if they met all of the following criteria:"]); S.push(["ul", incl]);
  S.push(["p", o.exc.length ? `Studies were excluded if the title or abstract mentioned ${list(o.exc.map(x => `“${x}”`))}, or if on reading they did not address the topic.` : "Studies were excluded if on reading the title and abstract they did not address the topic."]);
  S.push(["h3", "2.3 Study selection"]);
  S.push(["p", `Records from all sources were merged and duplicates removed by DOI and normalised title. The remaining records were screened against the eligibility criteria, first automatically and then by reading titles and abstracts. Reasons for every exclusion were recorded.`]);
  if (teamMode()) {
    const names = state.team.members.map(m => m.name);
    S.push(["p", `Titles and abstracts were screened independently by ${names.length} reviewers (${list(names)}), who could not see each other's decisions.${agreementText() ? " " + agreementText() + "." : ""} Disagreements were resolved by the review owner.`]);
    const open = state.records.filter(x => x.conflict).length;
    if (open) S.push(["todo", `${open} record${open > 1 ? "s" : ""} still ${open > 1 ? "have" : "has"} conflicting decisions. Resolve ${open > 1 ? "them" : "it"} in the Screening tab under Conflicts.`]);
  }
  if (state.synthesis) {
    S.push(["h3", "2.4 Synthesis"]);
    S.push(["p", `A first draft of the thematic synthesis was produced with an AI model (${state.synthesis.model}) from the titles and abstracts of the included studies, then checked against the full texts by the review team.`]);
  }
  S.push(["h2", "3. Results"]);
  S.push(["h3", "3.1 Study selection"]);
  S.push(["p", `The search identified ${c.identified} records. After removing ${c.dupes} duplicates, ${c.screened} records were screened. ${c.autoEx} were excluded for not meeting the eligibility criteria and ${c.manEx} were excluded after reading the title and abstract, leaving ${c.included} studies in the review (Figure 1).`]);
  S.push(["figure", "prisma"]);
  if (inc.length) {
    S.push(["h3", "3.2 Characteristics of included studies"]);
    S.push(["p", `Publication output was ${trend}${peak[1] ? `, peaking in ${peak[0]} with ${peak[1]} ${peak[1] === 1 ? "study" : "studies"}` : ""} (Figure 2). ${oaPct}% of the included studies are open access.${v.length ? ` The most frequent venues were ${list(v.slice(0, 3).map(([n, k]) => `${n} (${k})`))}.` : ""}`]);
    S.push(["figure", "years"]);
    S.push(["p", `The most cited included studies are ${list(inc.slice(0, 3).map(r => `${shortCite(r)}, cited ${r.cites} times`))}.`]);
    if (t.length) {
      S.push(["h3", "3.3 Recurring themes"]);
      S.push(["p", `The terms appearing most often across titles and abstracts were ${list(t.map(x => `“${x}”`))}. These suggest candidate themes for the synthesis.`]);
    }
    if (state.synthesis) {
      S.push(["h3", `3.${t.length ? 4 : 3} Themes`]);
      S.push(["ainote", `AI-assisted draft based on the titles and abstracts of ${state.synthesis.basedOn} included studies. Check every statement against the full texts before you use it.`]);
      for (const th of state.synthesis.themes) { S.push(["h4", th.name]); S.push(["ai", th.summary]); }
    } else S.push(["todo", "Read the included studies and group them into themes. For each theme, summarise what the studies found, where they agree and where they conflict, citing each study."]);
  }
  S.push(["h2", "4. Discussion"]);
  if (state.synthesis) {
    String(state.synthesis.discussion || "").split(/\n\s*\n/).filter(Boolean).forEach(p => S.push(["ai", p]));
    if (state.synthesis.gaps?.length) { S.push(["p", "Gaps identified in the literature:"]); S.push(["ul", state.synthesis.gaps.map(citeText)]); }
  } else S.push(["todo", "Interpret the findings against your research questions, compare them with earlier reviews, and set out the gaps and a research agenda."]);
  S.push(["h3", "4.1 Limitations"]);
  S.push(["p", `The search was limited to ${list(dbs)}${o.english ? " and to English-language publications" : ""}, so relevant studies indexed elsewhere may have been missed. Screening was carried out on titles and abstracts${pubDbs.length ? ", and some publisher records lacked an abstract in the open metadata" : ""}.`]);
  S.push(["h2", "5. Conclusion"]);
  if (state.synthesis?.conclusion) S.push(["ai", state.synthesis.conclusion]);
  else S.push(["todo", "Summarise the answer to each research question in two or three sentences, and the main implications for research and practice."]);
  S.push(["h2", "References"]);
  S.push(["refs", ["Page, M. J., McKenzie, J. E., Bossuyt, P. M., et al. (2021). The PRISMA 2020 statement: An updated guideline for reporting systematic reviews. BMJ, 372, n71. https://doi.org/10.1136/bmj.n71", ...[...inc].sort((a, b) => surname(a.authors[0] || "z").localeCompare(surname(b.authors[0] || "z"))).map(apa)]]);
  return S;
}
function renderReport() {
  const S = buildReport(); let fig = 0;
  $("#doc").innerHTML = S.map(([k, v]) => {
    if (k === "h1") return `<h1>${esc(v)}</h1>`;
    if (k === "h2" || k === "h3") return `<${k}>${esc(v)}</${k}>`;
    if (k === "p") return `<p>${esc(v)}</p>`;
    if (k === "todo") return `<p class="todo">${esc(v)}</p>`;
    if (k === "h4") return `<h3 style="font-size:1rem">${esc(v)}</h3>`;
    if (k === "ai") return `<p class="ai">${esc(citeText(v))}</p>`;
    if (k === "ainote") return `<p class="ainote">${esc(v)}</p>`;
    if (k === "ul") return `<ul>${v.map(x => `<li>${esc(x)}</li>`).join("")}</ul>`;
    if (k === "refs") return `<ol class="refs">${v.map(x => `<li>${esc(x)}</li>`).join("")}</ol>`;
    if (k === "figure") { fig++; return v === "prisma" ? `<figure class="figure">${$("#prisma").innerHTML}<figcaption>Figure ${fig}. PRISMA 2020 flow diagram of study selection.</figcaption></figure>` : `<figure class="figure">${$("#yearChart").innerHTML}<figcaption>Figure ${fig}. Included studies by publication year.</figcaption></figure>`; }
    return "";
  }).join("");
}
function reportMarkdown() {
  const c = counts(); let fig = 0;
  return buildReport().map(([k, v]) => {
    if (k === "h1") return `# ${v}`; if (k === "h2") return `## ${v}`; if (k === "h3") return `### ${v}`;
    if (k === "p") return v; if (k === "todo") return `> **To do:** ${v}`;
    if (k === "h4") return `#### ${v}`; if (k === "ai") return citeText(v); if (k === "ainote") return `> **Note:** ${v}`;
    if (k === "ul") return v.map(x => `- ${x}`).join("\n");
    if (k === "refs") return v.map((x, i) => `${i + 1}. ${x}`).join("\n");
    if (k === "figure") { fig++; return v === "prisma"
      ? `**Figure ${fig}. PRISMA 2020 flow diagram**\n\n| Stage | n |\n|---|---|\n${Object.entries(state.identified).map(([d, n]) => `| Identified in ${DB_NAMES[d]} | ${n} |`).join("\n")}\n| Duplicates removed | ${c.dupes} |\n| Records screened | ${c.screened} |\n| Excluded by criteria | ${c.autoEx} |\n| Excluded after reading | ${c.manEx} |\n| **Included** | **${c.included}** |`
      : `**Figure ${fig}. Included studies by year**\n\n| Year | Studies |\n|---|---|\n${yearData(c.inc, state.opts).map(([y, n]) => `| ${y} | ${n} |`).join("\n")}`; }
    return "";
  }).join("\n\n");
}

/* ---------- exports ---------- */
function bibtex() {
  return counts().inc.map((r, i) => {
    const key = (surname(r.authors[0] || "anon").toLowerCase().replace(/[^a-z]/g, "") || "anon") + (r.year || "") + normTitle(r.title).split(" ").find(w => w.length > 3 && !STOP.has(w)) ;
    const f = [["title", `{${r.title}}`], ["author", r.authors.join(" and ")], ["year", r.year], [r.type === "proceedings-article" || r.type === "book-chapter" ? "booktitle" : isBook(r.type) ? "publisher" : "journal", r.venue], ["doi", r.doi], ["url", r.doi ? "" : r.url]].filter(([, v]) => v);
    return `@${r.type === "proceedings-article" ? "inproceedings" : r.type === "book-chapter" ? "incollection" : isBook(r.type) ? "book" : /preprint|posted-content/.test(r.type) ? "misc" : "article"}{${key},\n${f.map(([k, v]) => `  ${k} = {${String(v).replace(/[{}]/g, m => m === "{" && k === "title" ? m : m)}}`).join(",\n")}\n}`;
  }).join("\n\n");
}
function ris() {
  return counts().inc.map(r => [`TY  - ${r.type === "proceedings-article" ? "CPAPER" : r.type === "book-chapter" ? "CHAP" : isBook(r.type) ? "BOOK" : "JOUR"}`, ...r.authors.map(a => `AU  - ${surname(a)}, ${a.split(/\s+/).slice(0, -1).join(" ")}`), `TI  - ${r.title}`, r.year && `PY  - ${r.year}`, r.venue && `JO  - ${r.venue}`, r.doi && `DO  - ${r.doi}`, r.abstract && `AB  - ${r.abstract}`, "ER  - "].filter(Boolean).join("\n")).join("\n\n");
}
function csv() {
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Decision", "Reason", "Title", "Authors", "Year", "Venue", "DOI", "Citations", "Open access", "Found in", "Abstract"];
  return [head.join(","), ...state.records.map(r => [r.status, r.reason || "", r.title, r.authors.join("; "), r.year, r.venue, r.doi, r.cites, r.oa ? "yes" : "no", [...r.foundIn].map(s => DB_NAMES[s]).join("; "), r.abstract].map(q).join(","))].join("\n");
}
const EXPORTS = {md: [reportMarkdown, "text/markdown", "md"], bib: [bibtex, "application/x-bibtex", "bib"], ris: [ris, "application/x-research-info-systems", "ris"], csv: [csv, "text/csv", "csv"]};
const slug = () => (state.opts.title || state.opts.topic).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50).replace(/^-|-$/g, "") || "review";
$$("[data-export]").forEach(b => b.onclick = () => {
  const [fn, type, ext] = EXPORTS[b.dataset.export];
  try {
    const url = URL.createObjectURL(new Blob([fn()], {type}));
    const a = Object.assign(document.createElement("a"), {href: url, download: `${slug()}.${ext}`});
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Downloaded ${slug()}.${ext}`);
  } catch { toast("Downloads are blocked here. Use Copy instead."); }
});
$$("[data-copy]").forEach(b => b.onclick = async () => {
  try { await navigator.clipboard.writeText(EXPORTS[b.dataset.copy][0]()); toast(b.dataset.copy === "md" ? "Report copied as Markdown" : "BibTeX copied"); }
  catch { toast("Copying is blocked here. Use Download instead."); }
});

let tt; function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => t.classList.remove("show"), 2600); }

/* =====================================================================
   Accounts, saved reviews, team screening and AI synthesis.
   Only active when the page is configured with a Litview API address.
   ===================================================================== */

const fmtDate = d => new Date(d).toLocaleDateString(undefined, {day: "numeric", month: "short", year: "numeric"});
const clip = (s, n) => (s || "").length > n ? s.slice(0, n) : s || "";

function sourcePayload(db) {
  const items = (state.raw[db] || []).map(r => ({...r, title: clip(r.title, 2000), abstract: clip(r.abstract, 20000), authors: (r.authors || []).slice(0, 100), venue: clip(r.venue, 500)}));
  return { items, total: state.totals[db] ?? items.length, url: state.urls?.[db] || null, imported: state.imported[db] != null };
}

function setHash(id) { try { history.replaceState(null, "", id ? `#r-${id}` : location.pathname + location.search); } catch { /* sandboxed */ } }

function detachReview() {
  flushDecisions();
  Object.assign(state, { reviewId: null, review: null, role: null, team: null, synthesis: null });
  setHash(null);
}

function agreementText() {
  const a = state.team?.agreement?.[0];
  if (!a || a.kappa == null) return "";
  const name = id => state.team.members.find(m => m.id === id)?.name || "a reviewer";
  return `Agreement between ${name(a.a)} and ${name(a.b)} on ${a.n} records was κ = ${a.kappa.toFixed(2)} (${a.label}), with ${Math.round(a.agreement * 100)}% raw agreement`;
}

/** Turn [S1, S3] markers from the AI draft into (Author, Year) citations. */
function citeText(text) {
  const ids = state.synthesis?.studyIds || {};
  return String(text || "").replace(/\[(S\d+(?:\s*,\s*S\d+)*)\]/g, (_, list) => {
    const cites = list.split(/\s*,\s*/).map(id => state.records.find(x => x.key === ids[id])).filter(Boolean)
      .map(r => shortCite(r).replace(/ \((.+)\)$/, ", $1"));
    return cites.length ? `(${cites.join("; ")})` : "";
  });
}

/* ---------- saving decisions ---------- */
const pending = new Set(); let saveTimer = null;
function queueDecision(key) {
  if (!state.reviewId) return;
  pending.add(key);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDecisions, 500);
}
async function flushDecisions() {
  clearTimeout(saveTimer);
  if (!state.reviewId || !pending.size) return;
  const id = state.reviewId;
  const decisions = [...pending].map(k => ({ key: k, ...state.decisions[k] })).filter(d => d.status);
  pending.clear();
  setSaveState("Saving…");
  try {
    const sc = await Api.putDecisions(id, decisions);
    if (state.reviewId !== id) return;
    applyTeam(sc);
    setSaveState("All changes saved", true);
  } catch (e) {
    decisions.forEach(d => pending.add(d.key));
    setSaveState(`Not saved: ${e.message}`);
  }
}
function applyTeam(sc) {
  const wasTeam = teamMode();
  state.team = sc;
  for (const [k, v] of Object.entries(sc.mine || {})) if (!pending.has(k)) state.decisions[k] = v;
  applyStatuses();
  if (wasTeam !== teamMode()) renderRecs(); else syncRows();
  refreshCounts(); renderReviewBar();
}
async function resolveConflict(r, status) {
  const c = state.team.conflicts.find(x => x.key === r.key);
  const reason = status === "excluded" ? (c?.decisions.find(d => d.status === "excluded")?.reason || REASONS[0]) : null;
  try { applyTeam(await Api.resolve(state.reviewId, { key: r.key, status, reason })); toast(status === "included" ? "Included as the final decision" : "Excluded as the final decision"); }
  catch (e) { toast(e.message); }
}
// Pick up colleagues' decisions while the page is open.
setInterval(async () => {
  if (!state.reviewId || !teamMode() || document.visibilityState !== "visible" || pending.size) return;
  try { applyTeam(await Api.screening(state.reviewId)); } catch { /* try again next time */ }
}, 20000);
addEventListener("beforeunload", () => { if (pending.size) flushDecisions(); });

/* ---------- review bar ---------- */
let saveState = { text: "", ok: false };
function setSaveState(text, ok = false) { saveState = { text, ok }; const el = $("#reviewbar .rstate"); if (el) { el.textContent = text; el.classList.toggle("ok", ok); } }
function renderReviewBar() {
  const bar = $("#reviewbar");
  if (!Api.enabled || !state.opts) { bar.hidden = true; return; }
  bar.hidden = false;
  const title = state.review?.title || state.opts.title || state.opts.topic;
  let st, acts;
  if (!state.reviewId) {
    st = Api.signedIn ? "Not saved yet" : "Sign in to save this review and screen it with a colleague";
    acts = Api.signedIn ? `<button type="button" class="btn primary small" data-bar="save">Save review</button>` : `<button type="button" class="btn primary small" data-bar="signin">Sign in to save</button>`;
  } else {
    const n = state.team?.members.length || 1;
    st = saveState.text || (n > 1 ? `Shared with ${n - 1} other reviewer${n > 2 ? "s" : ""}. Your decisions save automatically.` : "Saved to your account. Decisions save automatically.");
    acts = `<button type="button" class="btn small" data-bar="team">${n > 1 ? `Team (${n})` : "Invite a reviewer"}</button><button type="button" class="btn ghost small" data-bar="reviews">My reviews</button>`;
  }
  bar.innerHTML = `<div><p class="rtitle">${esc(title)}</p><span class="rstate${saveState.ok ? " ok" : ""}">${esc(st)}</span></div><div class="acts">${acts}</div>`;
}
$("#reviewbar").addEventListener("click", e => {
  const b = e.target.closest("[data-bar]"); if (!b) return;
  ({ save: saveReview, signin: () => openAuth("signin", saveReview), team: openTeam, reviews: openReviews })[b.dataset.bar]();
});

async function saveReview() {
  if (!Api.signedIn) return openAuth("signin", saveReview);
  if (state.reviewId) return;
  setSaveState("Saving…");
  try {
    const o = state.opts;
    const { id } = await Api.createReview({ title: clip(o.title || o.topic, 300), topic: clip(o.topic, 1000), opts: o,
      sources: Object.fromEntries(Object.keys(state.raw).map(db => [db, sourcePayload(db)])) });
    state.reviewId = id; state.role = "owner"; state.review = { id, title: o.title || o.topic };
    const mine = Object.entries(state.decisions).map(([key, d]) => ({ key, ...d }));
    for (let i = 0; i < mine.length; i += 1000) await Api.putDecisions(id, mine.slice(i, i + 1000));
    state.team = await Api.screening(id);
    setHash(id);
    setSaveState("Saved to your account", true);
    renderAll();
    toast("Review saved");
  } catch (e) { setSaveState(`Not saved: ${e.message}`); renderReviewBar(); toast(e.message); }
}

async function loadReview(id) {
  const st = $("#status");
  st.innerHTML = `<div class="line"><span class="dot busy"></span><strong>Opening review</strong><span>Loading records and decisions…</span></div>`;
  try {
    const data = await Api.getReview(id);
    flushDecisions(); pending.clear();
    const o = data.review.opts;
    applyOpts(o);
    Object.assign(state, {
      opts: readOpts(), reviewId: data.review.id, review: data.review, role: data.role, synthesis: data.review.synthesis || null,
      raw: Object.fromEntries(Object.entries(data.sources).map(([k, v]) => [k, v.items])),
      totals: Object.fromEntries(Object.entries(data.sources).map(([k, v]) => [k, v.total])),
      urls: Object.fromEntries(Object.entries(data.sources).map(([k, v]) => [k, v.url])),
      imported: Object.fromEntries(Object.entries(data.sources).filter(([, v]) => v.imported).map(([k, v]) => [k, v.items.length])),
      decisions: data.screening.mine, team: data.screening,
    });
    state.sample = Object.values(state.raw).flat().some(r => r.sample);
    saveState = { text: "", ok: false };
    rebuild(); setHash(id);
    st.innerHTML = state.sample ? `<div class="notice sample"><p>This review uses sample records.</p></div>` : "";
    showWorkspace();
  } catch (e) {
    st.innerHTML = `<div class="notice"><p><strong>Couldn't open that review.</strong> ${esc(e.message)}</p></div>`;
    setHash(null);
  }
}

/* ---------- AI synthesis ---------- */
function renderAiBox() {
  const box = $("#aibox");
  if (!Api.enabled || !Api.capabilities?.ai || !state.opts) { box.hidden = true; return; }
  box.hidden = false;
  const inc = counts().inc.filter(r => !r.sample);
  if (state.synthesis) {
    const s = state.synthesis;
    box.innerHTML = `<p><strong>AI draft added to sections 3, 4 and 5.</strong> Based on ${s.basedOn} studies, drafted ${fmtDate(s.generatedAt)}. Check every statement against the full texts.</p>
      <div class="acts"><button type="button" class="btn small" data-ai="run">Redraft</button><button type="button" class="btn ghost small" data-ai="clear">Remove draft</button></div>`;
  } else {
    box.innerHTML = `<p><strong>Draft the synthesis with AI.</strong> Litview sends the titles and abstracts of your ${inc.length} included studies and drafts themes, a discussion, gaps and a conclusion, citing only those studies.</p>
      <div class="acts"><button type="button" class="btn primary small" data-ai="run" ${inc.length ? "" : "disabled"}>Draft synthesis</button></div>`;
  }
}
$("#aibox").addEventListener("click", async e => {
  const b = e.target.closest("[data-ai]"); if (!b) return;
  if (b.dataset.ai === "clear") {
    try { await Api.clearSynthesis(state.reviewId); state.synthesis = null; renderAiBox(); renderReport(); } catch (err) { toast(err.message); }
    return;
  }
  if (!Api.signedIn) return openAuth("signin", () => $("#aibox [data-ai=run]")?.click());
  if (!state.reviewId) { await saveReview(); if (!state.reviewId) return; }
  const keys = counts().inc.filter(r => !r.sample).map(r => r.key);
  if (!keys.length) return toast(state.sample ? "AI drafting needs real records, not sample data." : "Include at least one study first.");
  b.disabled = true; b.textContent = "Drafting… this takes about a minute";
  try {
    await flushDecisions();
    const { synthesis } = await Api.synthesise(state.reviewId, keys, state.opts.rqs);
    state.synthesis = synthesis;
    renderAiBox(); renderReport();
    toast("Synthesis drafted");
  } catch (err) { toast(err.message); renderAiBox(); }
});

/* ---------- dialogs ---------- */
$$(".dlg").forEach(d => {
  d.addEventListener("click", e => { if (e.target === d || e.target.closest(".dlg-close")) d.close(); });
});
const authDlg = $("#authDialog");
let authMode = "signin", afterAuth = null;
function openAuth(mode = "signin", then = null) {
  authMode = mode; afterAuth = then;
  const up = mode === "signup";
  $("#authTitle").textContent = up ? "Create your account" : "Sign in";
  $("#authSubmit").textContent = up ? "Create account" : "Sign in";
  $("#authSwitch").textContent = up ? "I already have an account" : "Create an account";
  $("#nameField").hidden = !up; $("#passHint").hidden = !up;
  $("#authPass").autocomplete = up ? "new-password" : "current-password";
  $("#authErr").textContent = "";
  renderSocial(up);
  if (!authDlg.open) authDlg.showModal();
  (up ? $("#authName") : $("#authEmail")).focus();
}
$("#authSwitch").onclick = () => openAuth(authMode === "signin" ? "signup" : "signin", afterAuth);
$("#authForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#authEmail").value.trim(), pass = $("#authPass").value, name = $("#authName").value.trim();
  const err = $("#authErr");
  if (authMode === "signup" && !name) { err.textContent = "Enter your name."; return; }
  if (!email || !pass) { err.textContent = "Enter your email and password."; return; }
  const btn = $("#authSubmit"); btn.disabled = true;
  try {
    if (authMode === "signup") await Api.register(name, email, pass); else await Api.login(email, pass);
    authDlg.close(); $("#authPass").value = "";
    toast(`Signed in as ${Api.user.name}`);
    const next = afterAuth; afterAuth = null; next?.();
  } catch (x) { err.textContent = x.message; }
  finally { btn.disabled = false; }
});

/* ---------- sign in with Google, Facebook, X or LinkedIn ---------- */
const SOCIAL = { google: "Google", facebook: "Facebook", x: "X", linkedin: "LinkedIn" };
function renderSocial(signup) {
  const list = (Api.capabilities?.oauth || []).filter(p => SOCIAL[p]);
  $("#socialBox").hidden = !list.length;
  $("#socialBtns").innerHTML = list.map(p => `<button type="button" class="btn" data-social="${p}">${signup ? "Sign up" : "Continue"} with ${SOCIAL[p]}</button>`).join("");
}
$("#socialBtns").addEventListener("click", e => {
  const b = e.target.closest("[data-social]"); if (!b) return;
  const done = new URL("oauth.html", location.href);
  done.hash = "";
  // Sign in in a pop-up so an unsaved search isn't lost; fall back to a full redirect if pop-ups are blocked.
  const popupUrl = new URL(done); popupUrl.search = "?popup=1";
  const w = window.open(Api.oauthStartUrl(b.dataset.social, popupUrl.href), "litview-oauth", "width=520,height=700");
  if (w) { $("#authErr").textContent = ""; b.textContent = `Waiting for ${SOCIAL[b.dataset.social]}…`; return; }
  try { sessionStorage.setItem("litview.returnTo", location.href); } catch { /* storage unavailable */ }
  location.href = Api.oauthStartUrl(b.dataset.social, done.href);
});
const seenCodes = new Set();
async function finishSocial(result) {
  if (!result || (Date.now() - (result.at || 0)) > 5 * 60 * 1000) return;
  if (result.error) { renderSocial(authMode === "signup"); $("#authErr").textContent = result.error; if (!authDlg.open) { openAuth("signin", afterAuth); $("#authErr").textContent = result.error; } return; }
  if (!result.code || seenCodes.has(result.code)) return;
  seenCodes.add(result.code);
  try {
    await Api.oauthExchange(result.code);
    if (authDlg.open) authDlg.close();
    toast(`Signed in as ${Api.user.name}`);
    const next = afterAuth; afterAuth = null; next?.();
  } catch (x) { if (!Api.signedIn) { openAuth("signin"); $("#authErr").textContent = x.message; } }
}
try { new BroadcastChannel("litview-auth").onmessage = e => finishSocial(e.data); } catch { /* older browsers use the storage event */ }
addEventListener("storage", e => {
  if (e.key !== "litview.oauthResult" || !e.newValue) return;
  try { localStorage.removeItem("litview.oauthResult"); finishSocial(JSON.parse(e.newValue)); } catch { /* ignore */ }
});

function renderAccount() {
  const el = $("#account");
  if (!Api.enabled) { el.innerHTML = ""; return; }
  el.innerHTML = Api.signedIn
    ? `<span class="who">${esc(Api.user.name)}</span><button type="button" class="btn small" data-acc="reviews">My reviews</button><button type="button" class="btn ghost small" data-acc="signout">Sign out</button>`
    : `<button type="button" class="btn small" data-acc="signin">Sign in</button>`;
}
$("#account").addEventListener("click", e => {
  const b = e.target.closest("[data-acc]"); if (!b) return;
  if (b.dataset.acc === "signin") openAuth("signin");
  if (b.dataset.acc === "reviews") openReviews();
  if (b.dataset.acc === "signout") { flushDecisions(); Api.signOut(); detachReview(); if (state.opts) renderAll(); toast("Signed out"); }
});
document.addEventListener("litview:session", () => { renderAccount(); if (state.opts) { renderReviewBar(); renderAiBox(); } });

const reviewsDlg = $("#reviewsDialog");
async function openReviews() {
  if (!Api.signedIn) return openAuth("signin", openReviews);
  $("#joinErr").textContent = "";
  $("#reviewsList").innerHTML = `<p class="hint">Loading…</p>`;
  if (!reviewsDlg.open) reviewsDlg.showModal();
  try {
    const { reviews } = await Api.listReviews();
    $("#reviewsList").innerHTML = reviews.length ? reviews.map(r => `<div class="ritem" data-id="${r.id}">
        <div><h3>${esc(r.title)}</h3><div class="meta">${r.records} records, ${r.members} reviewer${r.members > 1 ? "s" : ""}, updated ${fmtDate(r.updatedAt)}${r.role === "reviewer" ? ". Shared with you" : ""}</div></div>
        <div class="acts"><button type="button" class="btn small primary" data-rv="open">Open</button>${r.role === "owner" ? `<button type="button" class="btn small ghost" data-rv="delete">Delete</button>` : `<button type="button" class="btn small ghost" data-rv="leave">Leave</button>`}</div>
      </div>`).join("") : `<p class="hint">No saved reviews yet. Run a search, then choose Save review.</p>`;
  } catch (e) { $("#reviewsList").innerHTML = `<p class="formerr">${esc(e.message)}</p>`; }
}
$("#reviewsList").addEventListener("click", async e => {
  const b = e.target.closest("[data-rv]"); if (!b) return;
  const id = b.closest(".ritem").dataset.id;
  if (b.dataset.rv === "open") { reviewsDlg.close(); return loadReview(id); }
  // Two-step confirm inside the page, since browser confirm() dialogs are blocked in some embeds.
  if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = b.dataset.rv === "delete" ? "Delete for everyone?" : "Leave this review?"; b.classList.remove("ghost"); return; }
  try {
    if (b.dataset.rv === "delete") await Api.deleteReview(id); else await Api.removeMember(id, Api.user.id);
    if (state.reviewId === id) { detachReview(); if (state.opts) renderAll(); }
    openReviews();
  } catch (x) { toast(x.message); }
});
$("#joinForm").addEventListener("submit", async e => {
  e.preventDefault();
  const code = $("#joinCode").value.trim();
  if (!code) { $("#joinErr").textContent = "Enter the invite code you were given."; return; }
  try { const r = await Api.join(code); $("#joinCode").value = ""; reviewsDlg.close(); toast(`Joined “${r.title}”`); loadReview(r.id); }
  catch (x) { $("#joinErr").textContent = x.message; }
});

const teamDlg = $("#teamDialog");
function renderTeam() {
  const owner = state.role === "owner";
  const t = state.team || { members: [] };
  const code = state.review?.inviteCode;
  $("#teamBody").innerHTML = `
    <p class="sub">Everyone screens the same records without seeing each other's decisions. When reviewers disagree, the record goes to Conflicts for the owner to decide.</p>
    <ul class="members">${t.members.map(m => `<li><span><strong>${esc(m.name)}</strong>${m.id === Api.user?.id ? " (you)" : ""}<br><span class="meta">${m.role === "owner" ? "Owner" : "Reviewer"}, ${m.decisions} decisions</span></span>
      ${owner && m.role !== "owner" ? `<button type="button" class="btn small ghost" data-tm="remove" data-uid="${m.id}">Remove</button>` : ""}</li>`).join("")}</ul>
    ${agreementText() ? `<p>${esc(agreementText())}.</p>` : ""}
    ${owner ? (code
      ? `<p class="flabel">Invite code</p><p><span class="code">${esc(code)}</span> <button type="button" class="btn small" data-tm="copy">Copy</button> <button type="button" class="btn small ghost" data-tm="new">New code</button></p>
         <p class="hint">Your colleague signs in to Litview, opens My reviews and enters this code. Anyone with the code can join, so share it privately.</p>`
      : `<p><button type="button" class="btn primary" data-tm="new">Create invite code</button></p>`)
      : `<p><button type="button" class="btn ghost" data-tm="leave">Leave this review</button></p>`}`;
}
async function openTeam() {
  if (!state.reviewId) return;
  renderTeam(); if (!teamDlg.open) teamDlg.showModal();
  try { applyTeam(await Api.screening(state.reviewId)); renderTeam(); } catch { /* keep what we have */ }
}
$("#teamBody").addEventListener("click", async e => {
  const b = e.target.closest("[data-tm]"); if (!b) return;
  try {
    if (b.dataset.tm === "new") { const { inviteCode } = await Api.invite(state.reviewId); state.review.inviteCode = inviteCode; renderTeam(); }
    if (b.dataset.tm === "copy") { try { await navigator.clipboard.writeText(state.review.inviteCode); toast("Invite code copied"); } catch { toast("Copying is blocked here. Select the code and copy it."); } }
    if (b.dataset.tm === "remove") { await Api.removeMember(state.reviewId, b.dataset.uid); applyTeam(await Api.screening(state.reviewId)); renderTeam(); }
    if (b.dataset.tm === "leave") { await Api.removeMember(state.reviewId, Api.user.id); teamDlg.close(); detachReview(); if (state.opts) renderAll(); toast("You left the review"); }
  } catch (x) { toast(x.message); }
});

/* ---------- start-up ---------- */
function applyCapabilities() {
  const scopus = $("input[name=db][value=scopus]")?.closest("label");
  if (scopus && keyed("scopus") && !scopus.querySelector("small")) scopus.querySelector("span").insertAdjacentHTML("beforeend", "<small>Searched automatically with the server's API key</small>");
}
async function startCloud() {
  renderAccount();
  if (!Api.enabled) return;
  await Promise.all([Api.loadCapabilities(), Api.checkSession()]);
  applyCapabilities(); renderAccount();
  try {
    const pendingLogin = sessionStorage.getItem("litview.oauthResult");
    if (pendingLogin) { sessionStorage.removeItem("litview.oauthResult"); sessionStorage.removeItem("litview.returnTo"); await finishSocial(JSON.parse(pendingLogin)); }
  } catch { /* storage unavailable */ }
  const m = location.hash.match(/^#r-([0-9a-f-]{36})$/);
  if (m) { if (Api.signedIn) loadReview(m[1]); else openAuth("signin", () => loadReview(m[1])); }
}
startCloud();

topic.focus();
})();
