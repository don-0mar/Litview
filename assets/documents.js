/* Litview: read the client's own documents (PDF or plain text) in the browser.
 * Files never leave the browser; only the extracted text and details do, and only
 * when the review is saved. Exposes window.LitviewDocs.read(file) -> record.
 * The record has the same shape as a database search result, plus fullText. */
(() => {
  "use strict";
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
  // Tesseract.js fetches its worker, engine and language data from jsDelivr by default.
  const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js";
  const OCR_LANGS = { eng: "English", msa: "Malay" };
  const OCR_MAX_PAGES = 40;
  const MAX_PAGES = 60;          // pages read per document
  const MAX_TEXT = 60000;        // characters of full text kept per document
  const MAX_BYTES = 50 * 1024 * 1024;

  let loading = null;
  function pdfjs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return loading ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = PDFJS + "pdf.min.js";
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js"; resolve(window.pdfjsLib); };
      s.onerror = () => { loading = null; reject(new Error("Couldn't load the PDF reader. Check your connection and try again.")); };
      document.head.appendChild(s);
    });
  }

  let tessLoading = null;
  function tesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    return tessLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TESSERACT;
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => { tessLoading = null; reject(new Error("Couldn't load the OCR reader. Check your connection and try again.")); };
      document.head.appendChild(s);
    });
  }

  const clean = s => (s || "").replace(/\u0000/g, "").replace(/[ \t ]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
  const NOW = new Date().getFullYear();

  /** Turn one page's text items into lines, each with the font size it is set in. */
  function pageLines(content) {
    const lines = []; let cur = null;
    for (const it of content.items) {
      if (!("str" in it)) continue;
      const y = Math.round(it.transform[5]);
      const size = Math.round(Math.hypot(it.transform[2], it.transform[3]) * 10) / 10;
      if (!cur || Math.abs(cur.y - y) > Math.max(2, size * 0.5)) { cur = { y, size, text: "" }; lines.push(cur); }
      cur.text += (cur.text && !cur.text.endsWith(" ") && !it.str.startsWith(" ") ? " " : "") + it.str;
      if (it.str.trim()) cur.size = Math.max(cur.size, size);
      if (it.hasEOL) cur = null;
    }
    return lines.map(l => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter(l => l.text);
  }

  /** The title is usually the run of lines in the largest type on the first page. */
  function titleFromLines(lines) {
    const candidates = lines.slice(0, 40).filter(l => l.text.length >= 3 && !/^(doi|https?:|www\.|vol\.|volume|issn|journal|received|accepted|©)/i.test(l.text));
    if (!candidates.length) return "";
    const max = Math.max(...candidates.map(l => l.size));
    const start = lines.indexOf(candidates.find(l => l.size >= max * 0.95));
    const parts = [];
    for (let i = start; i < lines.length && i < start + 5; i++) {
      if (lines[i].size < max * 0.9) break;
      parts.push(lines[i].text);
    }
    return { title: parts.join(" ").replace(/\s+/g, " ").trim(), after: start + parts.length };
  }

  const looksLikeName = s => /^[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]*\.?){1,3}$/u.test(s) && s.length <= 40;
  function authorsFromLine(text) {
    return text.replace(/[\d*†‡§¶,]+(?=\s|,|$)/g, m => m.includes(",") ? "," : "")
      .split(/\s*(?:,|;|\band\b|&)\s*/).map(s => s.replace(/[\d*†‡§¶]+/g, "").trim()).filter(looksLikeName).slice(0, 15);
  }

  function findDoi(text) {
    const m = text.match(/\b(10\.\d{4,9}\/[^\s"<>]+)/i);
    return m ? m[1].replace(/[.,;:)\]}>]+$/, "") : "";
  }

  function findYear(text, meta) {
    const head = text.slice(0, 6000);
    const pub = [...head.matchAll(/(?:©|\(c\)|copyright|published(?: online)?|available online|accepted)[^\d]{0,30}((?:19|20)\d{2})/gi)].map(m => +m[1]).filter(y => y >= 1900 && y <= NOW + 1);
    if (pub.length) return Math.max(...pub);
    const any = [...head.slice(0, 2500).matchAll(/\b((?:19|20)\d{2})\b/g)].map(m => +m[1]).filter(y => y >= 1950 && y <= NOW + 1);
    if (any.length) {
      const counts = any.reduce((m, y) => (m[y] = (m[y] || 0) + 1, m), {});
      return +Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    }
    const cd = (meta?.CreationDate || "").match(/(?:D:)?((?:19|20)\d{2})/);
    return cd ? +cd[1] : null;
  }

  function findAbstract(text, title) {
    const head = text.slice(0, 15000);
    const m = head.match(/\babstract\b[\s:.—–-]*/i);
    let start = m ? m.index + m[0].length : -1;
    if (start < 0) {
      // No "Abstract" heading: take the opening text after the title.
      const t = title ? head.indexOf(title.slice(0, 30)) : -1;
      start = t >= 0 ? t + title.length : 0;
    }
    const rest = head.slice(start);
    const end = rest.search(/\n\s*(?:keywords?|key words|index terms|jel(?: classification)?|(?:1\.?|i\.)?\s*introduction\b)/i);
    return clean(rest.slice(0, end > 80 ? Math.min(end, 3000) : 1500)).replace(/\n/g, " ");
  }

  const plausibleMetaTitle = t => t && t.length >= 12 && t.length <= 300 && /\s/.test(t) && !/^(microsoft (word|powerpoint)|untitled|article|paper|manuscript)\b/i.test(t) && !/\.(docx?|pdf|tex)$/i.test(t);
  const titleFromFileName = name => { const t = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

  async function readPdf(file) {
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    let meta = {};
    try { meta = (await doc.getMetadata()).info || {}; } catch { /* no metadata */ }
    const pages = Math.min(doc.numPages, MAX_PAGES);
    let firstLines = [], text = "";
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const lines = pageLines(await page.getTextContent());
      if (p === 1) firstLines = lines;
      text += lines.map(l => l.text).join("\n") + "\n\n";
      page.cleanup();
      if (text.length > MAX_TEXT * 1.5) break;
    }
    const total = doc.numPages;
    await doc.destroy();
    return fromText({ text, firstLines, meta, fileName: file.name, pages: total });
  }

  /** Work out a record's details from its text and first-page lines. Shared by normal reading and OCR. */
  function fromText({ text, firstLines, meta = {}, fileName, pages }) {
    text = clean(text);
    const noText = text.replace(/\s/g, "").length < 200;

    const fromPage = titleFromLines(firstLines);
    const metaTitle = clean(meta.Title || "");
    // Prefer the document's own title metadata when it is real and appears on the first page.
    const firstPage = firstLines.map(l => l.text).join(" ").toLowerCase();
    const metaOnPage = plausibleMetaTitle(metaTitle) && firstPage.includes(metaTitle.toLowerCase().slice(0, 25));
    let title = metaOnPage ? metaTitle : (fromPage.title && fromPage.title.length >= 8 ? fromPage.title : (plausibleMetaTitle(metaTitle) ? metaTitle : ""));
    if (!title) title = titleFromFileName(fileName);

    let authors = clean(meta.Author || "").split(/\s*(?:;|,|\band\b|&)\s*/).filter(looksLikeName);
    if (!authors.length && fromPage.after != null) {
      for (const l of firstLines.slice(fromPage.after, fromPage.after + 4)) {
        const a = authorsFromLine(l.text);
        if (a.length) { authors = a; break; }
      }
    }
    return {
      // A PDF with no text has nothing to date it by but the file's own creation date, which is when it was scanned: leave the year empty.
      title, authors, year: noText ? null : findYear(text, meta), doi: findDoi(text.slice(0, 20000)), venue: "",
      abstract: noText ? "" : findAbstract(text, title), fullText: noText ? "" : text.slice(0, MAX_TEXT), pages, noText,
    };
  }

  /* ---------- OCR for scanned PDFs ---------- */

  /** Lines of the first page from Tesseract's block output, with their height standing in for font size. */
  function ocrLines(blocks) {
    const lines = [];
    for (const b of blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
      const text = (l.text || "").replace(/\s+/g, " ").trim();
      // rowHeight stays the same for every line set in one font size; the box height changes with letters like g and y.
      const size = l.rowAttributes?.rowHeight || (l.bbox ? l.bbox.y1 - l.bbox.y0 : 0);
      if (text && l.bbox) lines.push({ text, size: Math.round(size), y: l.bbox.y0 });
    }
    return lines.sort((a, b) => a.y - b.y);
  }

  /**
   * Read a scanned PDF with OCR: draw each page as an image with pdf.js, then recognise it with Tesseract.
   * opts: { langs: ["eng"], maxPages, onProgress({stage, page, of, progress}), signal }
   */
  async function ocr(file, { langs = ["eng"], maxPages = OCR_MAX_PAGES, onProgress, signal } = {}) {
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") throw new Error("OCR works on PDF files.");
    const stop = () => { if (signal?.aborted) throw new DOMException("OCR was cancelled.", "AbortError"); };
    onProgress?.({ stage: "loading" });
    const [lib, T] = await Promise.all([pdfjs(), tesseract()]);
    stop();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    let worker = null;
    try {
      const pages = Math.min(doc.numPages, maxPages);
      let current = 0;
      worker = await T.createWorker(langs, 1, {
        logger: m => {
          if (m.status === "recognizing text") onProgress?.({ stage: "reading", page: current, of: pages, progress: m.progress });
          else if (/loading|initiali/.test(m.status || "")) onProgress?.({ stage: "loading", progress: m.progress });
        },
      });
      let text = "", firstLines = [], conf = [];
      for (let p = 1; p <= pages; p++) {
        stop();
        current = p;
        onProgress?.({ stage: "reading", page: p, of: pages, progress: 0 });
        const page = await doc.getPage(p);
        // About 2,000 pixels wide (roughly 240 dpi on A4): sharp enough for small print, small enough to stay quick.
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(3, Math.max(1.5, 2000 / base.width)) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        // Cancelling takes effect between pages: stopping Tesseract mid-page leaves it in a broken state.
        const { data } = await worker.recognize(canvas, {}, p === 1 ? { text: true, blocks: true } : { text: true });
        if (p === 1) firstLines = ocrLines(data.blocks);
        if (data.confidence != null) conf.push(data.confidence);
        text += (data.text || "") + "\n\n";
        canvas.width = canvas.height = 0;
        page.cleanup();
      }
      stop();
      let meta = {};
      try { meta = (await doc.getMetadata()).info || {}; } catch { /* no metadata */ }
      const r = fromText({ text, firstLines, meta, fileName: file.name, pages: doc.numPages });
      return { ...r, ocr: true, ocrLangs: langs, ocrPages: pages, ocrConfidence: conf.length ? Math.round(conf.reduce((a, b) => a + b, 0) / conf.length) : null };
    } finally {
      if (worker) await worker.terminate().catch(() => {});
      await doc.destroy();
    }
  }

  async function readTxt(file) {
    const text = clean(await file.text());
    const first = text.split("\n").find(l => l.trim().length > 3) || titleFromFileName(file.name);
    return { title: first.slice(0, 300), authors: [], year: findYear(text), doi: findDoi(text.slice(0, 20000)), venue: "",
      abstract: findAbstract(text, first), fullText: text.slice(0, MAX_TEXT), pages: null, noText: text.length < 50 };
  }

  const ACCEPT = ".pdf,.txt,.md";
  const supported = f => /\.(pdf|txt|md)$/i.test(f.name) || f.type === "application/pdf" || f.type === "text/plain";

  /** Read one file into a Litview record. Throws an Error with a readable message. */
  async function read(file) {
    if (!supported(file)) throw new Error(`${file.name}: only PDF and plain-text files can be read.`);
    if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 50 MB.`);
    let r;
    try { r = /\.pdf$/i.test(file.name) || file.type === "application/pdf" ? await readPdf(file) : await readTxt(file); }
    catch (e) {
      if (e?.name === "PasswordException") throw new Error(`${file.name} is password-protected.`);
      if (/PDF reader/.test(e?.message || "")) throw e;
      throw new Error(`${file.name} couldn't be read. It may be damaged or not a real PDF.`);
    }
    return {
      ...r, cites: 0, noCites: true, oa: false, oaKnown: false, type: "article", url: "", lang: "en",
      source: "upload", uploaded: true, fileName: file.name, docId: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  window.LitviewDocs = { read, ocr, supported, ACCEPT, MAX_TEXT, OCR_LANGS, OCR_MAX_PAGES };
})();
