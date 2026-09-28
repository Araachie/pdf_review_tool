import * as pdfjsLib from "/vendor/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
};

// ---------------------------------------------------------------- state
const state = {
  pdfs: [], pdf: null, doc: null, scale: 1, fitWidth: true,
  data: { comments: [], next_id: 1 }, pages: [], // pages[i] = {div, canvas, textLayer, annLayer, viewport}
  mode: "text", selectedId: null, pdfMtime: null, saveTimer: null, pending: null,
  cites: {},        // bibkey -> [{page, rect}] occurrences (from PDF link annotations)
  citeOrder: [],    // bibkeys in order of first appearance
  destCache: {},    // bibkey -> {pageIndex, y}
  textCache: {},    // pageNum -> textContent items
  activeCite: null,
};

const api = {
  get: (u) => fetch(u).then((r) => r.json()),
  put: (u, b) => fetch(u, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json()),
  post: (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json()),
};

// ---------------------------------------------------------------- PDF list
async function loadPdfList() {
  state.pdfs = await api.get("/api/pdfs");
  const sel = $("#pdfSelect");
  sel.innerHTML = "";
  for (const p of state.pdfs) sel.append(el("option", { value: p.id, text: p.name }));
  const remembered = localStorage.getItem("pdfreview.lastPdf");
  const first = state.pdfs.find((p) => p.id === remembered) || state.pdfs[0];
  if (first) { sel.value = first.id; await openPdf(first.id); }
}

async function openPdf(id) {
  const info = state.pdfs.find((p) => p.id === id);
  if (!info) return;
  state.pdf = info; state.pdfMtime = info.mtime; state.selectedId = null;
  localStorage.setItem("pdfreview.lastPdf", id);
  $("#pdfChanged").hidden = true;
  state.data = await api.get(`/api/annotations/${id}`);
  state.data.comments ||= [];
  state.data.citations ||= {};
  state.cites = {}; state.citeOrder = []; state.destCache = {}; state.textCache = {}; closeCitePanel();
  state.data.next_id ||= 1 + Math.max(0, ...state.data.comments.map((c) => parseInt(String(c.id).replace(/\D/g, "")) || 0));
  if (state.doc) { state.doc.destroy(); state.doc = null; }
  state.doc = await pdfjsLib.getDocument({ url: `/api/pdf/${id}?t=${Date.now()}` }).promise;
  renderSidebar();
  loadRequests();
  await renderAll();
}

// ---------------------------------------------------------------- rendering
function computeScale(page) {
  if (!state.fitWidth) return state.scale;
  const avail = $("#viewer").clientWidth - 40;
  const vp = page.getViewport({ scale: 1 });
  state.scale = Math.max(0.3, avail / vp.width);
  return state.scale;
}

async function renderAll() {
  const cont = $("#pages");
  cont.innerHTML = "";
  state.pages = [];
  const n = state.doc.numPages;
  for (let i = 1; i <= n; i++) {
    const page = await state.doc.getPage(i);
    const scale = computeScale(page);
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    const div = el("div", { class: "page", "data-page": i });
    div.style.width = `${viewport.width}px`; div.style.height = `${viewport.height}px`;
    const canvas = el("canvas");
    canvas.width = Math.floor(viewport.width * dpr); canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
    const textLayer = el("div", { class: "textLayer" });
    textLayer.style.setProperty("--scale-factor", String(scale));
    const annLayer = el("div", { class: "annLayer" });
    const drawLayer = el("div", { class: "drawLayer" });
    const citeLayer = el("div", { class: "citeLayer" });
    div.append(el("span", { class: "pageNum", text: `p. ${i}` }), canvas, textLayer, citeLayer, annLayer, drawLayer);
    cont.append(div);
    const P = { num: i, div, canvas, textLayer, annLayer, drawLayer, citeLayer, viewport, page, cites: [] };
    state.pages.push(P);
    attachBoxDrawing(P);
    $("#zoomLabel").textContent = `${Math.round(scale * 100)}%`;
    // render (don't await sequentially too long: render canvas, then text)
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const tl = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport });
    await tl.render();
    drawHighlightsForPage(P);
    await collectCitations(P);
  }
  updateCiteSummary();
}

