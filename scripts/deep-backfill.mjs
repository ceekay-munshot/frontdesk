/**
 * deep-backfill.mjs — pull OLDER NSE CBM traded-bond history, walking backward.
 * ===========================================================================
 * The daily refresh keeps the traded reference current (last day + a little
 * history). This runner deepens it toward 2016 for the "spread since issue" read,
 * one throttled batch at a time (NSE's CDN blocks fast bulk pulls). It is safe to
 * run repeatedly and safe to run daily from the Action: each run resumes from the
 * oldest date already on file, so history fills in gradually with no re-fetching.
 *
 *   node scripts/deep-backfill.mjs [maxDays] [start] [delayMs]
 *   env: BACKFILL_MAX_DAYS, BACKFILL_START, BACKFILL_DELAY_MS
 *
 * Reject-bad-keep-old: on total failure the existing file is left untouched.
 */
import { readFile, writeFile } from "node:fs/promises";
import { backfillRange, backfillMonthly } from "./cbrics.mjs";

const FILE = new URL("../public/data/traded-ref.json", import.meta.url);

// mode "monthly" (default, efficient path to 2016) or "daily" (fine detail near
// the recent window). node deep-backfill.mjs [mode] [count] [start] [delayMs]
const mode = (process.argv[2] || process.env.BACKFILL_MODE || "monthly").toLowerCase();
const count = Number(process.argv[3] || process.env.BACKFILL_COUNT || 24);
const start = process.argv[4] || process.env.BACKFILL_START || "2016-01-01";
const delayMs = Number(process.argv[5] || process.env.BACKFILL_DELAY_MS || 700);

let prev = null;
try { prev = JSON.parse(await readFile(FILE, "utf8")); } catch { prev = null; }
if (!prev || !prev.byIsin) { console.error("[deep-backfill] no existing traded-ref.json — run fetch-traded-ref first"); process.exit(1); }

const before = { oldest: prev.oldest || null, isins: Object.keys(prev.byIsin).length };
const out = mode === "daily"
  ? await backfillRange(prev, { maxDays: count, start, delayMs })
  : await backfillMonthly(prev, { maxMonths: count, start, delayMs });
if (!out) { console.warn("[deep-backfill] nothing merged; kept previous"); process.exit(0); }

await writeFile(FILE, JSON.stringify(out));
const bytes = JSON.stringify(out).length;
console.log(`[deep-backfill] before oldest=${before.oldest} -> after oldest=${out.oldest}; ISINs ${before.isins} -> ${Object.keys(out.byIsin).length}; file ${(bytes / 1e6).toFixed(2)} MB`);
