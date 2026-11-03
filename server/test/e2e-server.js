// Starts the API against the test database with outside services simulated,
// for browser tests of the front end. Not used in production.
//   node test/e2e-server.js   (listens on port 3001)
import { loadConfig } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
import { createApp } from "../src/app.js";
import { fakeFetch } from "./helpers.js";

const config = loadConfig({
  DATABASE_URL: process.env.TEST_DATABASE_URL || "postgres://litview:litview@localhost:5432/litview_test",
  JWT_SECRET: "e2e", ALLOWED_ORIGINS: "http://localhost:8080", ANTHROPIC_API_KEY: "fake",
  PUBLIC_API_URL: "http://localhost:3001", GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "g", LINKEDIN_CLIENT_ID: "l", LINKEDIN_CLIENT_SECRET: "l",
});
const pool = createPool(config);
await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await migrate(pool);

const topics = ["vendor trust", "contract governance", "cost reduction", "knowledge transfer", "cloud adoption", "SME capability", "risk management", "relationship quality"];
const oaWork = (i) => ({ id: `W${i}`, doi: `https://doi.org/10.5555/lit.${i}`, title: `IT outsourcing and ${topics[i % 8]} in small firms: study ${i}`,
  publication_year: 2020 + (i % 5), cited_by_count: 10 * i, authorships: [{ author: { display_name: ["Aisha Rahman", "Tan Wei Ming", "Maria Okafor", "Lukas Novak"][i % 4] } }],
  primary_location: { source: { display_name: ["Information & Management", "Journal of Information Technology", "Industrial Management & Data Systems"][i % 3] } },
  open_access: { is_oa: i % 2 === 0 }, abstract_inverted_index: Object.fromEntries(`This study examines ${topics[i % 8]} in IT outsourcing among SMEs using a survey of managers`.split(" ").map((w, k) => [w + (k > 0 && w === "IT" ? "" : ""), [k]])), type: "article", language: "en" });

const fetch = fakeFetch([
  [u => u === "https://oauth2.googleapis.com/token", () => ({ json: { access_token: "t" } })],
  [u => u.startsWith("https://openidconnect.googleapis.com/"), () => ({ json: { sub: "g-1", name: "Omar Hassan", email: "omar@gmail.com", email_verified: true } })],
  [u => u.startsWith("https://api.openalex.org/works?filter=doi"), () => ({ json: { results: [] } })],
  [u => u.startsWith("https://api.openalex.org/"), () => ({ json: { meta: { count: 812 }, results: Array.from({ length: 10 }, (_, i) => oaWork(i + 1)) } })],
  [u => u.startsWith("https://api.crossref.org/"), () => ({ json: { message: { "total-results": 2400, items: [3, 4, 11, 12].map(i => ({
    DOI: `10.5555/lit.${i}`, title: [i > 10 ? `Offshore software outsourcing for SMEs: case ${i}` : oaWork(i).title], author: [{ given: "Lee", family: "Kim" }],
    issued: { "date-parts": [[2022]] }, "container-title": ["Journal of Enterprise Information Management"], "is-referenced-by-count": i,
    abstract: `<jats:p>Outsourcing study ${i} on SMEs.</jats:p>`, type: "journal-article" })) } } })],
  [u => u.startsWith("https://api.anthropic.com/"), () => new Promise(r => setTimeout(() => r({ json: { content: [{ type: "text", text: JSON.stringify({
    themes: [
      { name: "Trust and relationship quality", summary: "Several studies find that vendor trust underpins outsourcing success in SMEs [S1, S2], while relationship quality moderates outcomes [S3].", studies: ["S1", "S2", "S3"] },
      { name: "Governance and contracts", summary: "Formal contracts and governance mechanisms are linked to lower risk [S4].", studies: ["S4"] },
    ],
    discussion: "Taken together, the studies suggest that relational factors matter as much as formal contracts [S1, S4].\n\nMost evidence comes from cross-sectional surveys [S2].",
    gaps: ["Few longitudinal studies [S3]", "Limited evidence from Southeast Asia"], conclusion: "Trust and governance jointly shape IT outsourcing success in SMEs [S1, S4]." }) }] } }), 600))],
]);

createApp({ pool, config, fetch, log: console.log }).listen(3001, () => console.log("e2e API on http://localhost:3001"));