// ---------------------------------------------------------------- citations (hyperref link annotations "cite.<bibkey>")
async function collectCitations(P) {
  let anns = [];
  try { anns = await P.page.getAnnotations(); } catch { return; }
  for (const a of anns) {
    if (a.subtype !== "Link" || typeof a.dest !== "string" || !a.dest.startsWith("cite.")) continue;
    const key = a.dest.slice(5);
    const [x1, y1, x2, y2] = P.viewport.convertToViewportRectangle(a.rect);
    const rect = { x: Math.min(x1, x2) / P.viewport.width, y: Math.min(y1, y2) / P.viewport.height,
                   w: Math.abs(x2 - x1) / P.viewport.width, h: Math.abs(y2 - y1) / P.viewport.height };
    P.cites.push({ key, rect });
    (state.cites[key] ||= []).push({ page: P.num, rect });
    if (!state.citeOrder.includes(key)) state.citeOrder.push(key);
  }
  drawCitesForPage(P);
}
function citeStatus(key) {
  if (state.data.comments.some((c) => c.bibkey === key && c.status !== "rejected")) return "flagged";
  return state.data.citations?.[key]?.status || null;
}
function drawCitesForPage(P) {
  P.citeLayer.innerHTML = "";
  for (const c of P.cites) {
    const d = el("div", { class: "cite" + (state.activeCite === c.key ? " active" : ""), "data-key": c.key, title: c.key,
      onclick: (e) => { e.stopPropagation(); openCitePanel(c.key, P.num, c.rect); } });
    const st = citeStatus(c.key);
    if (st) d.dataset.vstatus = st;
    d.style.left = `${c.rect.x * 100}%`; d.style.top = `${c.rect.y * 100}%`;
    d.style.width = `${c.rect.w * 100}%`; d.style.height = `${c.rect.h * 100}%`;
    P.citeLayer.append(d);
  }
}
function redrawCites() { state.pages.forEach(drawCitesForPage); updateCiteSummary(); }
function updateCiteSummary() {
  const box = $("#citeSummary");
  const keys = state.citeOrder;
  box.innerHTML = "";
  if (!keys.length) { box.hidden = state.pages.length === 0; box.append(el("div", { class: "hint", text: "No citation links found in this PDF (needs hyperref)." })); return; }
  const n = (st) => keys.filter((k) => citeStatus(k) === st).length;
  const counts = { verified: n("verified"), unclear: n("unclear"), flagged: n("flagged") };
  counts.unchecked = keys.length - counts.verified - counts.unclear - counts.flagged;
  box.hidden = false;
  const bar = el("div", { class: "bar" }), legend = el("div", { class: "legend" });
  for (const [st, v] of Object.entries(counts)) {
    if (v) bar.append(el("span", { class: st, style: `flex-grow: ${v}`, title: `${v} ${st}` }));
    legend.append(el("span", { class: st, text: `${v} ${st}` }));
  }
  box.append(el("div", { class: "head" }, el("b", { text: "Citations" }), el("span", { text: `${counts.verified} of ${keys.length} verified` })), bar, legend);
}

async function pageText(pageNum) {
  if (!state.textCache[pageNum]) {
    const page = await state.doc.getPage(pageNum);
    state.textCache[pageNum] = (await page.getTextContent()).items.filter((it) => it.str !== undefined);
  }
  return state.textCache[pageNum];
}
async function citeDest(key) {
  if (state.destCache[key] !== undefined) return state.destCache[key];
  let out = null;
  try {
    const d = await state.doc.getDestination(`cite.${key}`);
    if (d && d[0]) {
      const pageIndex = await state.doc.getPageIndex(d[0]);
      out = { pageIndex, y: typeof d[3] === "number" ? d[3] : null, x: typeof d[2] === "number" ? d[2] : null };
    }
  } catch {}
  state.destCache[key] = out;
  return out;
}
// Text of the bibliography entry the citation points to: text items on the destination page between this
// destination's y and the next citation destination below it.
async function referenceText(key) {
  const dest = await citeDest(key);
  if (!dest) return { text: "", dest: null };
  const pageNum = dest.pageIndex + 1;
  const items = await pageText(pageNum);
  // all destinations on that page
  const ys = [];
  for (const k of state.citeOrder) {
    const dk = await citeDest(k);
    if (dk && dk.pageIndex === dest.pageIndex && dk.y !== null) ys.push(dk.y);
  }
  const y0 = dest.y ?? Infinity;
  const below = ys.filter((y) => y < y0 - 1);
  const yEnd = below.length ? Math.max(...below) : -Infinity;
  const inRange = items.filter((it) => { const y = it.transform[5]; return y <= y0 + 3 && y > yEnd + 1 && !/^\s*\d{3}\s*$/.test(it.str); });
  inRange.sort((a, b) => (b.transform[5] - a.transform[5]) || (a.transform[4] - b.transform[4]));
  let text = "", lastY = null;
  for (const it of inRange) {
    if (lastY !== null && Math.abs(it.transform[5] - lastY) > 2) text += text.endsWith("-") ? "" : " ";
    text += it.str;
    lastY = it.transform[5];
  }
  return { text: text.replace(/\s+/g, " ").trim(), dest, pageNum };
}

