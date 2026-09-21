/**
 * fetch-rating-actions.mjs — automatic "updated ratings" feeder.
 *
 * THE PROBLEM. NSDL's downloadable master (and SEBI's Bond Central) both freeze a
 * bond's rating at issue / at the depository snapshot — a later up/downgrade never
 * shows. The desk asked for ratings that stay current on their own, across every
 * agency, without anyone re-sending a list.
 *
 * THE SOURCE. SEBI (LODR Reg 30) makes the ISSUER disclose any rating revision to
 * the stock exchange within 24 hours, whichever agency rated it. So the exchange
 * "Credit Rating" announcements feed is a single, near-real-time stream covering
 * ALL agencies (CRISIL / ICRA / CARE / India Ratings / Acuité / Infomerics /
 * Brickwork / …). NSE hard-blocks data-centre IPs; BSE does not, so we read BSE:
 *   api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w
 *   ?strCat=Company Update&subcategory=Credit Rating&strType=C|D&strSearch=P …
 * (window must be ≤ ~1 month; paginates 50/row.)
 *
 * THE EXTRACTION. The announcement headline rarely holds the rating itself — it is
 * in the attached agency report PDF (…/corpfiling/AttachLive/<ATTACHMENTNAME>).
 * These PDFs are messy and vary by agency, and the "Credit Rating" bucket also
 * carries ESG ratings and international-scale actions (Moody's Ba2 etc.) that must
 * NOT be treated as the domestic credit rating. That judgement is exactly what the
 * pipeline's LLM is for, so we read the PDF text (scripts/pdf_text.py) and ask the
 * LLM for the domestic long-/short-term rating per instrument. Deterministic regex
 * was tried first and is too fragile across agencies (ESG, Moody's, per-instrument
 * splits) — it produced wrong ratings, which on a dealing board is worse than none.
 *
 * THE OUTPUT. data/ratings-override.json, keyed by ISIN, per agency + date + a link
 * back to the exact exchange filing (so every change is auditable, never a black
 * box). scripts/ratings.mjs then applies the desk's rule: latest, lower-of-two when
 * agencies differ, with a note and the date. Only the desk's own held ISINs are
 * ever touched.
 *
 * Self-contained + best-effort: any network/parse/LLM failure leaves the existing
 * override untouched and never blocks the refresh. Already-seen filings are cached
 * so each run only spends LLM calls on genuinely new announcements.
 *
 * Env:
 *   RATINGS_DRY_RUN=1  → print what would be written, don't touch the file
 *   RATINGS_LOOKBACK_DAYS=30
 *   RATINGS_MAX_PDFS=40  (safety cap on new PDFs parsed per run)
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRating, combineRatings } from "./ratings.mjs";
import { llmStructured } from "./llm.mjs";

const QUOTES_PATH = fileURLToPath(new URL("../public/data/quotes.json", import.meta.url));
const OVERRIDE_PATH = fileURLToPath(new URL("../data/ratings-override.json", import.meta.url));
const PDF_TEXT_PY = fileURLToPath(new URL("./pdf_text.py", import.meta.url));

const DRY = process.env.RATINGS_DRY_RUN === "1";
const LOOKBACK = parseInt(process.env.RATINGS_LOOKBACK_DAYS || "30", 10);
const MAX_PDFS = parseInt(process.env.RATINGS_MAX_PDFS || "40", 10);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36";
const BSE_HDRS = [
  "-H", `User-Agent: ${UA}`,
  "-H", "Accept: application/json, text/plain, */*",
  "-H", "Accept-Language: en-US,en;q=0.5",
  "-H", "Referer: https://www.bseindia.com/",
  "-H", "Origin: https://www.bseindia.com/",
];
const ATTACH_BASE = "https://www.bseindia.com/xml-data/corpfiling/AttachLive/";
const BSE_ANN = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

/* ---- small shell helpers (curl is proven to reach BSE from the runner) ---- */
function curlText(url, extraHdrs = []) {
  return execFileSync("curl", ["-sS", "-m", "60", ...BSE_HDRS, ...extraHdrs, url], { maxBuffer: 1e8 }).toString();
}
function curlDownload(url, outPath) {
  try {
    execFileSync("curl", ["-sS", "-m", "90", ...BSE_HDRS, "-o", outPath, url], { maxBuffer: 1e8 });
    return existsSync(outPath);
  } catch { return false; }
}
function pdfToText(pdfPath, maxChars = 12000) {
  try { return execFileSync("python3", [PDF_TEXT_PY, pdfPath, String(maxChars)], { maxBuffer: 1e8 }).toString(); }
  catch { return ""; }
}

