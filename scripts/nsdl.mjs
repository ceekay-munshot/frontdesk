/**
 * nsdl.mjs — the security master (identity + rating for every quote).
 * ==================================================================
 * The desk types shorthand — "NABARD 7.5 34", "HDFC Bank CD 13 Nov". This module
 * turns that shorthand into a CONFIRMED security: the exact issuer, the ISIN, the
 * official instrument name, and the credit rating — by matching each quote against
 * NSDL's public depository master lists.
 *
 * NSDL publishes three "detailed lists" as dated downloads on
 * https://nsdl.com/resources/data/detailed-list-debt-instruments :
 *   • Debt Instruments  (bonds/NCDs)  — a big tab-separated .xls, has COUPON + REDEMPTION + RATING
 *   • Commercial Papers (CP)          — a tab-separated .xls,      has MATURITY + RATING
 *   • Certificate of Deposit (CD)     — a small real .xlsx,        has MATURITY + RATING
 * Each is re-posted roughly every ~20 days with a new date in the filename, so we
 * scrape the current dated URLs off the page rather than hard-coding them.
 *
 *   fetchNsdlDirectory() -> { as_of, sources:{debt,cp,cd}, securities:[ {isin,issuer,
 *                            issuer_norm,coupon,maturity,name,rating,type}, … ] }
 *                           or null on any failure (caller keeps the last good
 *                           snapshot — reject-bad-keep-old, like ccil.mjs).
 *
 *   buildNsdlIndex(securities) -> opaque index for fast matching
 *   matchQuote(index, quote)   -> the matched security (or null). Conservative:
 *                                 it returns nothing rather than guess wrong, so a
 *                                 shown ISIN is one the client can trust.
 *
 * Server-side only (the GitHub Action / parser). Zero dependencies: the .xls files
 * are plain TSV, and the small CD .xlsx is unzipped with node:zlib.
 *
 * Node 22 (global fetch). No dependencies.
 */

import { inflateRawSync } from "node:zlib";