// ---- the panel
const cp = $("#citePanel");
function closeCitePanel() { cp.hidden = true; const prev = state.activeCite; state.activeCite = null; if (prev) redrawCites(); }
$("#cpClose").onclick = closeCitePanel;
async function openCitePanel(key, page, rect) {
  state.activeCite = key; state.activeCiteLoc = { page, rect };
  cp.hidden = false;
  redrawCites();
  $("#cpKey").textContent = key;
  renderCiteStatus(key);
  $("#cpRef").textContent = "…"; $("#cpBib").textContent = "…"; $("#cpMatches").textContent = "…"; $("#cpLinks").innerHTML = ""; $("#cpLookupState").textContent = "";
  const occ = state.cites[key] || [];
  $("#cpStatus").dataset.occ = occ.length;

  // reference text + bib entry in parallel
  const [ref, bib] = await Promise.all([
    referenceText(key),
    fetch(`/api/bib/${state.pdf.id}/${encodeURIComponent(key)}`).then((r) => r.json()).catch(() => null),
  ]);
  if (state.activeCite !== key) return;
  state.activeRef = ref;
  $("#cpRef").textContent = ref.text || "(could not extract the reference entry from the PDF)";
  $("#cpJump").onclick = () => { if (ref.pageNum) jumpTo(ref.pageNum, ref.dest?.y); };
  const f = bib?.fields || {};
  $("#cpBib").textContent = bib?.raw || (bib?.error ? `key "${key}" not found in ${state.pdf.bib || "(no .bib configured)"}` : "(no .bib configured for this PDF)");
  const title = f.title || "";
  const firstAuthor = (f.author || "").split(/\s+and\s+/)[0] || "";
  const query = title || ref.text.slice(0, 200);
  const scholarQ = encodeURIComponent(title ? `${title}` : ref.text.slice(0, 200));
  const links = [
    ["Google Scholar", `https://scholar.google.com/scholar?q=${scholarQ}`],
    ["Google Scholar (author+title)", `https://scholar.google.com/scholar?q=${encodeURIComponent(`${firstAuthor} ${title}`.trim())}`],
    ["arXiv", `https://arxiv.org/search/?searchtype=all&query=${scholarQ}`],
    ["Semantic Scholar", `https://www.semanticscholar.org/search?q=${scholarQ}`],
    ["OpenAlex", `https://openalex.org/works?search=${scholarQ}`],
  ];
  if (f.doi) links.push(["DOI", `https://doi.org/${f.doi}`]);
  if (f.url) links.push(["URL in bib", f.url]);
  if (f.eprint) links.push(["arXiv id", `https://arxiv.org/abs/${f.eprint}`]);
  $("#cpLinks").innerHTML = "";
  for (const [t, u] of links) $("#cpLinks").append(el("a", { href: u, target: "_blank", rel: "noopener", text: t }));

  // automatic closest-match lookup
  $("#cpLookupState").textContent = "searching…";
  try {
    const params = new URLSearchParams({ q: query });
    if (title) params.set("title", title);
    if (f.year) params.set("year", f.year);
    if (f.author) params.set("authors", f.author);
    const res = await fetch(`/api/lookup?${params}`).then((r) => r.json());
    if (state.activeCite !== key) return;
    renderMatches(res, f);
  } catch (e) {
    $("#cpMatches").textContent = `lookup failed: ${e.message}`;
    $("#cpLookupState").textContent = "";
  }
}
function renderMatches(res, f) {
  const box = $("#cpMatches");
  box.innerHTML = "";
  $("#cpLookupState").textContent = res.errors?.length ? `(${res.errors.map((e) => e.split(":")[0]).join(", ")} unavailable)` : "";
  if (!res.matches?.length) { box.textContent = "No matches found in Crossref/OpenAlex. Check Google Scholar manually."; return; }
  for (const m of res.matches) {
    const cls = m.score >= 0.9 && m.author_match !== false ? "good" : (m.score < 0.5 || m.author_match === false) ? "weak" : "";
    const d = el("div", { class: `m ${cls}` });
    d.append(el("span", { class: `score ${m.score >= 0.9 ? "hi" : m.score < 0.5 ? "lo" : ""}`, text: `${Math.round(m.score * 100)}%` }));
    d.append(el("div", { class: "t" }, m.url ? el("a", { href: m.url, target: "_blank", rel: "noopener", text: m.title }) : m.title));
    const yr = m.year ? (m.year_mismatch ? `${m.year} (bib says ${f.year})` : m.year) : "";
    const auth = m.author_match === undefined ? "" : m.author_match ? "authors ✓" : "authors ✗";
    d.append(el("div", { class: "s", text: [m.authors?.slice(0, 4).join(", ") + (m.authors?.length > 4 ? " et al." : ""), m.venue, yr, auth, m.source].filter(Boolean).join(" · ") }));
    box.append(d);
  }
}
function renderCiteStatus(key) {
  const v = state.data.citations?.[key];
  const st = citeStatus(key);
  const occ = (state.cites[key] || []).length;
  const stage = v?.uncolored ? " · uncoloured in LaTeX" : v?.sent ? " · sent in a revision request" : v?.status === "verified" ? " · will be sent with the next request" : "";
  $("#cpStatus").textContent = `${occ} occurrence${occ === 1 ? "" : "s"} in the PDF · status: ${st || "unchecked"}` +
    (v?.checked ? ` (${new Date(v.checked).toLocaleString()})` : "") + stage + (v?.note ? ` · ${v.note}` : "");
}
function setCiteStatus(key, status) {
  state.data.citations ||= {};
  if (status) state.data.citations[key] = { status, checked: new Date().toISOString() };
  else delete state.data.citations[key];
  scheduleSave(); renderCiteStatus(key); redrawCites(); renderSidebar();
}
$("#cpVerified").onclick = () => { setCiteStatus(state.activeCite, "verified"); nextUnverified(1, true); };
$("#cpUnclear").onclick = () => setCiteStatus(state.activeCite, "unclear");
$("#cpReset").onclick = () => setCiteStatus(state.activeCite, null);
$("#cpFlag").onclick = () => {
  const key = state.activeCite; if (!key) return;
  const loc = state.activeCiteLoc || (state.cites[key] || [])[0];
  const P = state.pages[loc.page - 1];
  const quote = P ? textInRect(P, { x: loc.rect.x - 0.002, y: loc.rect.y, w: loc.rect.w + 0.004, h: loc.rect.h }) : "";
  openPopupNew({ kind: "citation", page: loc.page, rects: [loc.rect], quote: quote || `\\cite{${key}}`, bibkey: key,
    reftext: state.activeRef?.text || "", context: `citation of bib key ${key}` }, window.innerWidth - 800, 120);
  $("#popupCategory").value = "citation";
  $("#popupText").value = `Citation "${key}" could not be verified: `;
};
function nextUnverified(dir, onlyIfUnchecked) {
  const keys = state.citeOrder;
  if (!keys.length) return;
  let i = keys.indexOf(state.activeCite);
  for (let n = 0; n < keys.length; n++) {
    i = (i + dir + keys.length) % keys.length;
    if (!citeStatus(keys[i]) || !onlyIfUnchecked) {
      const occ = state.cites[keys[i]][0];
      jumpTo(occ.page, null, occ.rect);
      openCitePanel(keys[i], occ.page, occ.rect);
      return;
    }
  }
  $("#cpLookupState").textContent = "all citations checked";
}
$("#cpNext").onclick = () => nextUnverified(1, true);
$("#cpPrev").onclick = () => nextUnverified(-1, true);
function jumpTo(pageNum, pdfY, rect) {
  const P = state.pages[pageNum - 1];
  if (!P) return;
  let top = P.div.offsetTop;
  if (rect) top += rect.y * P.div.clientHeight - 120;
  else if (typeof pdfY === "number") top += (1 - pdfY / P.viewport.viewBox[3]) * P.div.clientHeight - 60;
  $("#viewer").scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

function drawHighlightsForPage(P) {
  P.annLayer.innerHTML = "";
  const used = { left: [], right: [] }; // margin tag positions, to keep tags on nearby lines from overlapping
  for (const c of visibleComments()) {
    if (c.page !== P.num) continue;
    const st = c.status || "draft", sel = c.id === state.selectedId ? " sel" : "";
    (c.rects || []).forEach((r, k) => {
      const h = el("div", { class: `hl ${c.kind}${sel}`, "data-status": st, "data-id": c.id });
      h.style.left = `${r.x * 100}%`; h.style.top = `${r.y * 100}%`;
      h.style.width = `${r.w * 100}%`; h.style.height = `${r.h * 100}%`;
      if (c.kind === "box") h.onclick = () => selectComment(c.id, false);
      P.annLayer.append(h);
      if (k > 0) return;
      const tag = el("span", { class: `tag ${c.kind} ${c.kind === "box" ? "onBox" : "inMargin"}${sel}`, "data-status": st, "data-id": c.id, text: c.id,
        onclick: (e) => { e.stopPropagation(); selectComment(c.id, false); } });
      if (c.kind === "box") { tag.style.left = `${r.x * 100}%`; tag.style.top = `${r.y * 100}%`; }
      else { // text tags go into the nearest page margin so they never cover the text
        const side = r.x < 0.5 ? "left" : "right";
        let y = r.y + r.h / 2;
        while (used[side].some((u) => Math.abs(u - y) < 0.014)) y += 0.014;
        used[side].push(y);
        tag.style.top = `${y * 100}%`; tag.style[side] = "1.5%";
      }
      P.annLayer.append(tag);
    });
  }
}
function redrawAll() { state.pages.forEach(drawHighlightsForPage); }

// ---------------------------------------------------------------- comments
function nextId() { const id = `R${state.data.next_id}`; state.data.next_id += 1; return id; }

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => api.put(`/api/annotations/${state.pdf.id}`, state.data), 300);
}

