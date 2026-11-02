# Litview

**Systematic literature reviews, from a single search box.**

Litview is a browser-based tool for running a systematic literature review (SLR). Describe a research topic, refine the search, and Litview searches open scholarly databases, removes duplicates, helps you screen each study and drafts the review with a PRISMA 2020 flow diagram.

## Features

- **Topic search:** type what you want to research. Litview builds a Boolean search string from it, or you can write your own.
- **Refine search:** set the publication years, databases, study types (journal articles, conference papers, reviews, preprints, books, book chapters, case studies), open access, abstract availability, language, minimum citations, and inclusion and exclusion terms.
- **Live databases:** OpenAlex, Crossref, Europe PMC and arXiv, plus the ScienceDirect (Elsevier), Taylor & Francis, Wiley, Springer, Emerald, IEEE Xplore and ACM collections, searched through each publisher's DOI records in Crossref. Missing abstracts are filled in from OpenAlex.
- **Login databases:** for Scopus, ProQuest, JSTOR and EBSCOhost, Litview writes the search string in each database's own syntax. You run it there, export the results and import the RIS, BibTeX or CSV file.
- **Deduplication:** by DOI and normalised title, across every source.
- **Screening:** records that fail your criteria are excluded automatically with a reason. You include or exclude the rest, with reasons.
- **PRISMA 2020 flow diagram:** updates live as you screen.
- **Analysis:** publications per year, top venues, most-cited studies and recurring terms.
- **Report draft:** introduction, method, results with figures, limitations and APA references. Export it as Markdown, with the included studies as BibTeX, RIS or CSV.

## How it works

Litview is a single static HTML file with no build step, server or API keys. All searches run in your browser against the free public APIs of OpenAlex, Crossref, Europe PMC and arXiv, and nothing is stored anywhere.

## Run it

- **Online:** open the GitHub Pages site for this repository.
- **Locally:** download `index.html` and open it in a browser.

The draft report is a structured starting point. The thematic synthesis, discussion and conclusions are left for the researcher to write and are marked as to-dos in the draft.

## Built with

HTML, CSS and vanilla JavaScript, with no frameworks.
