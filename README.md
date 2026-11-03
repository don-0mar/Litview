# Litview

**Systematic literature reviews, from a single search box.**

Litview is a web app for running a systematic literature review (SLR). Describe a research topic, refine the search, and Litview searches scholarly databases, removes duplicates, helps you and your colleagues screen each study and drafts the review with a PRISMA 2020 flow diagram.

**Live site:** https://don-0mar.github.io/Litview/

## Features

**Search**
- Type a topic and Litview builds a Boolean search string from it, or write your own.
- Refine by years, databases, study type (journal articles, conference papers, reviews, preprints, books, book chapters, case studies), open access, abstracts, language, citations, and inclusion and exclusion terms.
- **Searched automatically:** OpenAlex, Crossref, Europe PMC, arXiv, and the ScienceDirect, Taylor & Francis, Wiley, Springer, Emerald, IEEE Xplore and ACM collections. Missing abstracts are filled in from OpenAlex.
- **Login databases:** for Scopus, ProQuest, JSTOR and EBSCOhost, Litview writes the search string in each database's syntax and imports the RIS, BibTeX or CSV file you export. Scopus is searched directly when the server has an API key.

**Screening**
- Duplicates are removed by DOI and normalised title. Records that fail your criteria are excluded automatically, with a reason.
- **Team screening:** invite colleagues with a code. Everyone screens blind, disagreements go to a Conflicts list for the owner to settle, and agreement is reported as Cohen's kappa.

**Results**
- A live PRISMA 2020 flow diagram, publications per year, top venues, most-cited studies and recurring terms.
- **Report draft:** introduction, method, results with figures, limitations and APA references, exported as Markdown, BibTeX, RIS or CSV.
- **AI-assisted synthesis:** drafts themes, a discussion, research gaps and a conclusion from the included studies' abstracts, citing only those studies.

**Accounts:** sign in to save reviews and come back to them.

## Architecture

```
index.html, assets/     Front end: HTML, CSS and vanilla JavaScript, hosted on GitHub Pages
server/                 Back end: Node.js + Express + PostgreSQL REST API, hosted on Render
render.yaml             Render deployment blueprint
```

The front end works on its own in the browser, without accounts. When the `litview-api` meta tag in `index.html` points at the API, it adds accounts, saved reviews, team screening, server-side search and AI synthesis. See [server/README.md](server/README.md) for the API, its tests and deployment.

## Run it locally

- **Front end only:** open `index.html` in a browser, or run `python3 -m http.server` in this folder.
- **With the API:** follow [server/README.md](server/README.md).

## Built with

HTML, CSS and vanilla JavaScript on the front end; Node.js, Express 5, PostgreSQL, JWT and Zod on the back end; tested with `node:test`, Supertest and Playwright.

The draft report is a structured starting point. Synthesis, whether written by you or drafted with AI, must be checked against the full texts of the included studies.
