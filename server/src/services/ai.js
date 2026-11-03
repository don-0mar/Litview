// AI-assisted synthesis using the Anthropic Messages API.
// The model only sees titles and abstracts of the studies the team included, must cite them
// by their IDs, and every citation is checked against that list before anything is returned.

import { HttpError } from "../lib/http.js";

const SYSTEM = `You help researchers draft the synthesis section of a systematic literature review.
Rules:
- Use only the studies provided. Never mention or invent other studies, authors, figures or findings.
- You only have titles and abstracts, so describe what the studies report, not their full results, and do not overstate certainty.
- Cite studies with their IDs in square brackets, e.g. [S3] or [S3, S7]. Every claim about the literature needs a citation.
- Group the studies into 3 to 6 themes that answer the research questions where possible.
- Write in a neutral academic register, in British or American English consistently, without bullet points inside the prose.
- Respond with JSON only, no other text, matching:
{"themes":[{"name":string,"summary":string,"studies":[string]}],"discussion":string,"gaps":[string],"conclusion":string}`;

function buildPrompt({ topic, rqs, studies }) {
  const list = studies.map(s => ({
    id: s.id, title: s.title, year: s.year, authors: s.authors.slice(0, 3).join(", ") + (s.authors.length > 3 ? " et al." : ""),
    venue: s.venue, abstract: (s.abstract || "").slice(0, 1200),
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

  // Keep the most cited studies with abstracts if there are more than the limit.
  const usable = records.filter(r => r.abstract || r.title);
  const chosen = [...usable].sort((a, b) => (b.cites || 0) - (a.cites || 0)).slice(0, config.aiMaxStudies);
  const studies = chosen.map((r, i) => ({ ...r, id: `S${i + 1}` }));
  const valid = new Set(studies.map(s => s.id));

  const res = await ctx.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.keys.anthropic, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: config.aiModel, max_tokens: 4000, system: SYSTEM,
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
    omitted: records.length - studies.length,
    model: config.aiModel,
    generatedAt: new Date().toISOString(),
  };
}
