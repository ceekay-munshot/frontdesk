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

async function main() {
  let prev = null;
  if (existsSync(OUT)) { try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch { prev = null; } }

  const ref = await buildTradedRef(prev);
  if (!ref) { console.warn("[traded-ref] no update — kept previous file"); return; }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(ref) + "\n");
  console.log(`[traded-ref] wrote ${OUT} — ${Object.keys(ref.byIsin).length} ISINs as of ${ref.as_of}`);
}

main().catch((err) => {
  console.error(`[traded-ref] ERROR: ${String(err?.stack || err).slice(0, 300)}`);
  process.exit(0); // never fail the refresh over the traded reference
});
