/**
 * ratings.mjs — credit-rating comparison + "updated ratings" override.
 *
 * NSDL's downloadable master freezes a bond's rating at ISSUE. If an agency later
 * up/downgrades, NSDL won't show it. The desk's rule (from the review call):
 *   • use the LATEST rating;
 *   • when two agencies disagree, use the LOWER (conservative) one, and note it;
 *   • keep the change date.
 *
 * This module is the pure logic for that. It activates when someone drops updated
 * ratings into data/ratings-override.json (keyed by ISIN) — e.g. exported from
 * CRISIL / CARE / ICRA. Until then it's inert and NSDL ratings are used as-is.
 *
 *   applyRatingOverrides(securities, override) -> mutates each security's rating
 *   to the combined (lower-of) value and adds ratingDate / ratingNote when the
 *   override carries them.
 */

/** Better rating -> higher rank. Two scales: long-term (AAA..D) and money-market
 *  (A1+..A4/D). Comparisons only make sense within a scale (an instrument's two
 *  agency ratings are always the same scale). */
const LT = ["D", "C", "CC", "CCC-", "CCC", "CCC+", "B-", "B", "B+", "BB-", "BB", "BB+", "BBB-", "BBB", "BBB+", "A-", "A", "A+", "AA-", "AA", "AA+", "AAA"];
const MM = ["D", "A4", "A4+", "A3", "A3+", "A2", "A2+", "A1", "A1+"];
const RANK = new Map();
LT.forEach((r, i) => RANK.set(r, { scale: "LT", rank: i }));
MM.forEach((r, i) => RANK.set(r, { scale: "MM", rank: i }));

/** Normalize a rating symbol: strip agency prefix / "SO"/"CE" suffixes / spaces,
 *  keep the notch (+/−). Returns "" when nothing rating-like is present. */
export function normalizeRating(s) {
  if (!s) return "";
  let u = String(s).toUpperCase().replace(/[−–—]/g, "-");
  u = u.replace(/\([^)]*\)/g, " ");                                   // drop (Stable) / (CWD) etc.
  u = u.replace(/\b(CRISIL|ICRA|CARE(?:EDGE)?|INDIA\s*RATINGS?|IND\s*RA|FITCH|BRICKWORK|BWR|SMERA|ACUIT[EÉ]|INFOMERICS)\b/g, " "); // agency names
  u = u.replace(/\bRATINGS?\b/g, " ").replace(/[\[\]]/g, " ").replace(/\bSO\b|\bCE\b/g, " "); // suffixes / brackets
  u = u.replace(/\s+/g, " ").trim();
  const m = /\b(AAA|AA|A1|A2|A3|A4|A|BBB|BB|B|CCC|CC|C|D)\s?([+-])?(?![A-Z0-9])/.exec(u);
  if (!m) return "";
  return m[1] + (m[2] || "");
}
export const ratingRank = (r) => RANK.get(normalizeRating(r)) || null;
/** Which scale a rating symbol is on: "LT" (long-term AAA..D) or "MM"
 *  (money-market/short-term A1+..D), or null if unknown. */
export const ratingScale = (r) => (ratingRank(r)?.scale) || null;
/** The rating scale an INSTRUMENT must use: money-market (short-term) for CP/CD,
 *  long-term for bonds/NCDs. Derived from the ISIN instrument-type code (14=CP,
 *  16=CD) and the type string (so a bank CD with a lettered ISIN code still
 *  resolves via its "cd" type). Everything else is treated as long-term. */
export function instrumentScale(isin, type) {
  const code = String(isin || "").slice(7, 9);
  const t = String(type || "").toLowerCase();
  if (code === "14" || code === "16" || /\bcp\b|\bcd\b|commercial paper|certificate/.test(t)) return "MM";
  return "LT";
}

/** The lower (more conservative) of two ratings on the same scale; if scales
 *  differ or one is unknown, prefer the known one, else "". */
export function lowerRating(a, b) {
  const ra = ratingRank(a), rb = ratingRank(b);
  if (!ra && !rb) return "";
  if (!ra) return normalizeRating(b);
  if (!rb) return normalizeRating(a);
  if (ra.scale !== rb.scale) return ra.scale === "LT" ? normalizeRating(a) : normalizeRating(b); // prefer long-term
  return ra.rank <= rb.rank ? normalizeRating(a) : normalizeRating(b);
}

/**
 * Combine one instrument's agency ratings into the value to display.
 * `agencies` is { CRISIL:"AA+", ICRA:"AA", ... } (or an array of symbols).
 * Returns { rating, dual, agencies:[names], note } or null when none valid.
 */
export function combineRatings(agencies, date, scale) {
  let pairs = [];
  if (Array.isArray(agencies)) pairs = agencies.map((r, i) => [`R${i + 1}`, r]);
  else if (agencies && typeof agencies === "object") pairs = Object.entries(agencies);
  let valid = pairs.map(([ag, r]) => [ag, normalizeRating(r)]).filter(([, r]) => r);
  // Respect the instrument's rating scale: a bond uses the long-term scale
  // (AAA..D), a CP/CD the short-term/money-market scale (A1+..D). NEVER fold a
  // short-term rating into a bond's rating or a long-term one into a CD's. When a
  // scale is given, keep only same-scale agency ratings; if none are on that scale,
  // return null so the caller keeps the (scale-correct) initial rating rather than
  // stamping a wrong-scale one.
  if (scale === "LT" || scale === "MM") valid = valid.filter(([, r]) => ratingScale(r) === scale);
  if (!valid.length) return null;
  let low = valid[0][1];
  for (const [, r] of valid.slice(1)) low = lowerRating(low, r);
  const distinct = [...new Set(valid.map(([, r]) => r))];
  const dual = distinct.length > 1;
  const names = valid.map(([ag]) => ag);
  const note = dual
    ? `Lower of ${valid.map(([ag, r]) => `${ag} ${r}`).join(", ")} (conservative)`
    : (names.length && names[0] !== "R1" ? `${names[0]} ${low}` : "");
  return { rating: low, dual, agencies: names, note: note + (date ? ` · ${date}` : ""), date: date || null };
}

/** Apply an override map (by ISIN) onto a securities array in place. Each entry:
 *  { agencies:{...} | ratings:[...], date? }. Safe no-op for missing ISINs. */
export function applyRatingOverrides(securities, override) {
  const byIsin = (override && (override.byIsin || override)) || {};
  let n = 0;
  for (const s of securities) {
    const o = s && s.isin ? byIsin[s.isin] : null;
    if (!o) continue;
    const combined = combineRatings(o.agencies || o.ratings || o.rating, o.date, instrumentScale(s.isin, s.type));
    if (!combined) continue;
    s.rating = combined.rating;
    s.ratingDate = combined.date;
    s.ratingNote = combined.note;
    // Carry the auditable source(s) — agency, date, and a link to the exact
    // exchange filing — so the board can show where an updated rating came from.
    if (Array.isArray(o.sources) && o.sources.length) s.ratingSources = o.sources.slice(0, 4);
    n++;
  }
  return n;
}
