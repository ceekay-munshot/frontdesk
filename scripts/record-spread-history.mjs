/**
 * record-spread-history.mjs — the "normal range" recorder.
 *
 * Spread Watch shows how far a bond trades over the government curve (in bps).
 * A single number ("+467") means nothing on its own — the desk asked to see it
 * against its own history ("normally 400–450, now 467 → getting cheap"). So each
 * day we append that day's MEDIAN spread for every category × rating × tenor
 * bucket to public/data/spread-history.json. Over time this builds the 1-year
 * rolling range the client wants; the dashboard reads it to show current-vs-normal
 * and a widening / tightening flag.
 *
 * Idempotent: upserts the trading day, so re-running (the refresh cron fires every
 * ~10 min) just overwrites that day with the most complete snapshot. Runs after
 * the parse step; safe no-op if there's no curve or no priced bonds yet.
 *
 * The spread math is kept byte-for-byte in step with public/js/app.js
 * (usableYield, ccilCurve, govtYieldAt, tenorBucket) so the recorded baseline
 * matches what the live screen shows.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const QUOTES_PATH = fileURLToPath(new URL("../public/data/quotes.json", import.meta.url));
const CAT_PATH = fileURLToPath(new URL("../public/data/categories.json", import.meta.url));
const HIST_PATH = fileURLToPath(new URL("../public/data/spread-history.json", import.meta.url));
const KEEP_HISTORY_DAYS = 400; // ~13 months rolling; bounds file size

const num = (n) => typeof n === "number" && Number.isFinite(n);
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

/* ---- pricing primitives (mirror public/js/app.js) ---- */
const USABLE_Y_MIN = 2, USABLE_Y_MAX = 13;
function usableYield(q) {
  let y = null;
  if (num(q.yield)) y = q.yield;
  else if (q.side === "two_way" && num(q.bid) && num(q.offer) && q.level_meaning === "yield") y = (q.bid + q.offer) / 2;
  return y != null && y >= USABLE_Y_MIN && y <= USABLE_Y_MAX ? y : null;
}
const tenorBucket = (t) => (!num(t) ? null : t <= 1 ? "<=1y" : t <= 3 ? "1-3y" : t <= 5 ? "3-5y" : t <= 10 ? "5-10y" : "10y+");
function ccilCurve(points, day) {
  const dayMs = day ? Date.parse(day) : Date.now();
  const out = [];
  for (const p of points || []) {
    const mMs = Date.parse(p.maturity);
    if (!Number.isFinite(mMs) || !num(p.yield)) continue;
    const t = (mMs - dayMs) / (365.25 * 864e5);
    if (t > 0 && t <= 50) out.push({ t: Math.round(t * 100) / 100, y: p.yield });
  }
  out.sort((a, b) => a.t - b.t);
  return out.length >= 2 ? out : null;
}
function govtYieldAt(pts, t) {
  if (!pts || !pts.length) return null;
  if (t <= pts[0].t) return pts[0].y;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].y;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (t >= a.t && t <= b.t) return b.t === a.t ? (a.y + b.y) / 2 : a.y + (b.y - a.y) * (t - a.t) / (b.t - a.t);
  }
  return pts[pts.length - 1].y;
}
const tsSeconds = (s) => { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(s || "")); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0)) : -1; };

/* ---- category resolver (mirrors the fixed _resolveCategory in app.js) ---- */
function makeCategoryOf(cats) {
  const CAT_DIR = cats.directory || {}, CAT_ALIAS = cats.aliases || {};
  const CBF = new Map();
  for (const [nm, c] of Object.entries(CAT_DIR)) { const ft = nm.split(" ")[0]; if (!CBF.has(ft)) CBF.set(ft, []); CBF.get(ft).push([nm, c]); }
  const CN = Object.keys(CAT_DIR).sort();
  const SUF = /\b(?:LIMITED|LTD|PVT|PRIVATE|COMPANY|CO|CORPORATION|CORP|THE|AND)\b/g;
  const norm = (s) => { s = String(s || "").toUpperCase().replace(/&/g, " AND "); return s.replace(/[^A-Z0-9 ]/g, " ").replace(SUF, " ").replace(/\s+/g, " ").trim(); };
  const pat = (c) => { const t = c.split(" "); if (c.includes("NABARD") || (c.includes("NATIONAL BANK") && c.includes("AGRI"))) return "PSU"; if (c.includes("SIDBI") || (c.includes("SMALL IND") && c.includes("DEV"))) return "PSU"; if (c.includes("HOUSING FIN") || c.includes("HOME FIN")) return "HFC"; if (t.some((x) => x.endsWith("HFL"))) return "HFC"; if (t.some((x) => x.endsWith("FSL"))) return "NBFC"; if (t.includes("MF")) return "SKIP"; return null; };
  return (issuer) => {
    const c = norm(issuer); if (!c) return null;
    const toks = c.split(" "), ft = toks[0];
    if (toks.length > 1) { if (CAT_DIR[c]) return CAT_DIR[c]; for (const [nm, cat] of CBF.get(ft) || []) if (nm.startsWith(c)) return cat; }
    for (const t of toks) if (CAT_ALIAS[t]) return CAT_ALIAS[t];
    if (CAT_DIR[c]) return CAT_DIR[c];
    for (const [nm, cat] of CBF.get(ft) || []) if (nm.startsWith(c) || c.startsWith(nm)) return cat;
    const p = pat(c); if (p) return p === "SKIP" ? null : p;
    if (c.length >= 4) for (const nm of CN) if (nm.startsWith(c) || c.startsWith(nm + " ")) return CAT_DIR[nm];
    return null;
  };
}

