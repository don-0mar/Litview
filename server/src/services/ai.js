// AI-assisted synthesis using the Anthropic Messages API.
// The model only sees titles and abstracts of the studies the team included, must cite them
// by their IDs, and every citation is checked against that list before anything is returned.

import { HttpError } from "../lib/http.js";

const SYSTEM = `You help researchers draft the synthesis section of a systematic literature review.
Rules:
- Use only the studies provided. Never mention or invent other studies, authors, figures or findings.
- Each study comes with either its abstract ("source": "abstract") or excerpts from its full text ("source": "full text"). Where you only have an abstract, describe what the study reports without claiming details it doesn't give. Where you have full text, you may draw on its methods, findings and limitations. Do not overstate certainty either way.
- Cite studies with their IDs in square brackets, e.g. [S3] or [S3, S7]. Every claim about the literature needs a citation.
- Group the studies into 3 to 6 themes that answer the research questions where possible.
- Write in a neutral academic register, in British or American English consistently, without bullet points inside the prose.
- Respond with JSON only, no other text, matching:
{"themes":[{"name":string,"summary":string,"studies":[string]}],"discussion":string,"gaps":[string],"conclusion":string}`;

// How much text the model sees: full-text studies share a budget; abstract-only studies get 1,200 characters each.
const TOTAL_FULLTEXT_CHARS = 360000, MIN_EXCERPT = 2000, MAX_EXCERPT = 9000;

/** The parts of a full text that say most: the opening (abstract, aims, method) and the findings and discussion, without the reference list. */
export function excerpt(text, size) {
  let body = text;
  const refs = [...body.matchAll(/\n\s*(references|bibliography|reference list)\s*\n/gi)].pop();
  if (refs && refs.index > body.length * 0.4) body = body.slice(0, refs.index);
  if (body.length <= size) return body;
  const findings = body.slice(Math.floor(body.length * 0.25)).search(/\n\s*(?:\d+(?:\.\d+)*\.?\s+)?(results|findings|discussion)\b/i);
  const head = Math.floor(size * 0.4);
  if (findings < 0) return body.slice(0, head) + " … " + body.slice(-(size - head));
  const at = Math.floor(body.length * 0.25) + findings;
  return body.slice(0, head) + " … " + body.slice(at, at + (size - head));
}

function buildPrompt({ topic, rqs, studies }) {
  const nFull = studies.filter(s => s.fullText).length;
  const per = nFull ? Math.max(MIN_EXCERPT, Math.min(MAX_EXCERPT, Math.floor(TOTAL_FULLTEXT_CHARS / nFull))) : 0;
  const list = studies.map(s => ({
    id: s.id, title: s.title, year: s.year, authors: s.authors.slice(0, 3).join(", ") + (s.authors.length > 3 ? " et al." : ""),
    venue: s.venue,
    ...(s.fullText ? { source: "full text", text: excerpt(s.fullText, per) } : { source: "abstract", text: (s.abstract || "").slice(0, 1200) }),
  }));
  return `Review topic: ${topic}
${rqs.length ? `Research questions:\n${rqs.map(q => `- ${q}`).join("\n")}\n` : ""}
Included studies (${list.length}):
${JSON.stringify(list)}

Write the themes, a discussion (2 to 4 paragraphs separated by blank lines), research gaps (3 to 6 short items) and a conclusion (one paragraph).`;
}

function extractJson(text) {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new HttpError(502, "The AI answer could not be read. Try again.");
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch { throw new HttpError(502, "The AI answer could not be read. Try again."); }
}

/** Remove citations to IDs that aren't in the study list. */
function scrub(text, valid) {
  return String(text || "").replace(/\[(S\d+(?:\s*,\s*S\d+)*)\]/g, (_, ids) => {
    const keep = ids.split(/\s*,\s*/).filter(id => valid.has(id));
    return keep.length ? `[${keep.join(", ")}]` : "";
  }).replace(/\s+([.,;])/g, "$1").trim();
}

export async function synthesise({ topic, rqs = [], records }, ctx) {
  const { config } = ctx;
  if (!config.keys.anthropic) throw new HttpError(503, "AI synthesis isn't set up on this server.");
  if (!records.length) throw new HttpError(400, "Include at least one study before drafting a synthesis.");

  // Over the limit, keep the client's own documents first, then the most cited studies.
  const usable = records.filter(r => r.fullText || r.abstract || r.title);
  const chosen = [...usable].sort((a, b) => (!!b.fullText - !!a.fullText) || (b.cites || 0) - (a.cites || 0)).slice(0, config.aiMaxStudies);
  const studies = chosen.map((r, i) => ({ ...r, id: `S${i + 1}` }));
  const valid = new Set(studies.map(s => s.id));

  const res = await ctx.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.keys.anthropic, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: config.aiModel, max_tokens: 6000, system: SYSTEM,
      messages: [{ role: "user", content: buildPrompt({ topic, rqs, studies }) }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    ctx.log?.(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
    throw new HttpError(502, res.status === 429 ? "The AI service is busy. Try again in a minute." : "The AI service returned an error.");
  }
  const j = await res.json();
  const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  const raw = extractJson(text);

  const themes = (Array.isArray(raw.themes) ? raw.themes : []).map(t => ({
    name: String(t.name || "").trim(),
    summary: scrub(t.summary, valid),
    studies: [...new Set([...(Array.isArray(t.studies) ? t.studies : []), ...[...String(t.summary || "").matchAll(/S\d+/g)].map(m => m[0])])].filter(id => valid.has(id)),
  })).filter(t => t.name && t.summary);
  if (!themes.length) throw new HttpError(502, "The AI didn't return any themes. Try again.");

  return {
    themes,
    discussion: scrub(raw.discussion, valid),
    gaps: (Array.isArray(raw.gaps) ? raw.gaps : []).map(g => scrub(g, valid)).filter(Boolean),
    conclusion: scrub(raw.conclusion, valid),
    studyIds: Object.fromEntries(studies.map(s => [s.id, s.key])),
    basedOn: studies.length,
    fullTextCount: studies.filter(s => s.fullText).length,
    omitted: records.length - studies.length,
    model: config.aiModel,
    generatedAt: new Date().toISOString(),
  };
}