/* ---- BSE "Credit Rating" announcements, both equity (C) and debt (D) segments ---- */
function fetchBseCreditActions() {
  const to = new Date(), from = new Date(Date.now() - LOOKBACK * 864e5);
  const out = [];
  for (const seg of ["C", "D"]) {
    for (let page = 1; page <= 20; page++) {
      const q = new URLSearchParams({
        pageno: String(page), strCat: "Company Update", subcategory: "Credit Rating",
        strPrevDate: ymd(from), strToDate: ymd(to), strSearch: "P", strscrip: "", strType: seg,
      });
      let j;
      try { j = JSON.parse(curlText(`${BSE_ANN}?${q}`) || "{}"); } catch { break; }
      const rows = j.Table || [];
      if (!rows.length) break;
      for (const r of rows) out.push({
        newsid: r.NEWSID || r.XML_NAME || "",
        company: String(r.SLONGNAME || r.NEWSSUB || "").trim(),
        headline: `${r.NEWSSUB || ""} — ${r.HEADLINE || ""}`.replace(/\s+/g, " ").trim(),
        date: String(r.NEWS_DT || r.News_submission_dt || "").slice(0, 10),
        attachment: r.ATTACHMENTNAME || "",
        seg,
      });
      const total = (j.Table1 && j.Table1[0] && j.Table1[0].ROWCNT) || 0;
      if (out.length >= total) break;
    }
  }
  return out;
}

/* ---- desk issuer index: normalised official name -> { isins:[{isin,type}] } ---- */
const SUF = /\b(?:LIMITED|LTD|PVT|PRIVATE|COMPANY|CO|CORPORATION|CORP|THE|AND|OF|FOR)\b/g;
const normName = (s) => String(s || "").toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9 ]/g, " ").replace(SUF, " ").replace(/\s+/g, " ").trim();

function buildIssuerIndex(securities) {
  const idx = new Map();
  for (const [isin, s] of Object.entries(securities)) {
    const n = normName(s.issuer);
    if (!n) continue;
    if (!idx.has(n)) idx.set(n, { name: s.issuer, isins: [] });
    idx.get(n).isins.push({ isin, type: s.type || "bond" });
  }
  return idx;
}
/** Strict-ish match: all significant tokens of a desk issuer appear in the BSE
 *  name (min 2 tokens), so "BANK OF INDIA" never soaks up "BANK OF BARODA". */
function matchIssuer(bseName, idx) {
  const bt = new Set(normName(bseName).split(" "));
  for (const [n, info] of idx) {
    const ot = n.split(" ").filter((t) => t.length > 2);
    if (ot.length >= 2 && ot.every((t) => bt.has(t))) return info;
  }
  return null;
}

/* ---- LLM extraction: domestic credit rating(s) out of one report's text ---- */
const RATING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    is_credit_rating: { type: "boolean", description: "true only for a domestic credit-rating action; false for ESG ratings or purely international-scale (Moody's/S&P/Fitch global) actions" },
    agency: { type: "string", description: "domestic CRA short name: CRISIL, ICRA, CARE, India Ratings, Acuite, Infomerics, Brickwork, ACER, CredStone — or empty if none" },
    action: { type: "string", description: "Assigned/Affirmed/Reaffirmed/Upgraded/Downgraded/Revised/Withdrawn" },
    date: { type: "string", description: "date of the rating action, YYYY-MM-DD, or empty" },
    issuer_long_term: { type: "string", description: "issuer's senior long-term domestic rating symbol only, e.g. AAA, AA+, A; NO agency prefix, NO outlook. Empty if not stated. Ignore withdrawn ratings." },
    issuer_short_term: { type: "string", description: "short-term (money-market) rating symbol only, e.g. A1+. Empty if none." },
    instruments: {
      type: "array",
      description: "per-instrument current ratings that carry an ISIN (INE...); domestic scale only; skip withdrawn",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          isin: { type: "string" },
          rating: { type: "string", description: "symbol only, no prefix/outlook" },
          term: { type: "string", description: "long or short" },
        },
        required: ["isin", "rating", "term"],
      },
    },
  },
  required: ["is_credit_rating", "agency", "action", "date", "issuer_long_term", "issuer_short_term", "instruments"],
};