/** Compute per-bucket median govt-spread (bps) for one trading day. */
export function daySpreadSnapshot(data, categoryOf) {
  const day = data.trading_day;
  const curve = ccilCurve(data.govt_benchmark?.points, day);
  if (!day || !curve) return null;
  // Bonds only, this trading day, aggregated to one LATEST quote per issuer+maturity.
  const bondMap = new Map();
  for (const q of data.quotes || []) {
    if (q.quote_date !== day) continue;
    if (q.section !== "Bonds" && q.section !== "DCM") continue;
    const uy = usableYield(q);
    if (uy == null || !num(q.tenor_years)) continue;
    const key = `${q.section}||${(q.issuer || "").toLowerCase()}||${q.maturity || ""}`;
    const prev = bondMap.get(key);
    if (!prev || tsSeconds(q.timestamp) >= prev.ts) {
      bondMap.set(key, { uy, tenor: q.tenor_years, issuer: q.issuer, rating: q.rating || null, ts: tsSeconds(q.timestamp) });
    }
  }
  // Group bonds into category|rating|bucket and category|ALL|bucket, take median spread.
  const groups = new Map();
  const add = (k, v) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(v); };
  for (const b of bondMap.values()) {
    const gy = govtYieldAt(curve, b.tenor);
    if (gy == null) continue;
    const spread = (b.uy - gy) * 100; // bps
    if (!(spread > -100 && spread < 1500)) continue; // drop parse-outlier spreads
    const cat = categoryOf(b.issuer);
    const bk = tenorBucket(b.tenor);
    if (!cat || !bk) continue;
    const rating = (b.rating || "").toUpperCase().trim();
    add(`${cat}|ALL|${bk}`, spread);
    if (rating) add(`${cat}|${rating}|${bk}`, spread);
  }
  const snap = {};
  for (const [k, arr] of groups) snap[k] = { med: Math.round(median(arr)), n: arr.length };
  return Object.keys(snap).length ? snap : null;
}

function main() {
  const src = process.argv[2] || QUOTES_PATH;
  if (!existsSync(src)) { console.warn("[spread-history] no quotes.json, skip"); return; }
  const data = JSON.parse(readFileSync(src, "utf8"));
  const cats = existsSync(CAT_PATH) ? JSON.parse(readFileSync(CAT_PATH, "utf8")) : { directory: {}, aliases: {} };
  const categoryOf = makeCategoryOf(cats);
  const snap = daySpreadSnapshot(data, categoryOf);
  if (!snap) { console.warn("[spread-history] no curve/priced bonds, skip"); return; }
  const day = data.trading_day;

  let hist = { _note: "Daily median spread over govt (bps) per category|rating|tenor bucket. Built by scripts/record-spread-history.mjs.", days: {} };
  if (existsSync(HIST_PATH)) { try { hist = JSON.parse(readFileSync(HIST_PATH, "utf8")); hist.days = hist.days || {}; } catch { /* start fresh */ } }
  hist.days[day] = snap; // upsert this trading day

  // Trim to the rolling window (keep newest KEEP_HISTORY_DAYS dates).
  const dates = Object.keys(hist.days).sort();
  if (dates.length > KEEP_HISTORY_DAYS) for (const d of dates.slice(0, dates.length - KEEP_HISTORY_DAYS)) delete hist.days[d];

  writeFileSync(HIST_PATH, JSON.stringify(hist) + "\n");
  console.log(`[spread-history] recorded ${day}: ${Object.keys(snap).length} buckets, ${Object.keys(hist.days).length} days on file`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