function addComment(c) {
  c.id = nextId(); c.status = "draft"; c.created = new Date().toISOString();
  state.data.comments.push(c);
  scheduleSave(); redrawAll(); renderSidebar(); selectComment(c.id, false);
  if (c.bibkey) { redrawCites(); if (state.activeCite === c.bibkey) renderCiteStatus(c.bibkey); }
}

function updateComment(id, patch) {
  const c = state.data.comments.find((x) => x.id === id);
  if (!c) return;
  Object.assign(c, patch);
  if (c.status === "applied" || c.status === "rejected") { /* keep */ } else if (c.status === "submitted" && (patch.text || patch.category)) c.status = "draft";
  scheduleSave(); redrawAll(); renderSidebar();
}

function deleteComment(id) {
  const c = state.data.comments.find((x) => x.id === id);
  if (!c) return;
  if (c.status !== "draft" && !confirm(`${id} is ${c.status}. Delete anyway?`)) return;
  state.data.comments = state.data.comments.filter((x) => x.id !== id);
  scheduleSave(); redrawAll(); renderSidebar();
  if (c.bibkey) redrawCites();
}

function pendingVerifiedKeys() {
  return Object.entries(state.data.citations || {}).filter(([, v]) => v.status === "verified" && !v.sent).map(([k]) => k);
}
function activeFilters() { return [...document.querySelectorAll(".flt:checked")].map((x) => x.value); }
function latestRequestPath() {
  const paths = state.data.comments.map((c) => c.request).filter(Boolean);
  return paths.length ? paths.sort().at(-1) : null; // request paths embed a timestamp, so max = newest
}
// Comments that pass the sidebar filters; used for both the sidebar and the PDF overlays.
function visibleComments() {
  const flt = activeFilters();
  const latest = $("#fltLatest").checked ? latestRequestPath() : null;
  return state.data.comments.filter((c) => {
    const st = c.status || "draft";
    if (!flt.includes(st)) return false;
    if (latest && st !== "draft" && c.request !== latest) return false;
    return true;
  });
}
function saveFilterPrefs() {
  try { localStorage.setItem("pdfreview.filters", JSON.stringify({ flt: activeFilters(), latest: $("#fltLatest").checked })); } catch {}
}
function loadFilterPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("pdfreview.filters") || "null");
    if (!p) return;
    document.querySelectorAll(".flt").forEach((x) => { x.checked = p.flt.includes(x.value); });
    $("#fltLatest").checked = !!p.latest;
  } catch {}
}
function applyFilters() { saveFilterPrefs(); redrawAll(); renderSidebar(); }