async function extractWithLlm(text, headline, heldIsins) {
  const system =
    "You read Indian credit-rating agency reports and return ONLY structured data. " +
    "Report ONLY domestic-scale ratings: long-term AAA, AA+, AA, AA-, A+, ... down to D; short-term A1+, A1, A2, ... A4, D. " +
    "IGNORE ESG ratings entirely. IGNORE international-scale ratings (Moody's like Aaa/Ba2/Baa3, S&P/Fitch global like BBB-/BB+) — set is_credit_rating false if the action is only ESG or only international. " +
    "Return rating SYMBOLS only: strip the agency prefix (CRISIL/ICRA/CARE/IND/[ICRA]/BWR) and any outlook/watch (Stable/Negative/Positive/RWN). " +
    "Do NOT report a rating that the report says is WITHDRAWN as a current rating. If different instruments carry different ratings, fill the per-instrument list and set issuer_long_term to the senior (most senior/plain NCD or issuer) long-term rating.";
  const user =
    `Announcement headline: ${headline}\n` +
    (heldIsins.length ? `We hold these ISINs from this issuer (report their ratings if present): ${heldIsins.join(", ")}\n` : "") +
    `\n--- rating report text ---\n${text}`;
  return await llmStructured({ system, user, schemaName: "credit_rating", schema: RATING_SCHEMA });
}

const KNOWN_AGENCIES = /CRISIL|ICRA|CARE|INDIA RATINGS|IND[\s-]?RA|ACUIT|INFOMERICS|BRICKWORK|BWR|ACER|CREDSTONE/i;
const agencyKey = (a) => {
  const u = String(a || "").toUpperCase();
  if (/CRISIL/.test(u)) return "CRISIL";
  if (/ICRA/.test(u)) return "ICRA";
  if (/CARE/.test(u)) return "CARE";
  if (/INDIA RATINGS|IND[\s-]?RA/.test(u)) return "India Ratings";
  if (/ACUIT/.test(u)) return "Acuite";
  if (/INFOMERICS/.test(u)) return "Infomerics";
  if (/BRICKWORK|BWR/.test(u)) return "Brickwork";
  if (/ACER/.test(u)) return "ACER";
  if (/CREDSTONE/.test(u)) return "CredStone";
  return String(a || "").trim();
};
const isMoneyMarket = (type) => /cp|cd|commercial paper|certificate/i.test(String(type || ""));

