/**
 * gsec-history.mjs — free historical government-bond yield CURVE (multi-tenor).
 * ===========================================================================
 * For the "spread since issue" read we need where GOVERNMENT bonds yielded on a
 * PAST date, at (roughly) the bond's remaining tenor on that date. India's own
 * sources (RBI/CCIL/FBIL) block automated pulls, and investing.com/tradingeconomics
 * return 403. The reliably-free, official series are the OECD ones served by the
 * St. Louis Fed (FRED), no key required:
 *
 *   overnight / call  : IRSTCI01INM156N   (~0y)
 *   3-month           : INDIR3TIB01STM    (~0.25y)
 *   10-year G-Sec     : INDIRLTLT01STM    (10y)
 *
 * We store all three as a monthly curve so the dashboard can INTERPOLATE the G-Sec
 * yield at a bond's remaining tenor for each past month (tenor-aware, not flat 10Y).
 * The 2-7y belly is interpolated between the 3-month and 10-year points — the one
 * approximation, since no free belly source is reachable; today's spread stays
 * exact (live CCIL, tenor-matched). Honest + free.
 *
 * Reject-bad-keep-old: a failed fetch leaves the existing file untouched.
 * Node 22 (global fetch, curl fallback for the sandbox proxy). No dependencies.
 */
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);

const OUT = new URL("../public/data/gsec-history.json", import.meta.url);
const FRED = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=";
// Each official series with the tenor (years) it represents on the curve.
const SERIES = [
  { id: "IRSTCI01INM156N", tenor: 0.02 }, // call / overnight
  { id: "INDIR3TIB01STM", tenor: 0.25 },  // 3-month
  { id: "INDIRLTLT01STM", tenor: 10 },    // 10-year benchmark G-Sec
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const looksLikeCsv = (t) => /observation_date/i.test((t || "").slice(0, 80));

async function fetchFredCsv(id) {
  const url = FRED + id;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1500 * attempt);
    try {
      const res = await fetch(url, { headers: { Accept: "text/csv,*/*" }, signal: AbortSignal.timeout(30000) });
      if (res.ok) { const t = await res.text(); if (looksLikeCsv(t)) return t; lastErr = new Error("bad payload"); }
      else lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
  }
  try { const { stdout } = await execFileP("curl", ["-fsS", "--max-time", "30", url], { maxBuffer: 8 * 1024 * 1024 }); if (looksLikeCsv(stdout)) return stdout; } catch (e) { lastErr = e; }
  throw lastErr || new Error("unreachable");
}
/** FRED CSV -> { "YYYY-MM": yield }. */
function parseMonthly(text) {
  const out = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [date, valRaw] = line.split(",");
    if (!date) continue;
    const v = parseFloat(valRaw);
    if (Number.isFinite(v) && v > 0) out[date.slice(0, 7)] = Math.round(v * 100) / 100;
  }
  return out;
}

let prev = null;
try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch { prev = null; }

// Fetch each series; tolerate one failing as long as the 10Y (the anchor) lands.
const perSeries = {};
let got10y = false;
for (const s of SERIES) {
  try { perSeries[s.id] = { tenor: s.tenor, monthly: parseMonthly(await fetchFredCsv(s.id)) }; if (s.id === "INDIRLTLT01STM") got10y = true; }
  catch (e) { console.warn(`[gsec-history] ${s.id} failed: ${e.message}`); }
}
if (!got10y && !(prev && prev.monthly)) { console.error("[gsec-history] could not fetch the 10Y anchor and no previous file — aborting"); process.exit(1); }

// Assemble a monthly multi-tenor curve: month -> [[tenor, yield], ...] sorted by tenor.
const monthly = {};
// seed from previous so a temporarily-missing series never wipes history
if (prev && prev.monthly) for (const [m, pts] of Object.entries(prev.monthly)) monthly[m] = Array.isArray(pts) ? pts.slice() : [];
for (const s of SERIES) {
  const rec = perSeries[s.id];
  if (!rec) continue;
  for (const [m, y] of Object.entries(rec.monthly)) {
    const pts = (monthly[m] || []).filter((p) => p[0] !== s.tenor); // replace same-tenor
    pts.push([s.tenor, y]);
    pts.sort((a, b) => a[0] - b[0]);
    monthly[m] = pts;
  }
}
const months = Object.keys(monthly).sort();
const out = {
  _note: "India G-Sec curve, monthly, from OECD via FRED (free): overnight, 3-month, 10-year. Each month is [[tenorYears, yield%], ...]. The dashboard interpolates to a bond's remaining tenor for the spread-since-issue read. Built by scripts/gsec-history.mjs.",
  series: SERIES.map((s) => s.id),
  source: "OECD / FRED (fred.stlouisfed.org)",
  tenors: SERIES.map((s) => s.tenor),
  as_of: months[months.length - 1] || null,
  monthly,
};
await writeFile(OUT, JSON.stringify(out));
const latest = monthly[out.as_of] || [];
console.log(`[gsec-history] wrote ${months.length} months (${months[0]} -> ${out.as_of}); latest curve: ${latest.map(([t, y]) => `${t}y=${y}%`).join(", ")}`);