function renderSidebar() {
  const box = $("#comments");
  box.innerHTML = "";
  const hidden = state.data.comments.length;
  const list = visibleComments()
    .sort((a, b) => a.page - b.page || ((a.rects?.[0]?.y || 0) - (b.rects?.[0]?.y || 0)));
  const drafts = state.data.comments.filter((c) => (c.status || "draft") === "draft").length;
  const cites = pendingVerifiedKeys().length;
  const parts = [];
  if (drafts) parts.push(`${drafts} draft${drafts > 1 ? "s" : ""}`);
  if (cites) parts.push(`${cites} approved citation${cites > 1 ? "s" : ""}`);
  $("#submitBtn").textContent = parts.length ? `Submit ${parts.join(" + ")}` : "Nothing to submit";
  $("#submitBtn").disabled = !parts.length;
  for (const chip of document.querySelectorAll(".chip[data-status]"))
    chip.querySelector(".count").textContent = state.data.comments.filter((c) => (c.status || "draft") === chip.dataset.status).length || "";
  if (!list.length) {
    box.append(el("div", { class: "empty", text: hidden ? `${hidden} comment${hidden > 1 ? "s" : ""} hidden by filters.` : "No comments yet. Select text or draw a box on the PDF." }));
    return;
  }
  if (hidden > list.length) box.append(el("div", { class: "hint", text: `${hidden - list.length} hidden by filters` }));
  for (const c of list) {
    const st = c.status || "draft";
    const d = el("div", { class: "comment" + (c.id === state.selectedId ? " selected" : ""), "data-status": st, "data-id": c.id,
      onclick: () => selectComment(c.id, true) });
    d.append(el("div", { class: "meta" }, el("span", { class: "cid", text: c.id }), el("span", { class: "cat", text: c.category }),
      el("span", { text: `p.${c.page}` }), el("span", { class: "badge", text: st })));
    if (c.bibkey) d.append(el("div", { class: "quote mono", text: `\\cite{${c.bibkey}}`, title: c.reftext || "" }));
    else if (c.quote) d.append(el("div", { class: "quote", text: c.quote, title: c.quote }));
    if (c.kind === "box" && !c.quote) d.append(el("div", { class: "quote", text: "[box region]" }));
    d.append(el("div", { class: "text", text: c.text || "" }));
    if (c.note) d.append(el("div", { class: "note", text: `✓ ${c.note}` }));
    const acts = el("div", { class: "actions" });
    acts.append(el("button", { text: "Edit", onclick: (e) => { e.stopPropagation(); openPopupEdit(c); } }));
    if (c.status === "applied" || c.status === "rejected")
      acts.append(el("button", { text: "Reopen", onclick: (e) => { e.stopPropagation(); updateComment(c.id, { status: "draft", note: "" }); } }));
    acts.append(el("button", { text: "Delete", onclick: (e) => { e.stopPropagation(); deleteComment(c.id); } }));
    d.append(acts);
    box.append(d);
  }
}

