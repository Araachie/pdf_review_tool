#!/usr/bin/env python3
"""
PDF Review Tool -- local web server.

Serves a pdf.js based viewer in which you can highlight text or draw boxes over
figures/tables, attach comments, and export them as a "revision request"
markdown file that an assistant (or a human) can act on.

Usage
-----
    python3 server.py serve  [--port 8765] [--config config.json] [PDF ...]
    python3 server.py list   [--config config.json]           # list PDFs & pending comments
    python3 server.py show   <pdf-id> [--all]                 # print comments for a PDF
    python3 server.py resolve <pdf-id> <comment-id> [...] [--note "..."] [--status applied|rejected|pending]

Only the Python standard library is used.
"""
import argparse
import base64
import datetime as dt
import glob
import hashlib
import json
import mimetypes
import os
import re
import sys
import threading
import webbrowser
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")
VENDOR_DIR = os.path.join(HERE, "vendor")
DATA_DIR = os.path.join(HERE, "data")
REQUESTS_DIR = os.path.join(HERE, "requests")
DEFAULT_CONFIG = os.path.join(HERE, "config.json")

STATUSES = ("draft", "submitted", "applied", "rejected", "pending")


# --------------------------------------------------------------------------- #
# Configuration / PDF discovery
# --------------------------------------------------------------------------- #
def load_config(path):
    if path and os.path.exists(path):
        with open(path) as f:
            cfg = json.load(f)
    else:
        cfg = {}
    cfg.setdefault("pdfs", [])
    cfg.setdefault("root", os.path.dirname(HERE))  # project root = parent of tool dir
    cfg["root"] = os.path.abspath(os.path.join(HERE, cfg["root"])) if not os.path.isabs(cfg["root"]) else cfg["root"]
    return cfg


def pdf_id_for(path):
    """Stable, filesystem-safe id for a PDF path."""
    base = re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.splitext(os.path.basename(path))[0])
    h = hashlib.sha1(os.path.abspath(path).encode()).hexdigest()[:6]
    return f"{base}-{h}"


def discover_pdfs(cfg, extra_paths=()):
    """Return list of dicts {id, name, path, sources, notes}."""
    out, seen = [], set()

    def add(path, sources=None, notes=None, name=None, bib=None, on_verified=None):
        if bib and not os.path.isabs(bib):
            bib = os.path.join(cfg["root"], bib)
        path = os.path.abspath(path)
        if not os.path.isfile(path) or path in seen:
            return
        seen.add(path)
        out.append({
            "id": pdf_id_for(path),
            "name": name or os.path.relpath(path, cfg["root"]) if path.startswith(cfg["root"]) else (name or path),
            "path": path,
            "sources": sources or "",
            "notes": notes or "",
            "bib": bib or "",
            "on_verified": on_verified or "",
            "mtime": os.path.getmtime(path),
        })

    for entry in cfg["pdfs"]:
        if isinstance(entry, str):
            entry = {"path": entry}
        pat = entry["path"]
        if not os.path.isabs(pat):
            pat = os.path.join(cfg["root"], pat)
        matches = sorted(glob.glob(pat))
        for m in matches:
            add(m, entry.get("sources"), entry.get("notes"), entry.get("name") if len(matches) == 1 else None,
                entry.get("bib"), entry.get("on_verified"))
    for p in extra_paths:
        add(p)
    return out


# --------------------------------------------------------------------------- #
# Annotation storage
# --------------------------------------------------------------------------- #
def ann_path(pdf_id):
    os.makedirs(DATA_DIR, exist_ok=True)
    return os.path.join(DATA_DIR, f"{pdf_id}.json")


def load_annotations(pdf_id):
    p = ann_path(pdf_id)
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    return {"pdf_id": pdf_id, "comments": []}


def save_annotations(pdf_id, data):
    data["pdf_id"] = pdf_id
    data["updated"] = dt.datetime.now().isoformat(timespec="seconds")
    tmp = ann_path(pdf_id) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, ann_path(pdf_id))


# --------------------------------------------------------------------------- #
# BibTeX + bibliographic lookup (for citation verification)
# --------------------------------------------------------------------------- #
_bib_cache = {}