async function main() {
  if (!existsSync(QUOTES_PATH)) { console.warn("[ratings] no quotes.json, skip"); return; }
  const data = JSON.parse(readFileSync(QUOTES_PATH, "utf8"));
  const securities = data.securities || {};
  if (!Object.keys(securities).length) { console.warn("[ratings] no securities, skip"); return; }
  const idx = buildIssuerIndex(securities);

  // Load existing override (carry forward + processed-cache so we only LLM new filings).
  let prev = { _note: "", _seen: [], byIsin: {} };
  try { if (existsSync(OVERRIDE_PATH)) prev = { _seen: [], byIsin: {}, ...JSON.parse(readFileSync(OVERRIDE_PATH, "utf8")) }; } catch { /* start fresh */ }
  const seen = new Set(prev._seen || []);
  const byIsin = prev.byIsin || {};

  let actions;
  try { actions = fetchBseCreditActions(); } catch (e) { console.warn(`[ratings] BSE fetch failed: ${e.message}`); return; }
  console.log(`[ratings] BSE credit-rating announcements (${LOOKBACK}d): ${actions.length}`);
  if (!actions.length) { console.log("[ratings] nothing fetched — override unchanged"); return; }

  // Keep announcements for issuers we hold, newest first, not already processed.
  const matched = [];
  for (const a of actions) {
    const info = matchIssuer(a.company, idx);
    if (!info || !a.attachment) continue;
    matched.push({ ...a, info });
  }
  matched.sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  // Newest-first, at most one announcement per issuer per run (a single recent
  // report captures the issuer's current rating; a second agency's separate
  // filing is a different newsid and gets picked up on a later run).
  const fresh = [], perRun = new Set();
  for (const a of matched) {
    if (seen.has(a.newsid)) continue;
    const key = normName(a.company);
    if (perRun.has(key)) continue;
    perRun.add(key); fresh.push(a);
    if (fresh.length >= MAX_PDFS) break;
  }
  console.log(`[ratings] matched to desk issuers: ${matched.length}; new issuers to process this run: ${fresh.length}`);

  const tmp = mkdtempSync(join(tmpdir(), "ratings-"));
  let applied = 0, parsed = 0;
  const tmpPdf = join(tmp, "r.pdf");

  for (const a of fresh) {
    seen.add(a.newsid);
    if (!curlDownload(ATTACH_BASE + a.attachment, tmpPdf)) continue;
    const text = pdfToText(tmpPdf);
    if (!text || text.length < 40) continue;
    let ext;
    try { ext = await extractWithLlm(text, a.headline, a.info.isins.map((x) => x.isin)); }
    catch (e) { console.warn(`[ratings] LLM failed for ${a.company}: ${String(e.message).slice(0, 120)}`); continue; }
    parsed++;
    if (!ext || !ext.is_credit_rating) continue;
    const agency = agencyKey(ext.agency);
    if (!agency || !KNOWN_AGENCIES.test(agency)) continue;
    const when = (ext.date && /^\d{4}-\d{2}-\d{2}$/.test(ext.date)) ? ext.date : a.date;
    const source = { agency, date: when, action: ext.action || "", url: `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${a.attachment}` };

    // Resolve a rating for each held ISIN of this issuer.
    const perIsin = new Map((ext.instruments || []).filter((i) => i.isin && i.rating).map((i) => [i.isin.toUpperCase(), i]));
    const ltr = normalizeRating(ext.issuer_long_term);
    const str = normalizeRating(ext.issuer_short_term);

    for (const { isin, type } of a.info.isins) {
      let sym = "";
      const inst = perIsin.get(isin.toUpperCase());
      if (inst) sym = normalizeRating(inst.rating);
      else if (isMoneyMarket(type)) sym = str || ltr;
      else sym = ltr || str;
      if (!sym) continue;

      const e = byIsin[isin] || { agencies: {}, agencyDates: {}, sources: [] };
      e.agencies = e.agencies || {}; e.agencyDates = e.agencyDates || {}; e.sources = e.sources || [];
      // keep the newest per agency
      if (!e.agencyDates[agency] || (when || "") >= e.agencyDates[agency]) {
        e.agencies[agency] = sym; e.agencyDates[agency] = when || "";
      }
      e.date = Object.values(e.agencyDates).sort().slice(-1)[0] || when || "";
      if (!e.sources.some((s) => s.url === source.url)) e.sources.unshift(source);
      e.sources = e.sources.slice(0, 4);
      byIsin[isin] = e;
      applied++;
    }
  }

  // Drop entries whose combined rating no longer resolves (defensive).
  for (const [isin, o] of Object.entries(byIsin)) {
    if (!combineRatings(o.agencies || o.ratings || o.rating, o.date)) delete byIsin[isin];
  }

  const out = {
    _note: "AUTO-GENERATED updated ratings. Source: BSE 'Credit Rating' filings (SEBI LODR Reg 30), all agencies; rating read from the agency report PDF by the pipeline LLM. Applied as latest / lower-of-two + date. Each entry links the exact exchange filing. Edit/clear entries freely.",
    _updated_at: new Date().toISOString(),
    _seen: [...seen].slice(-4000),
    byIsin,
  };
  console.log(`[ratings] parsed ${parsed} report(s); wrote ratings for ${applied} held ISIN slot(s); total ISINs on file: ${Object.keys(byIsin).length}`);
  if (DRY) { console.log("[ratings] DRY RUN — not writing. Preview:\n" + JSON.stringify({ ...out, _seen: `<${seen.size} ids>` }, null, 2).slice(0, 4000)); return; }
  writeFileSync(OVERRIDE_PATH, JSON.stringify(out, null, 2) + "\n");
}

main().catch((e) => { console.warn(`[ratings] unexpected: ${e.message}`); });