function selectComment(id, scroll) {
  state.selectedId = id;
  document.querySelectorAll(".comment").forEach((d) => d.classList.toggle("selected", d.dataset.id === id));
  const side = document.querySelector(`.comment[data-id="${id}"]`);
  if (side && !scroll) side.scrollIntoView({ block: "nearest" });
  document.querySelectorAll(".hl[data-id], .tag[data-id]").forEach((h) => h.classList.toggle("sel", h.dataset.id === id));
  const hls = document.querySelectorAll(`.hl[data-id="${id}"], .tag[data-id="${id}"]`);
  if (scroll && hls[0]) hls[0].scrollIntoView({ block: "center", behavior: "smooth" });
  hls.forEach((h) => { h.classList.remove("flash"); void h.offsetWidth; h.classList.add("flash"); });
}

// ---------------------------------------------------------------- popup
const popup = $("#popup");
function showPopupAt(x, y) {
  popup.hidden = false;
  const w = 340, h = 270;
  popup.style.left = `${Math.min(x, window.innerWidth - w - 10)}px`;
  popup.style.top = `${Math.min(y, window.innerHeight - h - 10)}px`;
  $("#popupText").focus();
}
function openPopupNew(pending, x, y) {
  state.pending = pending;
  $("#popupTitle").textContent = pending.kind === "box" ? `New box comment (p.${pending.page})` : pending.kind === "citation" ? `Flag citation ${pending.bibkey}` : `New comment (p.${pending.page})`;
  $("#popupQuote").textContent = pending.quote || "[box region]";
  $("#popupCategory").value = pending.kind === "box" ? "figure" : "edit";
  $("#popupText").value = "";
  showPopupAt(x, y);
}
function openPopupEdit(c) {
  state.pending = { editId: c.id };
  $("#popupTitle").textContent = `Edit ${c.id}`;
  $("#popupQuote").textContent = c.quote || "[box region]";
  $("#popupCategory").value = c.category || "edit";
  $("#popupText").value = c.text || "";
  showPopupAt(window.innerWidth / 2 - 170, window.innerHeight / 3);
}
function closePopup() { popup.hidden = true; state.pending = null; clearRubber(); }
$("#popupCancel").onclick = closePopup;
$("#popupSave").onclick = () => {
  const text = $("#popupText").value.trim();
  const category = $("#popupCategory").value;
  if (!state.pending) return closePopup();
  if (state.pending.editId) updateComment(state.pending.editId, { text, category });
  else if (text) addComment({ ...state.pending, text, category });
  closePopup();
};
$("#popupText").addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePopup();
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#popupSave").click();
});

// ---------------------------------------------------------------- text selection
function pageOfNode(node) {
  const e = node.nodeType === 1 ? node : node.parentElement;
  const div = e?.closest(".page");
  return div ? state.pages[parseInt(div.dataset.page) - 1] : null;
}
function normRects(clientRects, P) {
  const pr = P.div.getBoundingClientRect();
  const out = [];
  for (const r of clientRects) {
    if (r.width < 2 || r.height < 2) continue;
    const n = { x: (r.left - pr.left) / pr.width, y: (r.top - pr.top) / pr.height, w: r.width / pr.width, h: r.height / pr.height };
    // merge with previous if same line (overlapping vertically & adjacent)
    const p = out[out.length - 1];
    if (p && Math.abs(p.y - n.y) < 0.004 && Math.abs(p.h - n.h) < 0.006 && n.x <= p.x + p.w + 0.01) { p.w = Math.max(p.x + p.w, n.x + n.w) - p.x; }
    else out.push(n);
  }
  return out;
}
function contextAround(P, quote) {
  const full = [...P.textLayer.querySelectorAll("span")].map((s) => s.textContent)
    .filter((t) => !/^\s*\d{3}\s*$/.test(t)).join(" ").replace(/\s+/g, " ");
  const q = quote.replace(/\s+/g, " ").trim();
  let i = full.indexOf(q), j = i + q.length;
  if (i < 0) {
    // whitespace-insensitive fallback (pdf.js may split words into several spans)
    const map = []; let compact = "";
    for (let k = 0; k < full.length; k++) if (full[k] !== " ") { map.push(k); compact += full[k]; }
    const cq = q.replace(/ /g, "");
    const ci = compact.indexOf(cq);
    if (ci < 0) return "";
    i = map[ci]; j = map[ci + cq.length - 1] + 1;
  }
  return full.slice(Math.max(0, i - 160), Math.min(full.length, j + 160));
}

