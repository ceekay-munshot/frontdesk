/**
 * fetch-traded-ref.mjs — refresh the real traded-yield reference (the client's
 * "Cbrics"). Downloads NSE's latest CBM bhavcopy (reported corporate-bond trades)
 * and merges it into public/data/traded-ref.json: per ISIN, the latest traded
 * yield/price + a rolling history. Best-effort — a failed fetch keeps the
 * previous file (reject-bad-keep-old), so the refresh never blanks the reference.
 *
 * Run as a workflow step after the parse; the frontend reads traded-ref.json to
 * show "last traded X% (NSE)" and to flag a desk quote that is far from the last
 * real trade.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { buildTradedRef } from "./cbrics.mjs";

const OUT = fileURLToPath(new URL("../public/data/traded-ref.json", import.meta.url));
const QUOTES = fileURLToPath(new URL("../public/data/quotes.json", import.meta.url));

/** The "relevant" set = every ISIN the desk has ever quoted (accumulated across
 *  the rotating Google Doc). These get FULL trade detail; the rest of the market
 *  gets a light tail. Persisted in traded-ref.relevant so it never forgets. */
function buildRelevant(prev) {
  const set = new Set((prev && prev.relevant) || []);
  try {
    const q = JSON.parse(readFileSync(QUOTES, "utf8"));
    for (const x of q.quotes || []) if (x.isin) set.add(x.isin);
  } catch { /* no quotes yet — keep the persisted set */ }
  return set;
}

async function main() {
  let prev = null;
  if (existsSync(OUT)) { try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch { prev = null; } }

  const relevant = buildRelevant(prev);
  // A small rolling backfill self-heals days missed over a weekend or a failed
  // run; the per-ISIN history dedupes by date, so re-merging a day is a no-op.
  const ref = await buildTradedRef(prev, { backfillDays: 6, relevant });
  if (!ref) { console.warn("[traded-ref] no update — kept previous file"); return; }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(ref) + "\n");
  console.log(`[traded-ref] wrote ${OUT} — ${Object.keys(ref.byIsin).length} ISINs (${ref.relevant.length} relevant/full) as of ${ref.as_of}`);
}

main().catch((err) => {
  console.error(`[traded-ref] ERROR: ${String(err?.stack || err).slice(0, 300)}`);
  process.exit(0); // never fail the refresh over the traded reference
});
