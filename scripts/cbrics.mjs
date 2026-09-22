/**
 * cbrics.mjs — real traded corporate-bond yields (the client's "Cbrics" ask).
 * =========================================================================
 * "Cbrics" is NSE's Corporate Bond Reporting system: every OTC corporate-bond
 * trade is reported to the exchange, and NSE publishes the day's reported trades
 * as a public CSV (the "CBM Bhavcopy") — no login, no paid feed. Each row is a
 * REAL trade: ISIN, last/weighted-average price and YIELD (YTM), and turnover.
 *
 *   https://nsearchives.nseindia.com/archives/debt/cbm/cbm_trd<YYYYMMDD>.csv
 *
 * We use it two ways:
 *   1. A truth check on the desk's chat quotes — a name quoted far from where it
 *      actually traded is a mis-parse or a stale level (this is exactly what
 *      would have caught the "10% CD": it last traded ~6.1%).
 *   2. The real historical baseline — "where this bond usually trades" — that
 *      drives the dashboard's "Normal" read (with our own rolling spread history
 *      as the fallback when a bond has too few real trades).
 *
 * The archive CSV is served by a CDN and needs no cookies. Best-effort: a failed
 * fetch keeps the previous store (reject-bad-keep-old, like the parser).
 *
 * Node 22 (global fetch). No dependencies.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const CBM_BASE = "https://nsearchives.nseindia.com/archives/debt/cbm/cbm_trd";
const HISTORY_CAP = 260; // ~1 trading year of traded observations per ISIN

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

const MON = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
function isoDate(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || "").trim());
  if (!m) return null;
  const mo = MON[m[2].toLowerCase()];
  return mo ? `${m[3]}-${mo}-${pad(+m[1])}` : null;
}
const cells = (line) => line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());

async function fetchCsv(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/csv,*/*", Referer: "https://www.nseindia.com/" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text || !/ISIN/i.test(text.slice(0, 200))) return null;
  return text;
}

/** Parse ONE day's CBM bhavcopy for a Date. Returns { tradeDate, rows } or null. */
export async function fetchBhavcopyForDate(d) {
  let text = null;
  try { text = await fetchCsv(CBM_BASE + ymd(d) + ".csv"); } catch { text = null; }
  if (!text) return null;
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  let tradeDate = null;
  for (let j = 1; j < lines.length; j++) {
    const c = cells(lines[j]);
    if (c.length < 8) continue;
    const isin = (c[1] || "").trim();
    if (!/^INE|^IN\d/.test(isin)) continue;
    if (!tradeDate) tradeDate = isoDate(c[0]);
    const num = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };
    const waYield = num(c[7]), lastYield = num(c[5]);
    const y = isNum(waYield) && waYield > 0 ? waYield : (isNum(lastYield) && lastYield > 0 ? lastYield : null);
    if (y == null) continue;
    rows.push({ isin, waPrice: num(c[6]), lastPrice: num(c[2]), valueCr: isNum(num(c[4])) ? Math.round(num(c[4])) / 100 : null, yield: y });
  }
  return rows.length ? { tradeDate, rows, file: CBM_BASE + ymd(d) + ".csv" } : null;
}

/** Merge one day's bhavcopy into the per-ISIN store (latest snapshot + history). */
function mergeBhavcopy(byIsin, bc) {
  const date = bc.tradeDate;
  for (const r of bc.rows) {
    const e = byIsin[r.isin] || { history: [] };
    const y = Math.round(r.yield * 1e4) / 1e4;
    // latest snapshot = the most recent date seen
    if (!e.date || date >= e.date) { e.date = date; e.yield = y; e.price = isNum(r.waPrice) ? r.waPrice : r.lastPrice; e.valueCr = r.valueCr; }
    const hist = (e.history || []).filter((h) => h.d !== date);
    hist.push({ d: date, y });
    hist.sort((a, b) => (a.d < b.d ? -1 : 1));
    e.history = hist.slice(-HISTORY_CAP);
    byIsin[r.isin] = e;
  }
}

/**
 * Refresh the traded-reference store. `opts.backfillDays` (default 0) also pulls
 * that many calendar days of history so the baseline has depth immediately;
 * otherwise just the latest published bhavcopy is appended. Returns the updated
 * object or null when nothing could be fetched (keep-old).
 */
export async function buildTradedRef(prev, opts = {}) {
  const backfillDays = Math.max(0, opts.backfillDays || 0);
  const byIsin = (prev && prev.byIsin) || {};
  const today = new Date();
  let latest = null, merged = 0;

  // Oldest -> newest so the latest snapshot ends up current and history is ordered.
  for (let i = backfillDays; i >= 0; i--) {
    const d = new Date(today); d.setUTCDate(today.getUTCDate() - i);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // skip weekends (no file)
    const bc = await fetchBhavcopyForDate(d);
    if (!bc) continue;
    mergeBhavcopy(byIsin, bc);
    merged++;
    latest = bc;
  }
  if (!latest) { console.warn("[cbrics] no CBM bhavcopy available (kept previous)"); return null; }

  const out = {
    _note: "Real reported corporate-bond trades from NSE's CBM bhavcopy (the client's 'Cbrics'). Per ISIN: latest trade + rolling traded-yield history. Built by scripts/cbrics.mjs.",
    as_of: latest.tradeDate, source: "NSE CBM daily bhavcopy (reported corporate bond trades)", file: latest.file, byIsin,
  };
  console.log(`[cbrics] traded reference: merged ${merged} day(s); latest ${latest.tradeDate}; ${Object.keys(byIsin).length} ISINs on file`);
  return out;
}

export default buildTradedRef;
