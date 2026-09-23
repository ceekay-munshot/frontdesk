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
// History retention. We keep every observation inside a recent window (fine
// detail for the "usually trades" read), and for anything older we keep only ONE
// observation per calendar month (downsampled) — enough to draw a bond's
// spread-since-issue trajectory without letting the file balloon as we backfill
// years of trades. A hard cap bounds the worst case, and NEVER drops the oldest
// (since-issue) anchors: only the middle recent detail is thinned.
const RECENT_DAYS = 420;   // ~1.4 trading years kept in full
const MAX_OBS = 520;       // per-ISIN ceiling (oldest monthly anchors always kept)
const BACKFILL_START = "2016-01-01"; // NSE CBM archive reaches ~here

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ISO date `RECENT_DAYS` before `nowIso` — the cutoff below which history is
 *  downsampled to one observation per month. */
function recentCutoff(nowIso) {
  const d = new Date((nowIso || new Date().toISOString().slice(0, 10)) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - RECENT_DAYS);
  return d.toISOString().slice(0, 10);
}
/** Keep recent obs in full + one-per-month for older; always preserve the oldest
 *  anchors, thinning only the middle recent detail if over MAX_OBS. */
function retainHistory(history, nowIso) {
  const cutoff = recentCutoff(nowIso);
  const sorted = (history || []).filter((h) => h && h.d).sort((a, b) => (a.d < b.d ? -1 : 1));
  const older = new Map(), recent = [];
  for (const h of sorted) {
    if (h.d >= cutoff) recent.push(h);
    else older.set(h.d.slice(0, 7), h); // YYYY-MM -> last obs that month (asc: last wins)
  }
  const olderArr = [...older.values()];
  const budget = Math.max(0, MAX_OBS - olderArr.length);
  const recentKept = recent.length > budget ? recent.slice(-budget) : recent;
  return [...olderArr, ...recentKept].sort((a, b) => (a.d < b.d ? -1 : 1));
}
/** The oldest trade date on file across all ISINs (histories are sorted asc). */
function computeOldest(byIsin) {
  let min = null;
  for (const k in byIsin) { const h = byIsin[k].history; if (h && h.length && (!min || h[0].d < min)) min = h[0].d; }
  return min;
}

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
function mergeBhavcopy(byIsin, bc, nowIso) {
  const date = bc.tradeDate;
  for (const r of bc.rows) {
    const e = byIsin[r.isin] || { history: [] };
    const y = Math.round(r.yield * 1e4) / 1e4;
    // latest snapshot = the most recent date seen (never overwritten by backfill)
    if (!e.date || date >= e.date) { e.date = date; e.yield = y; e.price = isNum(r.waPrice) ? r.waPrice : r.lastPrice; e.valueCr = r.valueCr; }
    const hist = (e.history || []).filter((h) => h.d !== date);
    hist.push({ d: date, y });
    e.history = retainHistory(hist, nowIso);
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
  const nowIso = today.toISOString().slice(0, 10);
  let latest = null, merged = 0;

  // Oldest -> newest so the latest snapshot ends up current and history is ordered.
  for (let i = backfillDays; i >= 0; i--) {
    const d = new Date(today); d.setUTCDate(today.getUTCDate() - i);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // skip weekends (no file)
    const bc = await fetchBhavcopyForDate(d);
    if (!bc) continue;
    mergeBhavcopy(byIsin, bc, nowIso);
    merged++;
    latest = bc;
  }
  if (!latest) { console.warn("[cbrics] no CBM bhavcopy available (kept previous)"); return null; }

  const out = {
    _note: "Real reported corporate-bond trades from NSE's CBM bhavcopy (the client's 'Cbrics'). Per ISIN: latest trade + traded-yield history (recent in full, older downsampled monthly). Built by scripts/cbrics.mjs.",
    as_of: latest.tradeDate, source: "NSE CBM daily bhavcopy (reported corporate bond trades)", file: latest.file,
    oldest: computeOldest(byIsin), byIsin,
  };
  console.log(`[cbrics] traded reference: merged ${merged} day(s); latest ${latest.tradeDate}; oldest ${out.oldest}; ${Object.keys(byIsin).length} ISINs on file`);
  return out;
}

/**
 * DEEP backfill: walk BACKWARD from the oldest date already on file toward
 * `opts.start` (default 2016), pulling up to `opts.maxDays` trading days this run.
 * NSE's CDN throttles bulk pulls (HTTP 403 "Access Denied"), so each day is tried
 * a few times with exponential back-off and there's a polite delay between days.
 * Progress is resumable: successive runs continue from the new oldest-on-file, so
 * history fills in gradually (also safe to run daily from the Action). Returns the
 * updated store (keep-old shape) — never null once `prev` exists.
 */
export async function backfillRange(prev, opts = {}) {
  const byIsin = (prev && prev.byIsin) || {};
  const start = opts.start || BACKFILL_START;
  const maxDays = Math.max(1, opts.maxDays || 60);
  const delayMs = opts.delayMs ?? 700;
  const nowIso = opts.nowIso || new Date().toISOString().slice(0, 10);
  const startD = new Date(start + "T00:00:00Z");
  const globalOldest = computeOldest(byIsin);
  const cursor = globalOldest ? new Date(globalOldest + "T00:00:00Z") : new Date();
  cursor.setUTCDate(cursor.getUTCDate() - 1); // the day before the current oldest

  let attempted = 0, merged = 0, blocked = 0, latest = null;
  while (attempted < maxDays && cursor >= startD) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) { // weekdays only (no weekend file)
      attempted++;
      let bc = null;
      for (let t = 0; t < 3 && !bc; t++) {
        try { bc = await fetchBhavcopyForDate(cursor); } catch { bc = null; }
        if (!bc && t < 2) { blocked++; await sleep(delayMs * (t + 2)); } // back off (block or holiday)
      }
      if (bc) { mergeBhavcopy(byIsin, bc, nowIso); merged++; if (!latest) latest = bc; }
      await sleep(delayMs);
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  const oldest = computeOldest(byIsin);
  const out = {
    _note: (prev && prev._note) || "Real reported corporate-bond trades from NSE's CBM bhavcopy (the client's 'Cbrics').",
    as_of: (prev && prev.as_of) || (latest && latest.tradeDate) || null,
    source: (prev && prev.source) || "NSE CBM daily bhavcopy (reported corporate bond trades)",
    file: (prev && prev.file) || (latest && latest.file) || null,
    oldest, byIsin,
  };
  console.log(`[cbrics] deep backfill: reached ${cursor.toISOString().slice(0, 10)}; attempted ${attempted}, merged ${merged}, blocked ${blocked}; oldest on file now ${oldest}; ${Object.keys(byIsin).length} ISINs`);
  return out;
}

/**
 * MONTHLY deep backfill — the efficient path to 2016. Older-than-recent history
 * is downsampled to one observation per month anyway, so instead of fetching all
 * ~250 trading days a year we fetch ONE representative day per month (trying a few
 * candidate dates to dodge holidays/blocks). Walks backward from the month before
 * the oldest-on-file toward `opts.start`, up to `opts.maxMonths` months per run.
 * Resumable and Action-safe, like backfillRange.
 */
export async function backfillMonthly(prev, opts = {}) {
  const byIsin = (prev && prev.byIsin) || {};
  const start = opts.start || BACKFILL_START;
  const maxMonths = Math.max(1, opts.maxMonths || 24);
  const delayMs = opts.delayMs ?? 700;
  const nowIso = opts.nowIso || new Date().toISOString().slice(0, 10);
  const startY = +start.slice(0, 4), startM = +start.slice(5, 7);
  const globalOldest = computeOldest(byIsin);
  let y, m;
  if (globalOldest) { y = +globalOldest.slice(0, 4); m = +globalOldest.slice(5, 7); }
  else { const t = new Date(); y = t.getUTCFullYear(); m = t.getUTCMonth() + 1; }
  const stepBack = () => { m--; if (m < 1) { m = 12; y--; } };
  stepBack(); // begin at the month before the current oldest

  const candDays = [16, 12, 20, 9, 23, 6]; // mid-month first, then spread out
  let months = 0, merged = 0, blocked = 0, oldestMonth = null;
  while (months < maxMonths && (y > startY || (y === startY && m >= startM))) {
    months++;
    let bc = null;
    for (const day of candDays) {
      const d = new Date(Date.UTC(y, m - 1, day));
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      try { bc = await fetchBhavcopyForDate(d); } catch { bc = null; }
      if (bc) break;
      blocked++;
      await sleep(delayMs);
    }
    if (bc) { mergeBhavcopy(byIsin, bc, nowIso); merged++; oldestMonth = `${y}-${pad(m)}`; }
    await sleep(delayMs);
    stepBack();
  }
  const oldest = computeOldest(byIsin);
  const out = {
    _note: (prev && prev._note) || "Real reported corporate-bond trades from NSE's CBM bhavcopy (the client's 'Cbrics').",
    as_of: (prev && prev.as_of) || null,
    source: (prev && prev.source) || "NSE CBM daily bhavcopy (reported corporate bond trades)",
    file: (prev && prev.file) || null,
    oldest, byIsin,
  };
  console.log(`[cbrics] monthly backfill: ${months} month(s) attempted, merged ${merged}, blocked ${blocked}; oldest month reached ${oldestMonth || "—"}; oldest on file ${oldest}; ${Object.keys(byIsin).length} ISINs`);
  return out;
}

export default buildTradedRef;