const PAGE_URL = "https://nsdl.com/resources/data/detailed-list-debt-instruments";
const ORIGIN = "https://nsdl.com";
// NSDL's WAF returns 503 to a bare User-Agent; a full browser header set gets
// 200. Keep these realistic and complete.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BROWSER_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
};
const pageHeaders = () => ({ ...BROWSER_HEADERS, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" });
const fileHeaders = () => ({ ...BROWSER_HEADERS, Accept: "*/*", "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin", Referer: PAGE_URL });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------------
 * Issuer normalisation — IDENTICAL to public/js/app.js catNorm(), so a desk
 * issuer and an NSDL COMPANY name collapse to the same key ("HDFC BANK LIMITED"
 * and "HDFC Bank" both -> "HDFC BANK"). Keep the two in sync.
 * ------------------------------------------------------------------------ */
const _NORM_SUFFIX = /\b(?:LIMITED|LTD|PVT|PRIVATE|COMPANY|CO|CORPORATION|CORP|THE|AND)\b/g;
export function normIssuer(s) {
  s = String(s || "").toUpperCase().replace(/&/g, " AND ");
  return s.replace(/[^A-Z0-9 ]/g, " ").replace(_NORM_SUFFIX, " ").replace(/\s+/g, " ").trim();
}

/* --------------------------------------------------------------------------
 * Issuer bridge — the desk types acronyms and abbreviations ("SIDBI", "BAJAJ
 * HSG FIN") while NSDL stores full legal names ("SMALL INDUSTRIES DEVELOPMENT
 * BANK OF INDIA", "BAJAJ HOUSING FINANCE LIMITED"). We reconcile the two with:
 *   1) per-token abbreviation expansion (FIN -> FINANCE), and
 *   2) a whole-issuer acronym map for the pure acronyms that share no tokens.
 * Both feed issuerAgrees(); neither ever forces a match on its own. Kept small
 * and high-value: these cover the desk's most-quoted issuers (~80% of volume).
 * ------------------------------------------------------------------------ */
const TOKEN_EXPAND = {
  FIN: "FINANCE", FINL: "FINANCIAL", FINCORP: "FINANCE", FINSERV: "FINSERVE",
  HSG: "HOUSING", HOUS: "HOUSING", HOUSG: "HOUSING", HFL: "HOUSING",
  TELE: "TELECOM", CORPN: "CORPORATION", INDL: "INDUSTRIES", INTL: "INTERNATIONAL",
  DEVP: "DEVELOPMENT", DEVELOP: "DEVELOPMENT", MAH: "MAHINDRA", INV: "INVESTMENT",
  INVT: "INVESTMENT", SECS: "SECURITIES", CAP: "CAPITAL", ENT: "ENTERPRISES",
  INFRA: "INFRASTRUCTURE", PWR: "POWER", NATL: "NATIONAL", MTR: "MOTORS",
  MOT: "MOTORS", SVCS: "SERVICES", SER: "SERVICES",
};
// Whole desk issuer (its normIssuer form) -> the NSDL canonical token string.
const ISSUER_ALIAS = {
  NABARD: "NATIONAL BANK AGRICULTURE RURAL DEVELOPMENT",
  SIDBI: "SMALL INDUSTRIES DEVELOPMENT BANK INDIA",
  IRFC: "INDIAN RAILWAY FINANCE",
  PFC: "POWER FINANCE",
  REC: "RURAL ELECTRIFICATION",
  RECL: "RURAL ELECTRIFICATION",
  NABFID: "NATIONAL BANK FINANCING INFRASTRUCTURE DEVELOPMENT",
  NHB: "NATIONAL HOUSING BANK",
  NHAI: "NATIONAL HIGHWAYS AUTHORITY INDIA",
  PGC: "POWER GRID",
  KMPL: "KOTAK MAHINDRA PRIME",
  KMIL: "KOTAK MAHINDRA INVESTMENTS",
  HUDCO: "HOUSING URBAN DEVELOPMENT",
  EXIM: "EXPORT IMPORT BANK INDIA",
  IREDA: "INDIAN RENEWABLE ENERGY DEVELOPMENT",
  IIFCL: "INDIA INFRASTRUCTURE FINANCE",
  IIFL: "IIFL FINANCE",
  PNBHFL: "PNB HOUSING FINANCE",
  LICHFL: "LIC HOUSING FINANCE",
  TMFL: "TATA MOTORS FINANCE",
  TCCL: "TATA CAPITAL",
  CGCL: "CAPRI GLOBAL CAPITAL",
  SCUF: "SHRIRAM FINANCE",
  STFC: "SHRIRAM FINANCE",
  SGFL: "SHRIRAM FINANCE",
  ABCL: "ADITYA BIRLA CAPITAL",
  ABFL: "ADITYA BIRLA FINANCE",
  ABHFL: "ADITYA BIRLA HOUSING FINANCE",
  GHIAL: "GMR HYDERABAD INTERNATIONAL AIRPORT",
  DIAL: "DELHI INTERNATIONAL AIRPORT",
  MIAL: "MUMBAI INTERNATIONAL AIRPORT",
  RIL: "RELIANCE INDUSTRIES",
  RJIL: "RELIANCE JIO INFOCOMM",
  JFSL: "JIO FINANCIAL SERVICES",
  HDB: "HDB FINANCIAL SERVICES",
  TATACAP: "TATA CAPITAL",
  SMFG: "SMFG INDIA CREDIT",
  CIFC: "CHOLAMANDALAM INVESTMENT",
  MFL: "MUTHOOT FINANCE",
  MMFSL: "MAHINDRA AND MAHINDRA FINANCIAL",
  LNT: "LARSEN TOUBRO",
  LT: "LARSEN TOUBRO",
};

/** All plausible token-sets for a desk (or NSDL) issuer name: the expanded raw
 *  form, plus the acronym expansion when one exists. */
function issuerTokenSets(raw) {
  const base = normIssuer(raw);
  if (!base) return [];
  const expand = (str) => str.split(" ").filter(Boolean).map((t) => TOKEN_EXPAND[t] || t);
  const sets = [new Set(expand(base))];
  if (ISSUER_ALIAS[base]) sets.push(new Set(ISSUER_ALIAS[base].split(" ")));
  // single-token acronym that is itself a key even after expansion
  const firstTok = base.split(" ")[0];
  if (base !== firstTok && ISSUER_ALIAS[firstTok]) sets.push(new Set(ISSUER_ALIAS[firstTok].split(" ")));
  return sets;
}

/* --------------------------------------------------------------------------
 * Field parsers
 * ------------------------------------------------------------------------ */
const ISIN_RE = /^IN[A-Z0-9]{9}[0-9]$/; // Indian ISINs start "IN", 12 chars total
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

/** "7 October 2007" | "7-Oct-2007" -> "2007-10-07"; null if unparseable. */
function parseWordDate(s) {
  const m = String(s || "").trim().match(/^(\d{1,2})[\s-]+([A-Za-z]+)[\s-]+(\d{4})$/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  const d = +m[1];
  if (d < 1 || d > 31) return null;
  return `${m[3]}-${pad(mo)}-${pad(d)}`;
}

/** "05-10-2026" (dd-mm-yyyy) -> "2026-10-05"; null if unparseable. */
function parseDmyDate(s) {
  const m = String(s || "").trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const d = +m[1], mo = +m[2];
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return `${m[3]}-${pad(mo)}-${pad(d)}`;
}

/** "13.00%" | "7.5" -> 13 | 7.5 ; null for floaters / blanks / "0". */
function parseCoupon(s) {
  const m = String(s || "").match(/(\d{1,2}(?:\.\d{1,4})?)\s*%?/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v) || v <= 0 || v > 30) return null; // 0% ZCB / junk -> no coupon key
  return Math.round(v * 100) / 100;
}

/** Pull the first standard credit-rating symbol out of a messy rating cell.
 *  "ICRA-26 AAA,CRISIL AA+" -> "AAA". Falls back to a trimmed raw string. */
const RATING_RE = /\b(AAA|AA[+-]?|A1\+?|A2\+?|A3\+?|A4\+?|A[+-]?|BBB[+-]?|BB[+-]?|B[+-]?|CCC[+-]?|CC|C|D)\b/;
function parseRating(s) {
  const raw = String(s || "").trim();
  if (!raw) return null;
  const m = raw.toUpperCase().match(RATING_RE);
  if (m) return m[1];
  return raw.slice(0, 24) || null;
}

/* --------------------------------------------------------------------------
 * TSV parsing — records are anchored on the ISIN in column 1, so continuation
 * lines (embedded newlines inside later address/agent fields) are ignored.
 * `want` maps our field names to header-cell matchers.
 * ------------------------------------------------------------------------ */
function headerIndex(cols, matchers) {
  const idx = {};
  for (const [key, test] of Object.entries(matchers)) {
    idx[key] = cols.findIndex((c) => test.test(String(c || "").trim()));
  }
  return idx;
}

function parseTsvRecords(text, matchers) {
  const lines = text.split(/\r\n|\r|\n/);
  if (!lines.length) return [];
  const header = lines[0].split("\t");
  const idx = headerIndex(header, matchers);
  const isinCol = idx.isin;
  if (isinCol == null || isinCol < 0) throw new Error("nsdl: ISIN column not found in TSV header");
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    const isin = (cells[isinCol] || "").trim().toUpperCase();
    if (!ISIN_RE.test(isin)) continue; // continuation line or junk
    out.push({ cells, get: (k) => (idx[k] >= 0 ? cells[idx[k]] : undefined) });
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Minimal zero-dependency .xlsx reader (CD list only — a small workbook).
 * An .xlsx is a ZIP of XML. We read the central directory, inflate the two
 * parts we need (sharedStrings + sheet1), and pull rows out with regex.
 * ------------------------------------------------------------------------ */
function unzipEntries(buf) {
  // Locate End Of Central Directory (signature 0x06054b50), scanning back from EOF.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("xlsx: no EOCD");
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  const entries = {};
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries[name] = { method, compSize, localOff };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

function readEntry(zip, name) {
  const e = zip.entries[name];
  if (!e) return null;
  const { buf } = zip;
  // Local file header: name/extra lengths live at +26/+28; data follows.
  const lnNameLen = buf.readUInt16LE(e.localOff + 26);
  const lnExtraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + lnNameLen + lnExtraLen;
  const comp = buf.subarray(start, start + e.compSize);
  return e.method === 0 ? comp : inflateRawSync(comp);
}

function xmlUnescape(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, "&");
}

/** Parse the CD .xlsx into rows-of-cells (array of arrays of strings). */
function parseXlsx(buf) {
  const zip = unzipEntries(buf);
  const ssXml = readEntry(zip, "xl/sharedStrings.xml");
  const shared = [];
  if (ssXml) {
    const txt = ssXml.toString("utf8");
    for (const m of txt.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlUnescape(t[1]));
      shared.push(parts.join(""));
    }
  }
  const sheetXml = readEntry(zip, "xl/worksheets/sheet1.xml");
  if (!sheetXml) throw new Error("xlsx: no sheet1");
  const stxt = sheetXml.toString("utf8");
  const rows = [];
  for (const rm of stxt.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1];
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      const col = ref ? colToNum(ref) : cells.length; // A->0
      const t = (attrs.match(/t="([^"]+)"/) || [])[1];
      const vm = cm[2].match(/<v>([\s\S]*?)<\/v>/);
      const isXml = cm[2].match(/<t[^>]*>([\s\S]*?)<\/t>/); // inline string
      let val = "";
      if (t === "s" && vm) val = shared[+vm[1]] ?? "";
      else if (isXml) val = xmlUnescape(isXml[1]);
      else if (vm) val = xmlUnescape(vm[1]);
      cells[col] = val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = "";
    rows.push(cells);
  }
  return rows;
}
function colToNum(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* --------------------------------------------------------------------------
 * Fetch helpers
 * ------------------------------------------------------------------------ */
async function fetchText(url) {
  const res = await fetch(url, { headers: pageHeaders(), signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`NSDL ${res.status} ${url.slice(0, 80)}`);
  return res.text();
}
async function fetchBuffer(url) {
  const res = await fetch(url, { headers: fileHeaders(), signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`NSDL ${res.status} ${url.slice(0, 80)}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Download a big file resiliently via HTTP range requests — many small chunks,
 * each with its own timeout and retries — so one slow or stalled transfer can't
 * abort the whole thing (NSDL's ~28 MB debt list is too slow for a single
 * request on a CI runner). Falls back to one plain request if the server won't
 * range. Throws on failure (caller decides). Returns a Buffer.
 */
export async function fetchLargeBuffer(url, { chunk = 4 * 1024 * 1024 } = {}) {
  let total = null, ranges = false;
  try {
    const probe = await fetch(url, { headers: { ...fileHeaders(), Range: "bytes=0-0" }, signal: AbortSignal.timeout(20000) });
    await probe.arrayBuffer(); // drain the 1-byte body so the socket frees
    const cr = probe.headers.get("content-range"); // "bytes 0-0/27978390"
    ranges = probe.status === 206 && !!cr;
    if (cr) total = parseInt(cr.split("/").pop(), 10);
  } catch { /* fall through to a single request */ }
  if (!ranges || !Number.isFinite(total) || total <= 0) return fetchBuffer(url);

  const parts = [];
  for (let start = 0; start < total; start += chunk) {
    const end = Math.min(start + chunk - 1, total - 1);
    let piece = null;
    for (let a = 0; a < 3; a++) {
      try {
        const res = await fetch(url, { headers: { ...fileHeaders(), Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(60000) });
        if (res.status !== 206 && res.status !== 200) throw new Error(`status ${res.status}`);
        piece = Buffer.from(await res.arrayBuffer());
        break;
      } catch (err) {
        if (a === 2) throw new Error(`range ${start}-${end}: ${String(err.message || err).slice(0, 80)}`);
        await sleep(1000 * (a + 1));
      }
    }
    parts.push(piece);
  }
  const buf = Buffer.concat(parts);
  if (buf.length < total * 0.98) throw new Error(`short read ${buf.length}/${total}`);
  return buf;
}
async function withRetry(fn, label) {
  for (let a = 0; a < 4; a++) {
    try { return await fn(); }
    catch (err) {
      if (a === 3) { console.warn(`[nsdl] ${label} failed: ${String(err.message || err).slice(0, 160)}`); return null; }
      await sleep(1500 * 2 ** a);
    }
  }
}

/** Scrape the page for the current dated master-list URLs (the "entire list",
 *  not the "redeemed-only" deltas). Returns { debt, cp, cd } absolute URLs. */
function findSourceUrls(html) {
  const paths = [...html.matchAll(/\/nsdl\/\d{4}-\d{2}\/[^"'<>\\ ]+?\.xlsx?/g)].map((m) => m[0]);
  const uniq = [...new Set(paths)];
  // NSDL names the master lists with underscores ("Debt_Instruments") but the CD
  // one with spaces ("Cd (Including Redeemed)"); normalise both to spaces so a
  // single word-spaced pattern classifies every file.
  const nameOf = (p) => decodeURIComponent(p.split("/").pop()).replace(/[_]+/g, " ").toLowerCase();
  const pick = (test) => {
    const hit = uniq.find((p) => test.test(nameOf(p)));
    return hit ? ORIGIN + hit : null;
  };
  return {
    debt: pick(/debt instruments.*including/),
    cp: pick(/commercial papers.*including/),
    cd: pick(/^cd\b.*including/),
  };
}

/* --------------------------------------------------------------------------
 * Row -> security
 * ------------------------------------------------------------------------ */
function liveOnly(sec, today) {
  return sec && sec.maturity && sec.maturity >= today;
}

const clip = (s, n = 110) => { s = String(s || "").trim(); return s.length > n ? s.slice(0, n) : s; };

export function buildDebt(text, today) {
  const recs = parseTsvRecords(text, {
    isin: /^isin$/i, company: /^company$/i, name: /name.*instrument/i,
    redemption: /^redemption$/i, coupon: /coupon/i, rating: /credit.?rating/i,
  });
  const out = [];
  for (const r of recs) {
    const coupon = parseCoupon(r.get("coupon"));
    if (coupon == null) continue; // a bond matches on coupon+maturity — no coupon, never matchable
    const maturity = parseWordDate(r.get("redemption"));
    const sec = {
      isin: (r.get("isin") || "").trim().toUpperCase(),
      issuer: (r.get("company") || "").trim(),
      name: clip(r.get("name")),
      coupon,
      maturity,
      rating: parseRating(r.get("rating")),
      type: "bond",
    };
    sec.issuer_norm = normIssuer(sec.issuer);
    if (liveOnly(sec, today)) out.push(sec);
  }
  return out;
}

export function buildCp(text, today) {
  const recs = parseTsvRecords(text, {
    isin: /^isin$/i, company: /company/i, name: /description/i,
    maturity: /maturity/i, rating: /^credit rating$/i,
  });
  const out = [];
  for (const r of recs) {
    const maturity = parseDmyDate(r.get("maturity"));
    const sec = {
      isin: (r.get("isin") || "").trim().toUpperCase(),
      issuer: (r.get("company") || "").trim(),
      name: clip(r.get("name")),
      coupon: null,
      maturity,
      rating: parseRating(r.get("rating")),
      type: "cp",
    };
    sec.issuer_norm = normIssuer(sec.issuer);
    if (liveOnly(sec, today)) out.push(sec);
  }
  return out;
}

export function buildCd(buf, today) {
  const rows = parseXlsx(buf);
  if (!rows.length) return [];
  const header = rows[0].map((c) => String(c || "").trim());
  const find = (re) => header.findIndex((h) => re.test(h));
  const iIsin = find(/isin/i), iCompany = find(/company/i), iDesc = find(/description/i),
    iFeat = find(/feature/i), iRating = find(/rating/i), iRedeem = find(/redemption|redeem/i);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const c = rows[i];
    const isin = String(c[iIsin] || "").trim().toUpperCase();
    if (!ISIN_RE.test(isin)) continue;
    const feat = String(c[iFeat] || "");
    let maturity = null;
    const fm = feat.match(/maturity date\s*:?\s*(\d{1,2}-\d{1,2}-\d{4})/i);
    if (fm) maturity = parseDmyDate(fm[1]);
    if (!maturity && iRedeem >= 0) maturity = parseDmyDate(c[iRedeem]) || parseWordDate(c[iRedeem]);
    const sec = {
      isin,
      issuer: String(c[iCompany] || "").trim(),
      name: clip(c[iDesc]),
      coupon: null,
      maturity,
      rating: parseRating(c[iRating]),
      type: "cd",
    };
    sec.issuer_norm = normIssuer(sec.issuer);
    if (liveOnly(sec, today)) out.push(sec);
  }
  return out;
}

/** Cheaply fetch just the current dated master-list URLs (one small page load,
 *  light retry). Lets the parser tell "nothing changed, reuse the cache" from
 *  "new lists posted, rebuild" WITHOUT pulling the ~30 MB of data files. */
export async function fetchNsdlSources() {
  for (let a = 0; a < 2; a++) {
    try {
      const res = await fetch(PAGE_URL, { headers: pageHeaders(), signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`NSDL ${res.status}`);
      return findSourceUrls(await res.text());
    } catch (err) {
      if (a === 1) { console.warn(`[nsdl] source check failed: ${String(err.message || err).slice(0, 120)}`); return null; }
      await sleep(1500);
    }
  }
  return null;
}

/**
 * Fetch and normalise the whole NSDL security master. Returns null (not throw)
 * on failure so the parser keeps the last good directory. `today` is the ISO day
 * used to drop matured securities (defaults to now, IST-agnostic — dates only).
 */
export async function fetchNsdlDirectory(today = new Date().toISOString().slice(0, 10)) {
  const html = await withRetry(() => fetchText(PAGE_URL), "page");
  if (!html) return null;
  const sources = findSourceUrls(html);
  if (!sources.debt) { console.warn("[nsdl] could not find the Debt Instruments master URL on the page"); return null; }

  const securities = [];
  const counts = {};

  let debtText = null;
  try { debtText = (await fetchLargeBuffer(sources.debt)).toString("utf8"); }
  catch (err) { console.warn(`[nsdl] debt download failed: ${String(err.message || err).slice(0, 160)}`); return null; }
  if (!debtText) return null; // bonds are the core — no bonds, treat as unavailable
  try { const s = buildDebt(debtText, today); counts.bond = s.length; securities.push(...s); }
  catch (err) { console.warn(`[nsdl] debt parse failed: ${err.message}`); return null; }

  if (sources.cp) {
    let cpText = null;
    try { cpText = (await fetchLargeBuffer(sources.cp)).toString("utf8"); } catch (err) { console.warn(`[nsdl] cp download skipped: ${String(err.message || err).slice(0, 120)}`); }
    if (cpText) try { const s = buildCp(cpText, today); counts.cp = s.length; securities.push(...s); } catch (err) { console.warn(`[nsdl] cp parse skipped: ${err.message}`); }
  }
  if (sources.cd) {
    const cdBuf = await withRetry(() => fetchBuffer(sources.cd), "cd");
    if (cdBuf) try { const s = buildCd(cdBuf, today); counts.cd = s.length; securities.push(...s); } catch (err) { console.warn(`[nsdl] cd parse skipped: ${err.message}`); }
  }

  // Deterministic order keeps the committed cache's diffs minimal between refreshes.
  securities.sort((a, b) => (a.isin < b.isin ? -1 : a.isin > b.isin ? 1 : 0));
  const as_of = today;
  console.log(`[nsdl] directory: ${securities.length} live securities (${counts.bond || 0} bond, ${counts.cp || 0} cp, ${counts.cd || 0} cd)`);
  return { as_of, sources, counts, securities };
}

/* --------------------------------------------------------------------------
 * Matching
 * ------------------------------------------------------------------------ */
const couponKey = (c) => (typeof c === "number" && Number.isFinite(c) ? c.toFixed(2) : null);
const yearOf = (iso) => (typeof iso === "string" && iso.length >= 4 ? iso.slice(0, 4) : null);

/** Build fast lookup indexes over a securities array. */
export function buildNsdlIndex(securities) {
  const byCM = new Map(); // bond:  "coupon|maturityISO" -> [sec]
  const byCY = new Map(); // bond:  "coupon|year"        -> [sec]  (placeholder-maturity fallback)
  const byMat = new Map(); // cp/cd: "maturityISO"       -> [sec]  (issuer resolved by issuerAgrees)
  const byIsin = new Map();
  const push = (map, key, sec) => { if (!map.has(key)) map.set(key, []); map.get(key).push(sec); };
  for (const s of securities || []) {
    if (s.isin) byIsin.set(s.isin, s);
    if (s.type === "bond") {
      const ck = couponKey(s.coupon);
      if (ck && s.maturity) { push(byCM, `${ck}|${s.maturity}`, s); push(byCY, `${ck}|${yearOf(s.maturity)}`, s); }
    } else if (s.maturity) {
      push(byMat, s.maturity, s);
    }
  }
  return { byCM, byCY, byMat, byIsin, size: (securities || []).length };
}

/** Do the desk issuer and an NSDL issuer plausibly refer to the same entity?
 *  Compares expanded/aliased token-sets (so "SIDBI" reaches "SMALL INDUSTRIES
 *  DEVELOPMENT BANK OF INDIA" and "BAJAJ HSG FIN" reaches "BAJAJ HOUSING
 *  FINANCE"): a match needs every desk token present on the NSDL side (subset),
 *  or a strong 2+ token overlap. Never forces a match on its own — coupon and
 *  maturity still gate. */
export function issuerAgrees(deskAny, secAny) {
  const dsets = issuerTokenSets(deskAny);
  const ssets = issuerTokenSets(secAny);
  for (const d of dsets) {
    if (!d.size) continue;
    for (const s of ssets) {
      let ov = 0;
      for (const t of d) if (s.has(t)) ov++;
      if (ov === d.size) return true; // all desk tokens present -> same entity
      if (d.size >= 2 && ov >= 2 && ov >= d.size - 1) return true; // near-complete overlap
    }
  }
  return false;
}

/** The issuer-agreeing NSDL candidates for a desk quote — the pool both the
 *  confirmed-ISIN and confident-rating decisions are made from. */
export function candidatePool(index, q) {
  if (!index || !q) return [];
  if (q.section === "Bonds") {
    const ck = couponKey(q.coupon);
    if (!ck || !q.maturity) return [];
    // Exact coupon+maturity first; fall back to coupon+year for bare-year quotes.
    let pool = index.byCM.get(`${ck}|${q.maturity}`);
    if (!pool || !pool.length) pool = index.byCY.get(`${ck}|${yearOf(q.maturity)}`) || [];
    return pool.filter((s) => issuerAgrees(q.issuer, s.issuer_norm));
  }
  if (q.section === "DCM") {
    if (!q.maturity) return [];
    let cands = (index.byMat.get(q.maturity) || []).filter((s) => issuerAgrees(q.issuer, s.issuer_norm));
    const want = /cd/i.test(q.instrument_type || "") ? "cd" : /cp/i.test(q.instrument_type || "") ? "cp" : null;
    if (want && cands.some((s) => s.type === want)) cands = cands.filter((s) => s.type === want);
    return cands;
  }
  return [];
}

/** The single agreed rating across candidates (ignoring blanks), or null when
 *  they disagree or none is rated. Same-issuer senior paper is rated alike, so
 *  this is a trustworthy rating even when the exact ISIN stays ambiguous. */
function agreedRating(cands) {
  const rs = [...new Set(cands.map((s) => s.rating).filter(Boolean))];
  return rs.length === 1 ? rs[0] : null;
}

/**
 * Resolve a desk quote against the NSDL master. Returns null when nothing
 * plausible matches, else:
 *   { isin, name, issuer, coupon, maturity, type, rating, count }  when the ISIN
 *       is UNIQUELY determined (confirmed — safe to show as the exact security);
 *   { rating, count, issuer }                                       when several
 *       same-issuer series match (ambiguous ISIN) but they agree on a rating.
 * `count` is how many NSDL securities the quote could be. Conservative: it never
 * invents an ISIN it isn't sure of.
 */
export function resolveSecurity(index, q) {
  const cands = candidatePool(index, q);
  if (!cands.length) return null;
  if (cands.length === 1) {
    const s = cands[0];
    return { isin: s.isin, name: s.name, issuer: s.issuer, coupon: s.coupon, maturity: s.maturity, type: s.type, rating: s.rating || null, count: 1 };
  }
  const rating = agreedRating(cands);
  if (!rating) return null; // several series AND no agreed rating -> nothing safe to say
  // pick the most common canonical issuer for display
  const tally = new Map();
  for (const s of cands) tally.set(s.issuer, (tally.get(s.issuer) || 0) + 1);
  const issuer = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { rating, count: cands.length, issuer };
}

/** Back-compat: the uniquely-matched security, or null. */
export function matchQuote(index, q) {
  const cands = candidatePool(index, q);
  return cands.length === 1 ? cands[0] : null;
}
