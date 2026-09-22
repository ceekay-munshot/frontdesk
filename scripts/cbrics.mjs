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
 *      would have caught the "10% CD" earlier: it last traded ~6.1%).
 *   2. A real, growing historical baseline of traded yields per bond.
 *
 * The archive CSV is served by a CDN and needs no cookies. We walk back a few
 * days to the latest published file. Best-effort: returns null on any failure so
 * the caller keeps the last good snapshot (reject-bad-keep-old, like the parser).
 *
 * Node 22 (global fetch). No dependencies.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const CBM_BASE = "https://nsearchives.nseindia.com/archives/debt/cbm/cbm_trd";
const HISTORY_CAP = 120; // ~6 months of traded observations per ISIN

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

/** Parse "21-Sep-2026" -> "2026-09-21" (ISO). */
const MON = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
function isoDate(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || "").trim());
  if (!m) return null;
  const mo = MON[m[2].toLowerCase()];
  return mo ? `${m[3]}-${mo}-${pad(+m[1])}` : null;
}

/** Split a CSV line (no embedded commas in this feed, but trim quotes/space). */
const cells = (line) => line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());

async function fetchCsv(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/csv,*/*", Referer: "https://www.nseindia.com/" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text || !/ISIN/i.test(text.slice(0, 200))) return null; // must look like the bhavcopy
  return text;
}

/**
 * The latest published CBM bhavcopy: walk back up to `lookbackDays` from today
 * until a file exists. Returns { as_of, tradeDate, rows:[{isin, waYield, waPrice,
 * lastYield, lastPrice, valueCr}] } or null.
 */
export async function fetchTradedBhavcopy(lookbackDays = 8) {
  const today = new Date();
  for (let i = 0; i <= lookbackDays; i++) {
    const d = new Date(today); d.setUTCDate(today.getUTCDate() - i);
    let text = null;
    try { text = await fetchCsv(CBM_BASE + ymd(d) + ".csv"); } catch { text = null; }
    if (!text) continue;

    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const rows = [];
    let tradeDate = null;
    for (let j = 1; j < lines.length; j++) { // skip header
      const c = cells(lines[j]);
      if (c.length < 8) continue;
      const isin = (c[1] || "").trim();
      if (!/^INE|^IN\d/.test(isin)) continue;
      if (!tradeDate) tradeDate = isoDate(c[0]);
      const num = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };
      const waYield = num(c[7]), lastYield = num(c[5]);
      const y = isNum(waYield) && waYield > 0 ? waYield : (isNum(lastYield) && lastYield > 0 ? lastYield : null);
      if (y == null) continue;
      rows.push({
        isin, waYield, lastYield, waPrice: num(c[6]), lastPrice: num(c[2]),
        valueCr: isNum(num(c[4])) ? Math.round(num(c[4])) / 100 : null, // total value: lacs -> cr
        yield: y,
      });
    }
    if (rows.length) return { as_of: tradeDate || isoDate(cells(lines[1])[0]), tradeDate, rows, file: CBM_BASE + ymd(d) + ".csv" };
  }
  return null;
}

/**
 * Merge a fresh bhavcopy into the traded-reference store (per ISIN: latest trade
 * + a capped rolling history). `prev` is the existing traded-ref.json (or null).
 * Returns the updated object, or null when the fetch failed (keep-old).
 */
export async function buildTradedRef(prev) {
  const bc = await fetchTradedBhavcopy();
  if (!bc) { console.warn("[cbrics] no CBM bhavcopy available (kept previous)"); return null; }

  const out = { _note: "Real reported corporate-bond trades from NSE's CBM bhavcopy (the client's 'Cbrics'). Per ISIN: latest trade + rolling history. Built by scripts/cbrics.mjs.", as_of: bc.as_of, source: "NSE CBM daily bhavcopy (reported corporate bond trades)", file: bc.file, byIsin: (prev && prev.byIsin) || {} };
  let added = 0;
  for (const r of bc.rows) {
    const e = out.byIsin[r.isin] || { history: [] };
    e.date = bc.tradeDate || bc.as_of;
    e.yield = Math.round(r.yield * 1e4) / 1e4;
    e.price = isNum(r.waPrice) ? r.waPrice : r.lastPrice;
    e.valueCr = r.valueCr;
    // append to history (dedupe by date), newest last, capped
    const hist = (e.history || []).filter((h) => h.d !== e.date);
    hist.push({ d: e.date, y: e.yield });
    hist.sort((a, b) => (a.d < b.d ? -1 : 1));
    e.history = hist.slice(-HISTORY_CAP);
    out.byIsin[r.isin] = e;
    added++;
  }
  console.log(`[cbrics] traded reference: ${added} ISINs from ${bc.tradeDate} (${Object.keys(out.byIsin).length} total on file)`);
  return out;
}

export default buildTradedRef;
