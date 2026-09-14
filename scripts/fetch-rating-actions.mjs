/**
 * fetch-rating-actions.mjs — auto-feeder for updated credit ratings.
 *
 * NSDL freezes a bond's rating at issue. Agencies publish up/downgrades continuously
 * as stock-exchange filings ("Revision in Credit Rating"). This reads the recent
 * BSE credit-rating announcements, keeps the ones for issuers the desk actually
 * quotes, pulls the new rating from the filing headline, and writes them into
 * data/ratings-override.json — which the parser already consumes (latest / lower of
 * two agencies + date + note). Net effect: ratings stay current automatically; the
 * desk never re-sends a list.
 *
 * Best-effort + self-contained: any network/parse failure leaves the existing
 * override untouched and never blocks the refresh.
 *
 * NOTE: BSE/NSE gate their endpoints behind browser-style headers (like NSDL). The
 * fetch is validated on the live pipeline; from a blocked sandbox it returns nothing
 * and the step is a clean no-op. Instrument-level edge cases (a company whose perp
 * and senior bonds carry different ratings) still want a quick human eyeball — the
 * "data proofing" the desk flagged — so this writes a review-visible file, never a
 * silent black box.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeRating, combineRatings } from "./ratings.mjs";

const QUOTES_PATH = fileURLToPath(new URL("../public/data/quotes.json", import.meta.url));
const OVERRIDE_PATH = fileURLToPath(new URL("../data/ratings-override.json", import.meta.url));
const LOOKBACK_DAYS = 30;

// BSE corporate-announcements JSON API (same one the open-source BseIndiaApi uses).
const BSE_ANN = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://www.bseindia.com/",
  "Origin": "https://www.bseindia.com",
};
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const RATING_RE = /\b(credit rating|rating (?:revision|action|upgrade|downgrade|reaffirm|assign|withdraw))/i;

/** Fetch recent BSE announcements and keep the credit-rating ones. Returns
 *  [{ company, headline, date }]. Empty on any failure (blocked sandbox etc.). */
export async function fetchBseRatingActions(fetchImpl = fetch) {
  const to = new Date(), from = new Date(Date.now() - LOOKBACK_DAYS * 864e5);
  const url = `${BSE_ANN}?pageno=1&strCat=-1&strPrevDate=${ymd(from)}&strToDate=${ymd(to)}&strScrip=&strSearch=P&strType=C&subcategory=`;
  try {
    const r = await fetchImpl(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(60000) });
    if (!r.ok) { console.warn(`[ratings] BSE announcements HTTP ${r.status}`); return []; }
    const j = await r.json();
    const rows = j.Table || j.table || [];
    return rows.map((x) => ({
      company: String(x.SLONGNAME || x.NEWSSUB || "").trim(),
      headline: `${x.NEWSSUB || ""} ${x.HEADLINE || ""}`.replace(/\s+/g, " ").trim(),
      date: String(x.NEWS_DT || x.News_submission_dt || "").slice(0, 10),
    })).filter((a) => a.company && RATING_RE.test(a.headline));
  } catch (err) { console.warn(`[ratings] BSE fetch failed: ${err.message}`); return []; }
}

const SUF = /\b(?:LIMITED|LTD|PVT|PRIVATE|COMPANY|CO|CORPORATION|CORP|THE|AND)\b/g;
const normName = (s) => String(s || "").toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9 ]/g, " ").replace(SUF, " ").replace(/\s+/g, " ").trim();

/** Strict issuer match: the two official names must reduce to the SAME set of
 *  significant tokens. Both sides are official (the filing's company name and the
 *  NSDL security's issuer), so "BAJAJ FINANCE" == "BAJAJ FINANCE" but never
 *  "BAJAJ HOUSING FINANCE" — a sibling instrument never inherits the wrong rating.
 *  Missing a match is safe (bond keeps its NSDL rating); a wrong match is not. */
function issuerMatches(a, b) {
  const toks = (s) => [...new Set(normName(s).split(" ").filter((t) => t.length > 2))].sort();
  const ta = toks(a), tb = toks(b);
  if (ta.length < 2 || ta.length !== tb.length) return false;
  return ta.every((t, i) => t === tb[i]);
}

/** Build the byIsin override from rating actions + the desk's own securities table.
 *  Only the desk's ISINs are ever touched; each entry records the source + date so
 *  it's reviewable. Returns { byIsin, applied }. */
export function buildOverride(actions, securities, prevByIsin = {}) {
  const byIsin = { ...prevByIsin };
  let applied = 0;
  for (const [isin, sec] of Object.entries(securities || {})) {
    const iss = sec.issuer || sec.name || "";
    if (!iss) continue;
    const hit = actions.find((a) => issuerMatches(a.company, iss));
    if (!hit) continue;
    const rating = normalizeRating(hit.headline);
    if (!rating) continue;
    byIsin[isin] = { ratings: [rating], date: hit.date || null, source: `BSE filing · ${hit.company}` };
    applied++;
  }
  return { byIsin, applied };
}

async function main() {
  if (!existsSync(QUOTES_PATH)) { console.warn("[ratings] no quotes.json, skip"); return; }
  const data = JSON.parse(readFileSync(QUOTES_PATH, "utf8"));
  const securities = data.securities || {};
  if (!Object.keys(securities).length) { console.warn("[ratings] no securities to match, skip"); return; }

  const actions = await fetchBseRatingActions();
  if (!actions.length) { console.log("[ratings] no rating actions fetched (or sandbox blocked) — override unchanged"); return; }

  let prev = {};
  try { if (existsSync(OVERRIDE_PATH)) { const j = JSON.parse(readFileSync(OVERRIDE_PATH, "utf8")); prev = j.byIsin || {}; } } catch { prev = {}; }
  const { byIsin, applied } = buildOverride(actions, securities, prev);

  // Sanity-check every entry against the combine logic before writing.
  for (const [isin, o] of Object.entries(byIsin)) if (!combineRatings(o.ratings || o.agencies || o.rating, o.date)) delete byIsin[isin];

  const out = {
    _note: "Updated ratings applied by the pipeline: BSE 'Revision in Credit Rating' filings matched to desk ISINs. Latest / lower-of-two + date. Review-visible; edit or clear entries as needed.",
    byIsin,
  };
  writeFileSync(OVERRIDE_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(`[ratings] rating actions: ${actions.length} fetched, ${applied} matched to desk ISINs`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
