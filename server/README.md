# Litview API

The backend for [Litview](../README.md). It adds accounts, saved reviews, team screening with conflict resolution and Cohen's kappa, a search proxy that can use keyed database APIs, and AI-assisted synthesis.

**Stack:** Node.js 20+, Express 5, PostgreSQL, JSON Web Tokens, Zod validation, `node:test` with Supertest.

## Run it locally

```bash
cd server
cp .env.example .env          # then set DATABASE_URL and JWT_SECRET
npm install
npm run dev                   # http://localhost:3000, migrates the database on start
```

To point the front end at your local API, run this in the browser console on the Litview page, then reload:

```js
localStorage.setItem("litview.api", "http://localhost:3000")
```

Add the page's address (for example `http://localhost:8080`) to `ALLOWED_ORIGINS`.

## Tests

```bash
createdb litview_test        # once
npm test
```

The tests run against a real Postgres database (`TEST_DATABASE_URL`, default `postgres://litview:litview@localhost:5432/litview_test`). Outside services such as OpenAlex, Crossref, Scopus and Anthropic are replaced with a fake `fetch`, so the tests need no network or API keys.

## Endpoints

All bodies are JSON. Routes marked 🔒 need `Authorization: Bearer <token>`.

| Method | Path | What it does |
|---|---|---|
| POST | `/api/auth/register` | Create an account. Returns `{ token, user }` |
| POST | `/api/auth/login` | Sign in. Returns `{ token, user }` |
| GET | `/api/auth/me` 🔒 | The signed-in user |
| GET | `/api/sources` | Which databases this server can search and whether AI is on |
| POST | `/api/search/:source` | Search one database (`openalex`, `crossref`, `europepmc`, `arxiv`, `sciencedirect`, `tandf`, `wiley`, `springer`, `emerald`, `ieee`, `acm`, and `scopus` 🔒 when a key is set) |
| POST | `/api/enrich` | Abstracts, citations and open-access status from OpenAlex for up to 50 DOIs |
| GET | `/api/reviews` 🔒 | Reviews you own or have joined |
| POST | `/api/reviews` 🔒 | Save a review with its settings and retrieved records |
| GET | `/api/reviews/:id` 🔒 | A review, its records and the screening state you're allowed to see |
| PATCH / DELETE | `/api/reviews/:id` 🔒 | Rename or delete (owner only) |
| PUT / DELETE | `/api/reviews/:id/sources/:source` 🔒 | Add, replace or remove one database's records |
| PUT | `/api/reviews/:id/decisions` 🔒 | Save your include/exclude decisions (batch) |
| GET | `/api/reviews/:id/screening` 🔒 | Your decisions, final statuses, conflicts and agreement |
| PUT | `/api/reviews/:id/resolutions` 🔒 | Settle a conflict (owner only) |
| POST / DELETE | `/api/reviews/:id/invite` 🔒 | Create or revoke the invite code (owner only) |
| POST | `/api/reviews/join` 🔒 | Join a review with an invite code |
| DELETE | `/api/reviews/:id/members/:userId` 🔒 | Remove a reviewer, or leave a review |
| POST / DELETE | `/api/reviews/:id/synthesis` 🔒 | Draft or remove the AI synthesis |

## Design notes

- **Blind screening is enforced by the server.** A reviewer only receives their own decisions. Other reviewers' decisions are revealed only for records in conflict.
- **Agreement** is Cohen's kappa for each pair of reviewers, over the records both decided, with Landis and Koch labels (`src/services/screening.js`).
- **AI synthesis is limited to the review's own studies.** The server looks up the included records itself, sends only their titles and abstracts, and removes any citation to a study ID that wasn't in the list before saving the draft (`src/services/ai.js`).
- **API keys stay on the server.** Scopus, IEEE and Springer keys are never returned to the browser, and keyed searches need an account so they can't be used as an open proxy.
- **Retrieved records are stored per database** (`review_sources`), so deduplication can be re-run whenever a new export is imported.

## Deploy (Render + Neon)

1. Create a free Postgres database on [Neon](https://neon.com) and copy its connection string.
2. In [Render](https://render.com), choose **New → Blueprint** and pick this repository. Render reads `render.yaml`.
3. Paste the Neon connection string into `DATABASE_URL`. Add `ANTHROPIC_API_KEY` to turn on AI synthesis, plus any database keys you have.
4. Deploy, then put the service URL (for example `https://litview-api.onrender.com`) in the `litview-api` meta tag in `index.html`.

On Render's free plan the service sleeps after 15 minutes without traffic and takes about a minute to wake up.