def parse_bib(path):
    """Very small BibTeX parser: returns {key: {"type", "raw", "fields"}}."""
    if not path or not os.path.exists(path):
        return {}
    mtime = os.path.getmtime(path)
    cached = _bib_cache.get(path)
    if cached and cached[0] == mtime:
        return cached[1]
    with open(path, encoding="utf-8", errors="replace") as f:
        txt = f.read()
    entries = {}
    for m in re.finditer(r"@(\w+)\s*\{\s*([^,\s]+)\s*,", txt):
        etype, key = m.group(1), m.group(2)
        if etype.lower() in ("comment", "preamble", "string"):
            continue
        # brace matching from the opening brace
        i = m.start() + txt[m.start():].index("{")
        depth, j = 0, i
        while j < len(txt):
            if txt[j] == "{":
                depth += 1
            elif txt[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        raw = txt[m.start():j + 1]
        body = txt[m.end():j]
        fields = {}
        for fm in re.finditer(r"(\w+)\s*=\s*(\{((?:[^{}]|\{[^{}]*\})*)\}|\"([^\"]*)\"|(\w+))", body):
            val = fm.group(3) if fm.group(3) is not None else (fm.group(4) if fm.group(4) is not None else fm.group(5))
            fields[fm.group(1).lower()] = re.sub(r"\s+", " ", val.replace("{", "").replace("}", "")).strip()
        entries[key] = {"type": etype, "key": key, "raw": raw, "fields": fields}
    _bib_cache[path] = (mtime, entries)
    return entries


_lookup_cache = {}


def _http_json(url, timeout=8):
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "pdf-review-tool/1.0 (mailto:reviewer@example.org)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _norm_title(t):
    return re.sub(r"[^a-z0-9 ]", "", (t or "").lower()).strip()


def _similarity(a, b):
    import difflib
    a, b = _norm_title(a), _norm_title(b)
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def lookup_reference(query, title=None, year=None, authors=None):
    """Query Crossref, OpenAlex, arXiv (and best-effort Semantic Scholar). Returns ranked matches."""
    from urllib.parse import quote_plus
    ckey = (query, title, year, authors)
    if ckey in _lookup_cache:
        return _lookup_cache[ckey]
    results, errors = [], []
    q = quote_plus(query[:300])
    # Crossref
    try:
        j = _http_json(f"https://api.crossref.org/works?query.bibliographic={q}&rows=4"
                       f"&select=title,author,issued,DOI,container-title,URL,type")
        for it in j.get("message", {}).get("items", []):
            yr = None
            for k in ("issued",):
                dp = (it.get(k) or {}).get("date-parts") or [[None]]
                yr = dp[0][0]
            results.append({
                "source": "Crossref",
                "title": " ".join(it.get("title") or []),
                "authors": [" ".join(x for x in (a.get("given"), a.get("family")) if x) for a in it.get("author", [])][:8],
                "year": yr,
                "venue": " ".join(it.get("container-title") or []),
                "doi": it.get("DOI"),
                "url": it.get("URL") or (f"https://doi.org/{it['DOI']}" if it.get("DOI") else None),
            })
    except Exception as e:
        errors.append(f"Crossref: {type(e).__name__}: {e}")
    # OpenAlex
    try:
        j = _http_json(f"https://api.openalex.org/works?search={q}&per-page=4"
                       f"&select=title,authorships,publication_year,doi,primary_location,id")
        for it in j.get("results", []):
            loc = it.get("primary_location") or {}
            src = (loc.get("source") or {}).get("display_name") or ""
            results.append({
                "source": "OpenAlex",
                "title": it.get("title") or "",
                "authors": [(a.get("author") or {}).get("display_name", "") for a in it.get("authorships", [])][:8],
                "year": it.get("publication_year"),
                "venue": src,
                "doi": (it.get("doi") or "").replace("https://doi.org/", "") or None,
                "url": loc.get("landing_page_url") or it.get("doi") or it.get("id"),
            })
    except Exception as e:
        errors.append(f"OpenAlex: {type(e).__name__}: {e}")
    # Semantic Scholar (often rate limited without a key -> best effort)
    try:
        j = _http_json("https://api.semanticscholar.org/graph/v1/paper/search?query="
                       f"{q}&limit=3&fields=title,authors,year,venue,externalIds,url", timeout=5)
        for it in j.get("data", []):
            ext = it.get("externalIds") or {}
            results.append({
                "source": "Semantic Scholar",
                "title": it.get("title") or "",
                "authors": [a.get("name", "") for a in it.get("authors", [])][:8],
                "year": it.get("year"),
                "venue": it.get("venue") or "",
                "doi": ext.get("DOI"),
                "arxiv": ext.get("ArXiv"),
                "url": it.get("url"),
            })
    except Exception as e:
        errors.append(f"Semantic Scholar: {type(e).__name__}: {e}")
    # arXiv (many ML references are arXiv-only and missing from Crossref)
    try:
        import xml.etree.ElementTree as ET
        import urllib.request
        aq = quote_plus(re.sub(r"[^\w\s]", " ", (title or query))[:200])
        ns = {"a": "http://www.w3.org/2005/Atom"}
        entries = []
        for sq in (f"ti:%22{aq}%22", f"all:{aq}"):  # exact title phrase first, loose search only as fallback
            req = urllib.request.Request(f"http://export.arxiv.org/api/query?search_query={sq}&max_results=4",
                                         headers={"User-Agent": "pdf-review-tool/1.0"})
            with urllib.request.urlopen(req, timeout=8) as r:
                entries = ET.fromstring(r.read()).findall("a:entry", ns)
            if entries:
                break
        for e in entries:
            aid = (e.findtext("a:id", "", ns) or "").rsplit("/abs/", 1)[-1]
            results.append({
                "source": "arXiv",
                "title": re.sub(r"\s+", " ", e.findtext("a:title", "", ns) or "").strip(),
                "authors": [x.findtext("a:name", "", ns) for x in e.findall("a:author", ns)][:8],
                "year": (e.findtext("a:published", "", ns) or "")[:4] or None,
                "venue": "arXiv",
                "arxiv": aid,
                "url": e.findtext("a:id", "", ns),
            })
    except Exception as e:
        errors.append(f"arXiv: {type(e).__name__}: {e}")
    ref_title = title or query
    ref_surnames = set()
    for a in re.split(r"\s+and\s+|,\s*", authors or ""):
        a = a.strip()
        if a:
            sur = a.split(",")[0].strip() if "," in a else a.split()[-1]
            ref_surnames.add(_norm_title(sur))
    ref_surnames.discard("")
    for r in results:
        r["score"] = round(_similarity(ref_title, r["title"]), 3)
        if year and r.get("year") and str(r["year"]) != str(year):
            r["year_mismatch"] = True
        if ref_surnames:
            got = set()
            for a in r.get("authors") or []:
                got.update(_norm_title(w) for w in a.split())
            r["author_match"] = bool(ref_surnames & got)
    # de-duplicate by normalised title, keep best score
    seen = {}
    for r in sorted(results, key=lambda r: (-(r["score"] + (0.15 if r.get("author_match") else 0)))):
        k = _norm_title(r["title"])[:80]
        if k and k not in seen:
            seen[k] = r
    out = {"query": query, "matches": list(seen.values())[:6], "errors": errors}
    _lookup_cache[ckey] = out
    return out


# --------------------------------------------------------------------------- #
# Revision request export
# --------------------------------------------------------------------------- #
def pending_verified_keys(data):
    """Citation keys the reviewer marked verified that were not yet sent in a revision request."""
    cites = data.get("citations") or {}
    return sorted(k for k, v in cites.items() if v.get("status") == "verified" and not v.get("sent"))


def write_revision_request(pdf_info, data, comment_ids, crops):
    """Write a markdown revision request + crop PNGs. Returns the md path."""
    now = dt.datetime.now()
    stamp = now.strftime("%Y%m%d_%H%M%S")
    req_dir = os.path.join(REQUESTS_DIR, pdf_info["id"], stamp)
    os.makedirs(req_dir, exist_ok=True)

    comments = [c for c in data["comments"] if c["id"] in comment_ids]
    comments.sort(key=lambda c: (c.get("page", 0), (c.get("rects") or [{}])[0].get("y", 0)))

    lines = []
    lines.append(f"# Revision request: {pdf_info['name']}")
    lines.append("")
    lines.append(f"- Submitted: {now.isoformat(timespec='seconds')}")
    lines.append(f"- PDF: `{pdf_info['path']}`")
    if pdf_info.get("sources"):
        lines.append(f"- Sources: `{pdf_info['sources']}`")
    if pdf_info.get("notes"):
        lines.append(f"- Notes: {pdf_info['notes']}")
    lines.append(f"- PDF id: `{pdf_info['id']}`")
    verified = pending_verified_keys(data)
    lines.append(f"- Items: {len(comments)}" + (f" + {len(verified)} approved citations" if verified else ""))
    lines.append("")
    lines.append("Instructions for the assistant: for each item, locate the anchor text (or the "
                 "figure/table shown in the crop) in the source files, apply the requested change, "
                 "then mark it with `python3 pdf_review/server.py resolve <pdf-id> <item-id> --note \"what was done\"`. "
                 "Items with a citation key concern a possibly wrong or unverifiable reference: check the real "
                 "publication, correct the BibTeX entry (title, authors, venue, year, DOI/arXiv id) or replace/remove "
                 "the citation in the LaTeX as requested. Never invent bibliographic data.")
    lines.append("")

    for c in comments:
        cid = c["id"]
        kind = c.get("kind", "text")
        cat = c.get("category", "edit")
        lines.append(f"## {cid} [{cat}] page {c.get('page')}  ({kind})")
        lines.append("")
        quote = (c.get("quote") or "").strip()
        if quote:
            q = re.sub(r"\s+", " ", quote)
            lines.append(f"**Anchor text:** \"{q}\"")
            lines.append("")
        if c.get("context"):
            ctx = re.sub(r"\s+", " ", c["context"]).strip()
            lines.append(f"**Context:** ...{ctx}...")
            lines.append("")
        rects = c.get("rects") or []
        if rects:
            r = rects[0]
            lines.append(f"**Location:** page {c.get('page')}, x={r.get('x', 0):.2f} y={r.get('y', 0):.2f} "
                         f"w={r.get('w', 0):.2f} h={r.get('h', 0):.2f} (fractions of page)")
            lines.append("")
        crop = crops.get(cid)
        if crop:
            png_path = os.path.join(req_dir, f"{cid}.png")
            b64 = crop.split(",", 1)[-1]
            with open(png_path, "wb") as f:
                f.write(base64.b64decode(b64))
            lines.append(f"**Crop:** `{os.path.relpath(png_path, HERE)}`")
            lines.append("")
        if c.get("bibkey"):
            lines.append(f"**Citation key:** `{c['bibkey']}`  (fix in the .bib file and/or the \\cite command)")
            lines.append("")
            entry = parse_bib(pdf_info.get("bib")).get(c["bibkey"])
            if entry:
                lines.append("```bibtex")
                lines.extend(entry["raw"].splitlines())
                lines.append("```")
                lines.append("")
            if c.get("reftext"):
                printed = re.sub(r"\s+", " ", c["reftext"]).strip()
                lines.append(f"**Reference as printed:** {printed}")
                lines.append("")
        lines.append("**Request:**")
        lines.append("")
        for ln in (c.get("text") or "").strip().splitlines() or ["(no text)"]:
            lines.append(f"> {ln}")
        lines.append("")
        lines.append(f"- [ ] {cid}: pending")
        lines.append("")

    if verified:
        lines.append("## CITES [citations] approved citations (verified manually by the reviewer)")
        lines.append("")
        lines.append("The reviewer verified these citation keys against the real publications and approves them. "
                     "Apply the project's action for approved citations:")
        lines.append("")
        lines.append(f"> {pdf_info.get('on_verified') or 'Remove any new-citation highlighting for these keys in the sources.'}")
        lines.append("")
        entries = parse_bib(pdf_info.get("bib"))
        for k in verified:
            t = (entries.get(k) or {}).get("fields", {}).get("title", "")
            lines.append(f"- `{k}`" + (f" -- {t}" if t else ""))
        lines.append("")
        lines.append("- [ ] CITES: pending")
        lines.append("")

    md_path = os.path.join(req_dir, "revision_request.md")
    with open(md_path, "w") as f:
        f.write("\n".join(lines))
    for k in verified:
        data["citations"][k]["sent"] = os.path.relpath(md_path, HERE)

    # mark comments as submitted
    for c in data["comments"]:
        if c["id"] in comment_ids:
            c["status"] = "submitted"
            c["request"] = os.path.relpath(md_path, HERE)
            c["submitted"] = now.isoformat(timespec="seconds")
    save_annotations(pdf_info["id"], data)
    return md_path


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #
def url_parts(path):
    """URL path segments, or None if a segment could escape a directory ('..', encoded '/')."""
    parts = [unquote(x) for x in path.strip("/").split("/") if x]
    if any(p in (".", "..") or "/" in p or "\\" in p or "\0" in p for p in parts):
        return None
    return parts


class Handler(SimpleHTTPRequestHandler):
    cfg = None
    extra_pdfs = ()
    lock = threading.Lock()

    def log_message(self, fmt, *args):  # quieter log
        try:
            msg = fmt % args
        except Exception:
            msg = str(fmt)
        # hide the chatty polling / asset requests, keep everything else (POST, PUT, errors)
        if any(x in msg for x in ('"GET /api/pdfs', '"GET /api/annotations', '"GET /api/pdf/', '"GET /api/requests',
                                  '"GET /static', '"GET /vendor', '"GET / HTTP')):
            return
        super().log_message(fmt, *args)

    # ---- helpers ----
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path, ctype=None):
        if not os.path.isfile(path):
            self.send_error(404)
            return
        ctype = ctype or mimetypes.guess_type(path)[0] or "application/octet-stream"
        if path.endswith(".mjs"):
            ctype = "text/javascript"
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    def _pdfs(self):
        return discover_pdfs(self.cfg, self.extra_pdfs)

    def _pdf(self, pdf_id):
        for p in self._pdfs():
            if p["id"] == pdf_id:
                return p
        return None

    # ---- routes ----
    def do_GET(self):
        u = urlparse(self.path)
        parts = url_parts(u.path)
        if parts is None:
            return self.send_error(400)
        if not parts:
            return self._file(os.path.join(STATIC_DIR, "index.html"), "text/html; charset=utf-8")
        if parts == ["favicon.ico"]:
            self.send_response(204)
            self.end_headers()
            return
        if parts[0] == "static" and len(parts) == 2:
            return self._file(os.path.join(STATIC_DIR, os.path.basename(parts[1])))
        if parts[0] == "vendor" and len(parts) == 2:
            return self._file(os.path.join(VENDOR_DIR, os.path.basename(parts[1])))
        if parts[0] == "api":
            if parts[1:] == ["pdfs"]:
                return self._json(self._pdfs())
            if len(parts) == 3 and parts[1] == "pdf":
                p = self._pdf(parts[2])
                return self._file(p["path"], "application/pdf") if p else self.send_error(404)
            if len(parts) == 3 and parts[1] == "annotations":
                with self.lock:
                    return self._json(load_annotations(parts[2]))
            if len(parts) == 3 and parts[1] == "citations":     # verification summary (CLI/agents)
                with self.lock:
                    return self._json(load_annotations(parts[2]).get("citations", {}))
            if len(parts) == 3 and parts[1] == "requests":
                return self._json(list_requests(parts[2]))
            if len(parts) == 3 and parts[1] == "bib":           # all entries of a pdf's bib
                p = self._pdf(parts[2])
                if not p:
                    return self.send_error(404)
                entries = parse_bib(p.get("bib"))
                return self._json({"path": p.get("bib"), "keys": sorted(entries), "count": len(entries)})
            if len(parts) == 4 and parts[1] == "bib":           # one entry
                p = self._pdf(parts[2])
                entry = parse_bib(p.get("bib")).get(parts[3]) if p else None
                return self._json(entry or {"error": "not found", "key": parts[3]}, 200 if entry else 404)
            if parts[1:] == ["lookup"]:
                from urllib.parse import parse_qs
                qs = parse_qs(u.query)
                query = (qs.get("q") or [""])[0].strip()
                if not query:
                    return self._json({"error": "missing q"}, 400)
                return self._json(lookup_reference(query, (qs.get("title") or [None])[0], (qs.get("year") or [None])[0],
                                                    (qs.get("authors") or [None])[0]))
            if len(parts) >= 3 and parts[1] == "crop":
                # serve a crop image from the requests dir
                full = os.path.realpath(os.path.join(REQUESTS_DIR, *parts[2:]))
                if not full.startswith(os.path.realpath(REQUESTS_DIR) + os.sep):
                    return self.send_error(403)
                return self._file(full)
        self.send_error(404)

    def do_PUT(self):
        parts = url_parts(urlparse(self.path).path) or []
        if len(parts) == 3 and parts[:2] == ["api", "annotations"]:
            data = self._body()
            with self.lock:
                save_annotations(parts[2], data)
            return self._json({"ok": True})
        self.send_error(404)

    def do_POST(self):
        try:
            return self._do_POST()
        except Exception as e:  # make failures visible in the terminal and to the client
            import traceback; traceback.print_exc()
            return self._json({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)

    def _do_POST(self):
        parts = url_parts(urlparse(self.path).path) or []
        if len(parts) == 3 and parts[:2] == ["api", "submit"]:
            pdf = self._pdf(parts[2])
            if not pdf:
                return self.send_error(404)
            body = self._body()
            with self.lock:
                data = load_annotations(pdf["id"])
                ids = set(body.get("ids") or [c["id"] for c in data["comments"] if c.get("status", "draft") == "draft"])
                n_cites = len(pending_verified_keys(data))
                if not ids and not n_cites:
                    return self._json({"ok": False, "error": "nothing to submit"}, 400)
                md = write_revision_request(pdf, data, ids, body.get("crops") or {})
            return self._json({"ok": True, "path": os.path.relpath(md, HERE), "count": len(ids), "cites": n_cites})
        self.send_error(404)


def list_requests(pdf_id):
    base = os.path.join(REQUESTS_DIR, pdf_id)
    out = []
    if os.path.isdir(base):
        for d in sorted(os.listdir(base), reverse=True):
            md = os.path.join(base, d, "revision_request.md")
            if os.path.exists(md):
                out.append({"stamp": d, "path": os.path.relpath(md, HERE)})
    return out


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def cmd_serve(args):
    cfg = load_config(args.config)
    Handler.cfg = cfg
    Handler.extra_pdfs = tuple(os.path.abspath(p) for p in args.pdfs)
    pdfs = discover_pdfs(cfg, Handler.extra_pdfs)
    if not pdfs:
        print("No PDFs found. Add entries to config.json or pass PDF paths on the command line.")
    for p in pdfs:
        print(f"  [{p['id']}] {p['name']}")
    srv = HTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/"
    print(f"PDF review tool running at {url}  (Ctrl-C to stop)")
    if args.open:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def cmd_list(args):
    cfg = load_config(args.config)
    for p in discover_pdfs(cfg):
        data = load_annotations(p["id"])
        counts = {}
        for c in data["comments"]:
            counts[c.get("status", "draft")] = counts.get(c.get("status", "draft"), 0) + 1
        print(f"[{p['id']}] {p['name']}  {counts or 'no comments'}")
        for r in list_requests(p["id"]):
            print(f"    request: {r['path']}")


def cmd_show(args):
    data = load_annotations(args.pdf_id)
    cites = data.get("citations") or {}
    if cites:
        groups = {}
        for k, v in sorted(cites.items()):
            st = v.get("status", "?") + (" (uncoloured)" if v.get("uncolored") else (" (sent)" if v.get("sent") else ""))
            groups.setdefault(st, []).append(k)
        for st, ks in groups.items():
            print(f"citations {st}: {' '.join(ks)}")
    for c in data["comments"]:
        st = c.get("status", "draft")
        if not args.all and st in ("applied", "rejected"):
            continue
        print(f"{c['id']} [{st}] p{c.get('page')} ({c.get('category', 'edit')}, {c.get('kind', 'text')})")
        if c.get("quote"):
            anchor = re.sub(r"\s+", " ", c["quote"])[:200]
            print(f"    anchor: {anchor}")
        if c.get("bibkey"):
            print(f"    citation key: {c['bibkey']}")
        print(f"    request: {(c.get('text') or '').strip()}")
        if c.get("note"):
            print(f"    note: {c['note']}")


def cmd_resolve(args):
    data = load_annotations(args.pdf_id)
    now = dt.datetime.now().isoformat(timespec="seconds")
    found = 0
    if "CITES" in args.comment_ids:
        # approved citations: mark every verified+sent key of the given (or latest) request as uncoloured
        cites = data.get("citations") or {}
        sent = sorted({v["sent"] for v in cites.values() if v.get("sent") and not v.get("uncolored")})
        target = args.request or (sent[-1] if sent else None)
        keys = [k for k, v in cites.items() if v.get("sent") == target and not v.get("uncolored")]
        for k in keys:
            cites[k]["uncolored"] = now
            if args.note:
                cites[k]["note"] = args.note
        if target:
            md = os.path.join(HERE, target)
            if os.path.exists(md):
                with open(md) as f:
                    txt = f.read()
                txt = re.sub(r"- \[.\] CITES: .*", f"- [x] CITES: {args.status}" + (f" -- {args.note}" if args.note else ""), txt)
                with open(md, "w") as f:
                    f.write(txt)
        print(f"approved citations in {target}: {len(keys)} key(s) marked as uncoloured: {' '.join(keys)}")
        args.comment_ids = [x for x in args.comment_ids if x != "CITES"]
        if not args.comment_ids:
            save_annotations(args.pdf_id, data)
            return
    for c in data["comments"]:
        if c["id"] in args.comment_ids:
            c["status"] = args.status
            c["resolved"] = now
            if args.note:
                c["note"] = args.note
            found += 1
            # tick the checkbox in the request markdown, if any
            if c.get("request"):
                md = os.path.join(HERE, c["request"])
                if os.path.exists(md):
                    with open(md) as f:
                        txt = f.read()
                    mark = "x" if args.status == "applied" else ("-" if args.status == "rejected" else " ")
                    txt = re.sub(rf"- \[.\] {re.escape(c['id'])}: .*",
                                 f"- [{mark}] {c['id']}: {args.status}" + (f" -- {args.note}" if args.note else ""), txt)
                    with open(md, "w") as f:
                        f.write(txt)
    save_annotations(args.pdf_id, data)
    print(f"updated {found}/{len(args.comment_ids)} comments -> {args.status}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("serve")
    s.add_argument("pdfs", nargs="*", help="extra PDF files to serve")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--config", default=DEFAULT_CONFIG)
    s.add_argument("--open", action="store_true", help="open browser")
    s.set_defaults(fn=cmd_serve)
    l = sub.add_parser("list")
    l.add_argument("--config", default=DEFAULT_CONFIG)
    l.set_defaults(fn=cmd_list)
    sh = sub.add_parser("show")
    sh.add_argument("pdf_id")
    sh.add_argument("--all", action="store_true")
    sh.set_defaults(fn=cmd_show)
    r = sub.add_parser("resolve")
    r.add_argument("pdf_id")
    r.add_argument("comment_ids", nargs="+")
    r.add_argument("--note", default="")
    r.add_argument("--status", default="applied", choices=["applied", "rejected", "pending"])
    r.add_argument("--request", default="", help="for CITES: the request path (default: latest with pending citations)")
    r.set_defaults(fn=cmd_resolve)
    args = ap.parse_args()
    if not args.cmd:
        ap.print_help()
        sys.exit(1)
    args.fn(args)


if __name__ == "__main__":
    main()
