/**
 * gsec-history.mjs — free historical government-bond yield series.
 * ===========================================================================
 * For the "spread since issue" read we need where GOVERNMENT bonds yielded on a
 * PAST date, not just today. India's own sources (RBI/FBIL/CCIL) block automated
 * pulls, but the OECD publishes India's benchmark 10-year G-Sec yield monthly and
 * the St. Louis Fed (FRED) serves it as a clean CSV, free and without a key:
 *
 *   https://fred.stlouisfed.org/graph/fredgraph.csv?id=INDIRLTLT01STM
 *
 * We store it as a monthly map so the dashboard can show a bond's spread OVER THE
 * 10-YEAR G-SEC BENCHMARK back to when it started trading. (The live tenor-matched
 * CCIL curve still drives today's headline spread; this monthly 10Y series is the
 * consistent benchmark for the historical trend.)
 *
 * Reject-bad-keep-old: a failed fetch leaves the existing file untouched.
 * Node 22 (global fetch). No dependencies.
 */
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);

const FRED_10Y = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=INDIRLTLT01STM";
const OUT = new URL("../public/data/gsec-history.json", import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const looksLikeCsv = (t) => /observation_date/i.test((t || "").slice(0, 80));

/** Fetch the FRED CSV. Native fetch works in the GitHub Action (direct network);
 *  in the sandboxed session the agent proxy rejects node fetch to FRED, so we
 *  fall back to curl (its default UA passes the proxy). Either path is fine. */
async function fetchFredCsv(url) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1500 * attempt);
    try {
      const res = await fetch(url, { headers: { Accept: "text/csv,*/*" }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) { lastErr = new Error(`FRED HTTP ${res.status}`); continue; }
      const text = await res.text();
      if (looksLikeCsv(text)) return text;
      lastErr = new Error("FRED: unexpected payload");
    } catch (e) { lastErr = e; }
  }
  // Fallback: curl with its default UA (works through the sandbox proxy).
  try {
    const { stdout } = await execFileP("curl", ["-fsS", "--max-time", "30", url], { maxBuffer: 8 * 1024 * 1024 });
    if (looksLikeCsv(stdout)) return stdout;
  } catch (e) { lastErr = e; }
  throw lastErr || new Error("FRED: unreachable");
}

/** Parse FRED CSV -> { "YYYY-MM": yield }. Skips missing (".") values. */
function parseMonthly(text) {
  const out = {};
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (let i = 1; i < lines.length; i++) {
    const [date, valRaw] = lines[i].split(",");
    if (!date) continue;
    const v = parseFloat(valRaw);
    if (!Number.isFinite(v) || v <= 0) continue;
    out[date.slice(0, 7)] = Math.round(v * 100) / 100; // YYYY-MM -> yield
  }
  return out;
}

let prev = null;
try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch { prev = null; }

let monthly;
try {
  monthly = parseMonthly(await fetchFredCsv(FRED_10Y));
} catch (e) {
  console.warn(`[gsec-history] fetch failed (${e.message}); keeping previous`);
  if (!prev) process.exit(1);
  process.exit(0);
}

// Merge onto any previous months (so a temporary FRED gap never loses history).
const merged = { ...((prev && prev.monthly) || {}), ...monthly };
const months = Object.keys(merged).sort();
const out = {
  _note: "India benchmark 10-year G-Sec yield, monthly, from OECD via FRED (free). Used for the spread-since-issue read (spread over the 10Y G-Sec benchmark). Built by scripts/gsec-history.mjs.",
  series: "INDIRLTLT01STM",
  source: "OECD / FRED (fred.stlouisfed.org)",
  tenor_years: 10,
  as_of: months[months.length - 1] || null,
  monthly: merged,
};
await writeFile(OUT, JSON.stringify(out));
console.log(`[gsec-history] wrote ${months.length} months (${months[0]} -> ${out.as_of}); latest 10Y ${merged[out.as_of]}%`);
