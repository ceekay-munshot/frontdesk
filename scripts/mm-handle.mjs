/**
 * Money-market "dropped handle" yield repair.
 *
 * The LKP debt desk quotes CDs and CPs (money-market paper) in a shorthand that
 * DROPS the whole-number "handle" of the yield — everyone on the desk knows a CD
 * trades in the 6s, so they type only the digits after the decimal:
 *
 *     "18-12  Kotak cd  10 offer  50cr"        ->  10  means 6.10%
 *     "SIDBI CD 13 Oct 100crs 5.55 / 70"       ->  70  means 6.70%   (bid 5.55 is full)
 *     "14/12 hdfc 22 bid ... sold at 6.22%"    ->  22  means 6.22%   (confirmed by the print)
 *
 * The structuring LLM has no way to know the handle, so it reads "10" as a full
 * 10.00% yield. For an A1+ sub-1-year bank CD that is impossible (~6.1% is real),
 * and it makes the bond look ~380 bps cheap — a false "buy" flag on the board.
 *
 * This repair runs AFTER structuring, deterministically, over the parsed quotes:
 *   1. Infer the day's money-market handle from the CDs/CPs that WERE quoted with
 *      a full decimal yield (e.g. 6.05, 6.18, 6.85 -> handle 6).
 *   2. For each CD/CP, any yield/bid/offer/level that is a bare integer in [10,99]
 *      is a dropped handle -> rebuild it as handle + n/100 (10 -> 6.10, 85 -> 6.85).
 *
 * It only ever touches CD/CP instruments and only bare integers >= 10 (a real
 * money-market yield always carries a decimal and sits below ~9%), so a correctly
 * quoted 6.18 or an 8.10 is never altered. Idempotent: a rebuilt 6.10 is not an
 * integer in [10,99], so re-running is a no-op.
 */

const MM_TYPES = new Set(["CD", "CP"]);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const isMM = (q) => MM_TYPES.has(String(q?.instrument_type || "").toUpperCase());

/** A bare integer in [10,99] on a money-market quote = the desk dropped the handle. */
const isDroppedHandle = (v) => isNum(v) && Number.isInteger(v) && v >= 10 && v <= 99;

/** A cleanly quoted money-market yield: has a decimal and sits in a real MM band. */
const isCleanMMYield = (v) => isNum(v) && !Number.isInteger(v) && v >= 3 && v <= 9;

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Whole-number handle for a set of MM quotes, from the ones quoted in full. */
function inferHandle(mmQuotes, fallback) {
  const clean = [];
  for (const q of mmQuotes) {
    for (const v of [q.yield, q.bid, q.offer, q.level]) if (isCleanMMYield(v)) clean.push(v);
  }
  if (clean.length < 2) return fallback;
  const h = Math.floor(median(clean));
  return h >= 4 && h <= 8 ? h : fallback; // MM handles live in a narrow band
}

/**
 * Repair dropped-handle money-market yields in place. Returns { fixed, details }.
 * `quotes` is the parsed quote array (mutated). Safe to call more than once.
 */
export function fixMoneyMarketYields(quotes) {
  if (!Array.isArray(quotes) || !quotes.length) return { fixed: 0, details: [] };

  // Handle can drift with rates, so infer it PER DAY, and use the whole sample's
  // handle as the fallback for a day too thin to infer on its own.
  const mm = quotes.filter(isMM);
  const globalHandle = inferHandle(mm, 6);
  const byDay = new Map();
  for (const q of mm) {
    const d = q.quote_date || "_";
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(q);
  }
  const handleForDay = new Map();
  for (const [d, qs] of byDay) handleForDay.set(d, inferHandle(qs, globalHandle));

  const details = [];
  let fixed = 0;
  const FIELDS = ["yield", "bid", "offer", "level"];
  for (const q of mm) {
    const handle = handleForDay.get(q.quote_date || "_") ?? globalHandle;
    let touched = false;
    const before = {};
    for (const f of FIELDS) {
      if (!isDroppedHandle(q[f])) continue;
      const recon = Math.round((handle + q[f] / 100) * 1e4) / 1e4;
      if (recon < 3.5 || recon > 9) continue; // rebuilt value must be a real MM yield
      before[f] = q[f];
      q[f] = recon;
      touched = true;
    }
    if (touched) {
      q.handle_fixed = true; // provenance: this quote's MM yield was rebuilt
      fixed++;
      details.push({ id: q.id, isin: q.isin || null, issuer: q.issuer, handle, before, raw: q.raw });
    }
  }
  return { fixed, details };
}

export default fixMoneyMarketYields;