document.addEventListener("mouseup", (e) => {
  if (state.mode !== "text" || !popup.hidden) return;
  const t = e.target instanceof Element ? e.target : null;
  if (t && (t.closest("#sidebar") || t.closest("#popup"))) return;
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const P = pageOfNode(range.startContainer);
    if (!P || !P.textLayer.contains(range.startContainer)) return;
    const quote = sel.toString().replace(/\s+/g, " ").trim();
    if (!quote) return;
    const rects = normRects(range.getClientRects(), P);
    if (!rects.length) return;
    openPopupNew({ kind: "text", page: P.num, quote, context: contextAround(P, quote), rects }, e.clientX + 10, e.clientY + 10);
    sel.removeAllRanges();
  }, 10);
});

// ---------------------------------------------------------------- box drawing
let rubber = null;
function clearRubber() { rubber?.remove(); rubber = null; }
function attachBoxDrawing(P) {
  let start = null;
  P.drawLayer.addEventListener("mousedown", (e) => {
    if (state.mode !== "box" || !popup.hidden) return;
    e.preventDefault();
    const pr = P.div.getBoundingClientRect();
    start = { x: e.clientX - pr.left, y: e.clientY - pr.top };
    clearRubber();
    rubber = el("div", { class: "rubber" });
    P.div.append(rubber);
  });
  const move = (e) => {
    if (!start || !rubber) return;
    const pr = P.div.getBoundingClientRect();
    const x = Math.max(0, Math.min(pr.width, e.clientX - pr.left)), y = Math.max(0, Math.min(pr.height, e.clientY - pr.top));
    rubber.style.left = `${Math.min(start.x, x)}px`; rubber.style.top = `${Math.min(start.y, y)}px`;
    rubber.style.width = `${Math.abs(x - start.x)}px`; rubber.style.height = `${Math.abs(y - start.y)}px`;
  };
  const up = (e) => {
    if (!start) return;
    const pr = P.div.getBoundingClientRect();
    const x = Math.max(0, Math.min(pr.width, e.clientX - pr.left)), y = Math.max(0, Math.min(pr.height, e.clientY - pr.top));
    const r = { x: Math.min(start.x, x) / pr.width, y: Math.min(start.y, y) / pr.height, w: Math.abs(x - start.x) / pr.width, h: Math.abs(y - start.y) / pr.height };
    start = null;
    if (r.w < 0.01 || r.h < 0.01) { clearRubber(); return; }
    // grab text under the box as a hint
    const quote = textInRect(P, r);
    openPopupNew({ kind: "box", page: P.num, rects: [r], quote: quote ? quote.slice(0, 300) : "" }, e.clientX + 10, e.clientY + 10);
  };
  P.drawLayer.addEventListener("mousemove", move);
  P.drawLayer.addEventListener("mouseup", up);
}
function textInRect(P, r) {
  const pr = P.div.getBoundingClientRect();
  const parts = [];
  for (const span of P.textLayer.querySelectorAll("span")) {
    const b = span.getBoundingClientRect();
    const cx = (b.left + b.width / 2 - pr.left) / pr.width, cy = (b.top + b.height / 2 - pr.top) / pr.height;
    if (/^\s*\d{3}\s*$/.test(span.textContent)) continue; // margin line numbers (ICLR/NeurIPS drafts)
    if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) parts.push(span.textContent);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- crops
function cropFor(c) {
  const P = state.pages[c.page - 1];
  if (!P || !c.rects?.length) return null;
  const xs = c.rects.map((r) => r.x), ys = c.rects.map((r) => r.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const x1 = Math.max(...c.rects.map((r) => r.x + r.w)), y1 = Math.max(...c.rects.map((r) => r.y + r.h));
  const pad = c.kind === "box" ? 0.005 : 0.02;
  const cw = P.canvas.width, ch = P.canvas.height;
  const sx = Math.max(0, (x0 - pad) * cw), sy = Math.max(0, (y0 - pad) * ch);
  const sw = Math.min(cw - sx, (x1 - x0 + 2 * pad) * cw), sh = Math.min(ch - sy, (y1 - y0 + 2 * pad) * ch);
  if (sw < 4 || sh < 4) return null;
  const out = document.createElement("canvas");
  const k = Math.min(1, 1400 / sw); // keep crops reasonably small for upload
  out.width = Math.round(sw * k); out.height = Math.round(sh * k);
  out.getContext("2d").drawImage(P.canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

// ---------------------------------------------------------------- submit
$("#submitBtn").onclick = async () => {
  const drafts = state.data.comments.filter((c) => (c.status || "draft") === "draft");
  if (!drafts.length && !pendingVerifiedKeys().length) return;
  const btn = $("#submitBtn"), box = $("#submitResult");
  const fail = (msg) => { box.hidden = false; box.classList.add("error"); box.textContent = `Submit failed: ${msg}`; console.error("submit failed", msg); };
  btn.disabled = true; btn.textContent = "Submitting…"; box.hidden = true; box.classList.remove("error");
  try {
    clearTimeout(state.saveTimer);
    const saved = await api.put(`/api/annotations/${state.pdf.id}`, state.data);
    if (!saved.ok) throw new Error(`could not save comments (${JSON.stringify(saved)})`);
    const ids = drafts.map((c) => c.id);
    const crops = {};
    for (const c of drafts) { try { const d = cropFor(c); if (d) crops[c.id] = d; } catch (e) { console.warn("crop failed", c.id, e); } }
    let res;
    try {
      res = await api.post(`/api/submit/${state.pdf.id}`, { ids, crops });
    } catch (e) {
      // large crop upload may fail behind a proxy/tunnel: retry without images
      console.warn("submit with crops failed, retrying without crops", e);
      res = await api.post(`/api/submit/${state.pdf.id}`, { ids, crops: {} });
      res.noCrops = true;
    }
    if (!res.ok) throw new Error(res.error || "server error");
    state.data = await api.get(`/api/annotations/${state.pdf.id}`);
    redrawAll(); renderSidebar(); loadRequests();
    const prompt = `Please check the revision request in pdf_review/${res.path} and apply the requested changes to the sources. Mark each item as resolved with "python3 pdf_review/server.py resolve".`;
    box.hidden = false; box.innerHTML = "";
    box.append(el("div", {}, `Wrote ${res.count} item(s)${res.cites ? ` + ${res.cites} approved citation(s)` : ""} to `, el("code", { text: res.path }), res.noCrops ? " (crop images could not be uploaded)" : ""));
    redrawCites();
    box.append(el("button", { text: "Copy prompt for the assistant", onclick: () => navigator.clipboard.writeText(prompt).catch(() => alert(prompt)) }));
  } catch (e) {
    fail(e.message || String(e));
  } finally {
    renderSidebar(); // restores the button label/disabled state
  }
};

async function loadRequests() {
  const list = await api.get(`/api/requests/${state.pdf.id}`);
  const ul = $("#requestsList");
  ul.innerHTML = "";
  for (const r of list) ul.append(el("li", { text: r.path }));
  if (!list.length) ul.append(el("li", { text: "none yet" }));
}

// ---------------------------------------------------------------- modes, zoom, misc
function setMode(m) {
  state.mode = m; document.body.dataset.mode = m;
  $("#modeText").classList.toggle("active", m === "text");
  $("#modeBox").classList.toggle("active", m === "box");
  $("#modeNav").classList.toggle("active", m === "nav");
  $("#modeCite").classList.toggle("active", m === "cite");
  if (m !== "cite") closeCitePanel();
}
$("#modeCite").onclick = () => setMode("cite");
$("#modeText").onclick = () => setMode("text");
$("#modeBox").onclick = () => setMode("box");
$("#modeNav").onclick = () => setMode("nav");
document.addEventListener("keydown", (e) => {
  if (e.target.matches("textarea, input, select")) return;
  if (e.key === "t") setMode("text"); if (e.key === "b") setMode("box"); if (e.key === "n") setMode("nav"); if (e.key === "c") setMode("cite");
  if (e.key === "Escape") closePopup();
});
$("#zoomIn").onclick = () => { state.fitWidth = false; state.scale *= 1.2; renderAll(); };
$("#zoomOut").onclick = () => { state.fitWidth = false; state.scale /= 1.2; renderAll(); };
$("#zoomFit").onclick = () => { state.fitWidth = true; renderAll(); };
$("#pdfSelect").onchange = (e) => openPdf(e.target.value);
$("#reloadBtn").onclick = () => openPdf(state.pdf.id);
$("#reloadNow").onclick = () => openPdf(state.pdf.id);
document.querySelectorAll(".flt").forEach((x) => x.addEventListener("change", applyFilters));
$("#fltLatest").addEventListener("change", applyFilters);
$("#fltHideResolved").onclick = () => { document.querySelectorAll(".flt").forEach((x) => { x.checked = !["applied", "rejected"].includes(x.value); }); applyFilters(); };
$("#fltAll").onclick = () => { document.querySelectorAll(".flt").forEach((x) => { x.checked = true; }); $("#fltLatest").checked = false; applyFilters(); };
loadFilterPrefs();

// poll for PDF changes on disk (e.g. after recompiling LaTeX)
setInterval(async () => {
  if (!state.pdf) return;
  const pdfs = await api.get("/api/pdfs").catch(() => null);
  if (!pdfs) return;
  state.pdfs = pdfs;
  const cur = pdfs.find((p) => p.id === state.pdf.id);
  if (cur && cur.mtime !== state.pdfMtime) $("#pdfChanged").hidden = false;
}, 4000);

setMode("text");
loadPdfList();
