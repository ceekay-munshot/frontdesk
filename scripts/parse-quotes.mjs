/**
 * parse-quotes.mjs — The Front Desk data engine.
 * ===============================================
 * Reads the shared Google Doc where a junior trader pastes the day's bond
 * dealing-desk chat, hands the messy shorthand to an LLM to ORGANISE (never
 * invent) into structured rows, and writes public/data/quotes.json for the
 * static Live Board to render.
 *
 * The doc is a plain-text export of a link-shared Google Doc (no login). It has
 * three sections — Bonds (corporate NCDs), Gsec (government securities) and DCM
 * (money-market CP/CD) — each marked by a bare line "Bonds" / "Gsec" / "DCM".
 * Under each section, a dealer header line ("Sunita Patil Lkp Securities Ltd.")
 * owns every quote line beneath it until the next header.
 *
 * Flow:
 *   1. Fetch the txt export (fetch follows the redirect).
 *   2. Split into sections; track the current dealer + firm from header lines;
 *      attach each quote line to that dealer.
 *   3. Build ONE annotated transcript — each quote line prefixed with its
 *      section + dealer — and call llmStructured() (Claude via Bedrock, OpenAI
 *      fallback) to convert it into the strict schema. Chunk large days.
 *   4. Validate rows, drop junk, write quotes.json.
 *
 * Safety rails ("reject-bad-keep-old"): if the doc is unreachable/empty, has no
 * quote-like lines, or the model returns zero valid rows, the existing
 * quotes.json is left untouched and the process exits 0 with a warning — a bad
 * run never blanks the board.
 *
 * DRY RUN: `node scripts/parse-quotes.mjs --dry` (or DRY_RUN=1) prints the
 * sectioning / dealer tracking / chunking diagnostics and skips every LLM call,
 * so the parsing can be validated against the live doc without a key.
 *
 * Node 22 (global fetch). No dependencies. All secrets come from env via llm.mjs.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { llmStructured, activeModel, llmBanner } from "./llm.mjs";
import { fetchGovtBenchmark } from "./ccil.mjs";

/* ---------------------------------------------------------------------------
   Configuration.
   ------------------------------------------------------------------------- */

const DOC_URL =
  "https://docs.google.com/document/d/11e0cnpJhjqCZJj3LMOF88oYZUGTwYCpZtKX6zVErU_4/export?format=txt";

/** Output file, resolved relative to this script so cwd never matters. */
const OUT_PATH = fileURLToPath(new URL("../public/data/quotes.json", import.meta.url));

/** Quote lines per LLM call. Each input line expands into a verbose 20-field
 *  JSON object, so the OUTPUT bounds the chunk, not the input: 300-line chunks
 *  overflowed even a 65k max_tokens ceiling in production. ~40 lines keeps each
 *  reply near ~9k output tokens — well under even the DEFAULT 16k budget (and the
 *  workflow raises it further), so no chunk ever truncates and llm.mjs never
 *  renegotiates its process-global token budget mid-run. That no-truncation
 *  property is what makes the bounded parallelism below safe. */
const CHUNK_LINES = 40;

/** Chunks run with bounded parallelism (see the warm-up note in main() for why
 *  that is concurrency-safe against llm.mjs's shared state). A full trading day
 *  is ~700 structured rows, which streams for ~15 min one-chunk-at-a-time — over
 *  the 10-minute refresh cron; parallelism brings a run back to a few minutes. */
const CHUNK_CONCURRENCY = 5;

const DRY_RUN = process.env.DRY_RUN === "1" || process.argv.includes("--dry");

const VALID_SECTIONS = new Set(["Bonds", "Gsec", "DCM"]);
const VALID_SIDES = new Set(["bid", "offer", "two_way", "buy", "sell", "ask", "comment"]);

/* ---------------------------------------------------------------------------
   The strict schema. Both providers require: top-level object,
   additionalProperties:false, EVERY property listed in "required", and nullable
   fields typed as arrays like {"type":["number","null"]}.
   ------------------------------------------------------------------------- */

const QUOTES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["quotes"],
  properties: {
    quotes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id", "dealer", "firm", "section", "issuer", "instrument_type",
          "coupon", "maturity", "tenor_years", "side", "bid", "offer", "level",
          "level_meaning", "size_cr", "yield", "timestamp", "flags", "raw",
          "confidence",
        ],
        properties: {
          id: { type: "string" },
          dealer: { type: ["string", "null"] },
          firm: { type: ["string", "null"] },
          section: { type: "string", enum: ["Bonds", "Gsec", "DCM"] },
          issuer: { type: ["string", "null"] },
          instrument_type: { type: ["string", "null"] },
          coupon: { type: ["number", "null"] },
          maturity: { type: ["string", "null"] },
          tenor_years: { type: ["number", "null"] },
          side: {
            type: "string",
            enum: ["bid", "offer", "two_way", "buy", "sell", "ask", "comment"],
          },
          bid: { type: ["number", "null"] },
          offer: { type: ["number", "null"] },
          level: { type: ["number", "null"] },
          level_meaning: {
            type: "string",
            enum: ["size_cr", "price", "yield", "spread_bps", "price_or_spread", "unknown"],
          },
          size_cr: { type: ["number", "null"] },
          yield: { type: ["number", "null"] },
          timestamp: { type: ["string", "null"] },
          flags: { type: "array", items: { type: "string" } },
          raw: { type: "string" },
          confidence: { type: ["number", "null"] },
        },
      },
    },
  },
};

/* ---------------------------------------------------------------------------
   Prompts. The model ORGANISES, it does not opine or invent.
   ------------------------------------------------------------------------- */

const SYSTEM = `You ORGANIZE messy Indian bond dealing-desk chat lines into a strict JSON schema.
You do NOT invent bonds, issuers, numbers, or dates — you only structure what is actually written.
Keep the EXACT original message text in \`raw\`. Use null for any field the line does not state.

Each input line is prefixed with a tag: [SECTION | Dealer Name @ Firm].
Copy SECTION verbatim into \`section\`, the dealer name into \`dealer\`, and the firm into \`firm\`.
Everything after the "] " is the original chat message — put it, unchanged, in \`raw\`.

Emit ONE row per genuine quote / order / desk-action line.

ALWAYS emit a row for SWITCH IDEAS and TRADE REQUESTS — set side "comment" and keep the exact text in
\`raw\`. The desk trades on these, so never drop them. Examples that MUST become a "comment" row (this
is not an exhaustive list): "Can switch REC Dec 28 with NAB Sep 28 : 25 crs, 10 bps to recv",
"Switch X to Y", "Sell 5/10 NTPC CP and buy 6/11 NTPC CP", "what bid in 21/9 hdfc cd?", "px pls",
"offers pls", "bids pls", "any bid?", "offer?", "level pls".

ALWAYS emit a row for DONE / DEALT trade prints — a bond that actually TRADED. These executed levels
are prime market color and must never be dropped. Examples that MUST become a row:
"7.48 NABARD SEP2028 7.63 dealt 25 cr - Bajaj mf to bandhan", "7.85 PFC 03/04/2028 7.50 dltmkt bandhan
mf sold to pnb", "83 dealt ..25cr each", "CHK got @ 73 75crs". The words "dealt", "done", "dltmkt",
"dlt", "traded", "sold to", "bought from", or a "<counterparty> to <counterparty>" hand-off all mark a
print. Put the traded level in the right numeric field (yield/level) and the whole line in \`raw\`; use
the dealer's own side only when the line clearly states one, otherwise side "comment".

SKIP only PURE noise and do not emit a row for it: counterparty or mutual-fund tags on their own line
(e.g. "axis mf", "nippon mf", "isec", "bob mf", "ECL fin", "birla pen", "emf"), general non-market
chatter (e.g. "zoom bandh raka hain kya"), and chat read markers ("Today", "Unread messages").
Rule of thumb: if a line names a bond/instrument, or asks for a price / bid / offer / switch, KEEP it
(as a quote when it states a side or level, otherwise as a "comment"). Only skip a line when it is
clearly pure noise with no bond and no request in it.

FIELD RULES:
- side: "bid" or "buy" when the dealer wants to BUY; "offer", "sell" or "ask" when they want to SELL;
  "two_way" when BOTH a bid and an offer are quoted; "comment" for a desk action with no clear side
  (a switch idea, "done", or a request like "px pls" / "offers pls" / "any bid?" — always keep these).
- A number immediately followed by "cr" or "crs" is size_cr — e.g. "100crs" -> size_cr 100, "25 cr" -> 25.
- "@ 6.35", or a standalone yield-looking value (roughly 5 to 9 with decimals), -> yield.
- coupon: a percent rate stated with the bond, e.g. "7.3%" or a leading "7.43 Sidbi" -> coupon 7.43.
- Two-way where both numbers look like yields ("7.20/7.23") -> side "two_way", bid & offer = those
  yields, level_meaning "yield".
- Two-way with small integers ("35/39") -> side "two_way", bid & offer = those integers,
  level_meaning "price_or_spread".
- A bare number just before OFFER/BID with none of the above -> level, level_meaning "unknown".
- maturity: output as an ISO date "YYYY-MM-DD" whenever you can parse one, else null. Parse messy
  forms: 01DEC27, 31/8/2026, "Dec 2029" (assume the 1st), "27 MAR 2035", "23-11-2029",
  "MD 12/10/2028", "(01/07/2030)", "Jun-2028", "Sept 2028".
- tenor_years: whole years plus a decimal from the TRADING DAY (given below) to maturity, e.g. 3.4.
  null when there is no maturity.
- flags: the subset of ["bid_pls","offer_pls","cbc","can_buy_more","can_sell","done","switch"] that
  the line expresses ("bid pls" -> bid_pls, "cbc" -> cbc, "can buy more" -> can_buy_more,
  "can sell" -> can_sell, "switch" -> switch, "done" -> done).
- instrument_type: e.g. "NCD", "SDL", "GS", "T-Bill", "CP", "CD" when named, else null.
- confidence: 0 to 1, how confident you are the structured row faithfully matches the messy line.
- id: any short string; it will be reassigned downstream, so it need not be unique.

Return {"quotes":[ ... ]}, with EVERY listed field present on each row (null where the line is silent).`;

/* ---------------------------------------------------------------------------
   Fetch.
   ------------------------------------------------------------------------- */

async function fetchDoc() {
  const res = await fetch(DOC_URL, { redirect: "follow", signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`doc fetch ${res.status}`);
  return await res.text();
}

/* ---------------------------------------------------------------------------
   Sectioning + dealer tracking.
   ------------------------------------------------------------------------- */

/** A bare section marker line: "Bonds" / "Gsec" (or "G-Sec") / "DCM". */
function markerSection(line) {
  const m = line.replace(/^﻿/, "").trim().match(/^(bonds|g-?sec|dcm)$/i);
  if (!m) return null;
  const s = m[1].toLowerCase().replace("-", "");
  return s === "bonds" ? "Bonds" : s === "gsec" ? "Gsec" : "DCM";
}

/* ---------------------------------------------------------------------------
   Day markers.

   The shared doc is a running chat log: over time it accumulates several trading
   days under one section, and the junior trader dates each day's block with a
   bare line like "25-Aug-2026". We read those markers to stamp every quote with
   the day it was said on, so the board can show all days newest-first while the
   analysis tabs focus on the latest (live) day. See main().
   ------------------------------------------------------------------------- */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Recognise a standalone day-separator line the trader typed to date the chat
 * below it. Accept a line ONLY when the whole line is a single calendar date,
 * it is NOT indented (portfolio maturity dumps are tab-indented, e.g.
 * "\t18-Mar-30"), and the date falls in a recent window ending at the run day.
 * That window is the safety net: it rejects a stray FUTURE maturity date (e.g.
 * "01-Jul-2027") that would otherwise be read as "the latest day" and hide every
 * real quote. Returns an ISO "YYYY-MM-DD" or null.
 */
function dayMarker(rawLine, runDay) {
  if (/^[ \t]/.test(rawLine)) return null; // indented -> a maturity date, not a day marker
  const t = rawLine.replace(/^﻿/, "").trim();
  let d, mo, y, m;
  if ((m = t.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,4})[-/ ](\d{4})$/))) { d = +m[1]; mo = MONTHS[m[2].toLowerCase()]; y = +m[3]; } // 25-Aug-2026
  else if ((m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; } // 25-08-2026 / 25/08/2026
  else if ((m = t.match(/^([A-Za-z]{3,4})\.?\s+(\d{1,2}),?\s+(\d{4})$/))) { mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; y = +m[3]; } // Aug 25, 2026
  else return null;
  if (!mo || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  // Recent window only: desk chat is today or the recent past, never the future.
  const diff = Math.floor(Date.parse(runDay) / 864e5) - Math.floor(Date.parse(iso) / 864e5);
  if (!Number.isFinite(diff) || diff < 0 || diff > 60) return null;
  return iso;
}

/** Firm brand words a dealer header names, and the corporate suffix it ends in.
 *  Dealer headers carry NO digits (a quote line like "Tata Capital Ltd. 8.01% ..."
 *  does), which is what keeps bond issuers from being misread as headers. */
const FIRM_MARKER = /\b(securities|broking|wealth|investments?|capital markets|fincap|stock)\b/i;
const CORP_SUFFIX = /\b(ltd|limited|llp|pvt)\b\.?\s*$/i;

function isDealerHeader(line) {
  const t = line.trim();
  if (!t || /\d/.test(t)) return false;
  if (!FIRM_MARKER.test(t) || !CORP_SUFFIX.test(t)) return false;
  const words = t.split(/\s+/);
  return words.length >= 3 && words.length <= 9;
}

/** Split a dealer header into { dealer, firm }. Indian desk names here are
 *  First+Last; the firm is the remainder ("Lkp Securities Ltd."). */
function splitHeader(line) {
  const words = line.trim().split(/\s+/);
  return { dealer: words.slice(0, 2).join(" "), firm: words.slice(2).join(" ") };
}

/**
 * Walk the doc top-to-bottom, carrying the current section (default "Bonds"),
 * the current dealer/firm, and the current day marker.
 * Returns { records, sectionsFound, sectionCounts }.
 * A record is { section, dealer, firm, raw, date } — date is the ISO day the
 * trader stamped above it, or null when that block carries no day marker.
 */
function sectionize(text, runDay) {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const records = [];
  const sectionsFound = new Set();
  const sectionCounts = { Bonds: 0, Gsec: 0, DCM: 0 };

  let section = "Bonds";
  let dealer = null;
  let firm = null;
  let curDate = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, " ").trimEnd();
    const t = line.trim();
    if (!t) continue;

    const marker = markerSection(t);
    if (marker) {
      section = marker;
      sectionsFound.add(marker);
      dealer = null; // a new section resets the header context
      firm = null;
      curDate = null; // ...and its day: each section dates its own blocks
      continue;
    }

    // A bare day-separator line ("25-Aug-2026") dates every quote beneath it,
    // until the next marker or section. It is not itself a quote.
    const dm = dayMarker(rawLine, runDay);
    if (dm) {
      curDate = dm;
      continue;
    }

    if (isDealerHeader(t)) {
      ({ dealer, firm } = splitHeader(t));
      continue;
    }

    records.push({ section, dealer, firm, raw: t, date: curDate });
    sectionCounts[section]++;
  }

  // "Bonds" is the implicit opener, so count it as found once it has any lines.
  if (sectionCounts.Bonds > 0) sectionsFound.add("Bonds");
  return { records, sectionsFound, sectionCounts };
}

/** Does the day carry any quote-like content at all? Guards against a doc that
 *  loaded but is empty / all chatter (reject-bad-keep-old). */
function hasQuoteish(records) {
  return records.some(
    (r) => /\d/.test(r.raw) && /(offer|bid|cr\b|crs\b|@|%|\/|switch|can (buy|sell))/i.test(r.raw)
  );
}

/* ---------------------------------------------------------------------------
   Annotation + chunking.
   ------------------------------------------------------------------------- */

/** One annotated transcript line: "[SECTION | Dealer @ Firm] raw". */
function annotate(r) {
  const who = [r.dealer, r.firm].filter(Boolean).join(" @ ") || "Unknown";
  return `[${r.section} | ${who}] ${r.raw}`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ---------------------------------------------------------------------------
   Time helpers — everything the client sees is Asia/Kolkata (+05:30).
   ------------------------------------------------------------------------- */

function istParts(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(d)
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  return p;
}

function istIso(d = new Date()) {
  const p = istParts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+05:30`;
}

function istDay(d = new Date()) {
  const p = istParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/* ---------------------------------------------------------------------------
   Validation.
   ------------------------------------------------------------------------- */

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Keep a row only if raw is a non-empty string and section + side are valid;
 *  coerce the rest into safe types so the frontend never has to defend itself. */
function cleanRow(q, idx) {
  if (!q || typeof q.raw !== "string" || !q.raw.trim()) return null;
  if (!VALID_SECTIONS.has(q.section)) return null;
  if (!VALID_SIDES.has(q.side)) return null;

  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v) => (isNum(v) ? v : null);

  return {
    id: `q${idx + 1}`, // deterministic, unique across merged chunks
    dealer: str(q.dealer),
    firm: str(q.firm),
    section: q.section,
    issuer: str(q.issuer),
    instrument_type: str(q.instrument_type),
    coupon: num(q.coupon),
    maturity: str(q.maturity),
    tenor_years: num(q.tenor_years),
    side: q.side,
    bid: num(q.bid),
    offer: num(q.offer),
    level: num(q.level),
    level_meaning: [
      "size_cr", "price", "yield", "spread_bps", "price_or_spread", "unknown",
    ].includes(q.level_meaning)
      ? q.level_meaning
      : "unknown",
    size_cr: num(q.size_cr),
    yield: num(q.yield),
    timestamp: str(q.timestamp),
    // The day this quote was said on, from the doc's date headers (attached
    // downstream as `_day`; null for lines before the first header). Drives the
    // board's day selector and per-day tenor.
    quote_date: /^\d{4}-\d{2}-\d{2}$/.test(q._day) ? q._day : null,
    flags: Array.isArray(q.flags) ? q.flags.filter((f) => typeof f === "string") : [],
    raw: q.raw.trim(),
    confidence: num(q.confidence),
  };
}

/* ---------------------------------------------------------------------------
   Main.
   ------------------------------------------------------------------------- */

function keepOld(reason) {
  console.warn(`[frontdesk] ${reason} — keeping existing quotes.json, exiting 0`);
  process.exit(0);
}

async function main() {
  console.log(llmBanner());
  console.log(`[frontdesk] source: ${DOC_URL}`);

  const runDay = istDay();
  console.log(`[frontdesk] run day (IST): ${runDay}`);

  // 1. Fetch (reject-bad-keep-old on any failure).
  let text;
  try {
    text = await fetchDoc();
  } catch (err) {
    keepOld(`doc fetch failed: ${err.message || err}`);
  }
  if (!text || !text.trim()) keepOld("doc came back empty");

  // 1b. Document fingerprint — the cost/runtime bound. The refresh fires every
  //     10 min, but the shared doc only changes when the desk actually pastes. If
  //     the fetched text is byte-for-byte what produced the current quotes.json,
  //     skip the whole LLM pass and keep the existing output — no blind
  //     reprocessing of unchanged history every tick, and no LLM nondeterminism
  //     rewriting an unchanged day. A real change reprocesses in full, so each
  //     output is a clean single-run snapshot (no stale-cache / mixed-model /
  //     partial-day hazards that a per-day cache would introduce).
  const docHash = createHash("sha256").update(text).digest("hex");
  let prevHash = null;
  let prevIncompleteCount = 0;
  try {
    const prevOut = JSON.parse(readFileSync(OUT_PATH, "utf8"));
    prevHash = prevOut?.source_hash ?? null;
    prevIncompleteCount = Array.isArray(prevOut?.incomplete_days) ? prevOut.incomplete_days.length : 0;
  } catch { /* no prior output */ }
  // Fast path only when the doc is byte-identical AND the last output is fully
  // settled. If a day is still flagged incomplete (a chunk failed on an earlier
  // run), we must NOT short-circuit — fall through so the per-day retry can
  // re-structure it, even though the doc hasn't changed. Otherwise a transient
  // LLM failure strands a partial/stale day on the board until the desk's next
  // paste (potentially overnight or over a weekend, given the market-hours cron).
  // Per-day reuse still skips the unchanged, already-settled days, so this retry
  // stays cheap — it only re-sends the incomplete day(s) and the live day.
  if (prevHash === docHash && prevIncompleteCount === 0) {
    if (!DRY_RUN) keepOld("document unchanged since last run — skipping LLM");
    console.log("[frontdesk] document unchanged since last run (dry run: continuing to show parse)");
  } else if (prevHash === docHash && prevIncompleteCount) {
    console.log(`[frontdesk] document unchanged, but ${prevIncompleteCount} day(s) flagged incomplete — reprocessing to retry them`);
  }

  // 2. Section + attribute (day markers detected relative to the run day).
  const { records, sectionsFound, sectionCounts } = sectionize(text, runDay);
  const found = ["Bonds", "Gsec", "DCM"].filter((s) => sectionsFound.has(s));
  const missing = ["Bonds", "Gsec", "DCM"].filter((s) => !sectionsFound.has(s));
  console.log(
    `[frontdesk] sections found: ${found.join(", ") || "none"}` +
      ` (Bonds ${sectionCounts.Bonds}, Gsec ${sectionCounts.Gsec}, DCM ${sectionCounts.DCM} lines)`
  );
  if (missing.length) {
    console.warn(
      `[frontdesk] WARNING: no lines for ${missing.join(", ")} — the txt export may have` +
        ` collapsed Google Docs tabs; parsing the ${found.join(", ")} content that came through.`
    );
  }

  if (!records.length) keepOld("no quote lines after sectioning");
  if (!hasQuoteish(records)) keepOld("no quote-like lines in the doc");

  // 2b. Split the doc into its DATED days. The trader dates each day's block with
  //     a bare header line ("27-Aug-2026"); sectionize() has already stamped every
  //     record with the date of the header above it (null before the first header
  //     in a section, or throughout when the doc carries no headers at all). Group
  //     by that raw date so each day is structured — and tagged — on its own.
  const byDate = new Map(); // key: "YYYY-MM-DD" | null  ->  records[]
  for (const r of records) {
    const k = r.date || null;
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(r);
  }
  const datedDays = [...byDate.keys()].filter(Boolean).sort(); // ascending
  const latestDay = datedDays.at(-1) || null;
  const tradingDay = latestDay || runDay; // fallback: no headers -> the run day

  // Bound the output: keep only the most recent KEEP_DAYS dated days, so the file
  // (and each run's LLM work) can't grow without limit as history piles up.
  const KEEP_DAYS = 5;
  const keptDates = datedDays.slice(-KEEP_DAYS); // newest KEEP_DAYS, ascending
  const droppedDates = datedDays.slice(0, -KEEP_DAYS);
  if (droppedDates.length) {
    console.log(`[frontdesk] bounding to the latest ${KEEP_DAYS} day(s); dropping older: ${droppedDates.join(", ")}`);
  }
  // Process newest kept day first, then any undated (pre-header) lines last —
  // those attach to the live day in the view but keep quote_date null.
  const processKeys = [...keptDates].reverse();
  if (byDate.has(null)) processKeys.push(null);
  console.log(
    `[frontdesk] dated days: ${datedDays.join(", ") || "none"} — trading day ${tradingDay}` +
      (byDate.has(null) ? ` (+ ${byDate.get(null).length} undated line(s))` : "")
  );

  // Annotate each kept day and fingerprint its content, so unchanged days can be
  // reused instead of re-sent to the LLM every run.
  const dayLines = new Map(); // key -> annotated line[]
  const dayHash = new Map();  // dated key -> sha256 of its content
  for (const key of processKeys) {
    const ann = byDate.get(key).map(annotate);
    dayLines.set(key, ann);
    if (key !== null) dayHash.set(key, createHash("sha256").update(ann.join("\n")).digest("hex"));
  }

  // 2c. Per-day reuse. An older dated day whose content is byte-identical to the
  //     last output (and was completely structured then) is reused verbatim — no
  //     LLM. Only the live day, the undated group, and any day whose content
  //     changed / was left incomplete / is new get re-structured. This keeps each
  //     run's LLM work to roughly the live day, so a big doc can't make every
  //     refresh overrun the cron and stall the schedule.
  const prevByDay = new Map(); // quote_date | null -> quotes[]
  let prevDayHashes = {};
  let prevIncomplete = new Set();
  try {
    const prev = JSON.parse(readFileSync(OUT_PATH, "utf8"));
    prevDayHashes = prev.day_hashes || {};
    prevIncomplete = new Set(prev.incomplete_days || []);
    for (const q of prev.quotes || []) {
      const k = q.quote_date || null;
      if (!prevByDay.has(k)) prevByDay.set(k, []);
      prevByDay.get(k).push(q);
    }
  } catch { /* no prior output -> structure everything this run */ }

  const reuse = new Set(); // dated keys reused verbatim from the last output
  for (const key of keptDates) {
    if (key === tradingDay) continue; // the live day is still filling in
    if (prevByDay.has(key) && prevDayHashes[key] === dayHash.get(key) && !prevIncomplete.has(key)) {
      reuse.add(key);
    }
  }
  const processNow = processKeys.filter((k) => !reuse.has(k));

  // 3. Annotate + chunk the days we must (re)structure, never crossing a day
  //    boundary. chunkOutDate is the quote_date to stamp (null for undated lines);
  //    chunkPromptDay is the day the model dates tenor from.
  const chunks = [];
  const chunkOutDate = [];
  const chunkPromptDay = [];
  for (const key of processNow) {
    for (const c of chunk(dayLines.get(key), CHUNK_LINES)) {
      chunks.push(c);
      chunkOutDate.push(key);
      chunkPromptDay.push(key || tradingDay);
    }
  }
  const keptLines = chunks.reduce((n, c) => n + c.length, 0);
  console.log(
    `[frontdesk] structuring ${processNow.filter(Boolean).length} day(s) [${processNow.filter(Boolean).join(", ") || "none"}]` +
      `${reuse.size ? `, reusing ${reuse.size} unchanged [${[...reuse].join(", ")}]` : ""}` +
      ` -> ${keptLines} lines, ${chunks.length} chunk(s)`
  );

  if (DRY_RUN) {
    console.log("\n[frontdesk] DRY RUN — skipping LLM. Sample annotated lines:\n");
    for (const l of chunks.flat().slice(0, 25)) console.log("  " + l);
    console.log(`\n[frontdesk] ...and ${Math.max(0, keptLines - 25)} more.`);
    return;
  }

  // 4. LLM. A full trading day is ~700 rows; streamed strictly one chunk at a
  //    time that is ~15 min — over the 10-minute refresh cron — so chunks run with
  //    bounded parallelism. That is safe against llm.mjs's process-global
  //    negotiation state (resolved provider/shape/model + its max_tokens budget)
  //    because of two properties working together:
  //      (a) a single WARM-UP call (chunk 0) runs ALONE first, so every possible
  //          mutation of that state — shape probing, model selection, any budget
  //          adjustment — happens once, single-threaded, before any parallelism;
  //      (b) chunks are sized (~40 lines -> ~9k output tokens) to stay under even
  //          the default 16k max_tokens (the workflow raises it further), so no
  //          chunk truncates and the budget is never renegotiated mid-run.
  //    After the warm-up the shared state is effectively read-only — the only
  //    writes left are idempotent same-value re-assignments — so the parallel
  //    workers cannot race it. A failed chunk is warned and skipped, not fatal.
  const results = new Array(chunks.length).fill(null);

  const runChunk = async (i) => {
    const user = `TRADING DAY: ${chunkPromptDay[i]} (Asia/Kolkata).\n\nOrganize these chat lines into the schema:\n\n${chunks[i].join("\n")}`;
    try {
      console.log(`[frontdesk] chunk ${i + 1}/${chunks.length} -> LLM (${chunks[i].length} lines)`);
      const out = await llmStructured({
        system: SYSTEM,
        user,
        schemaName: "front_desk_quotes",
        schema: QUOTES_SCHEMA,
      });
      const got = Array.isArray(out?.quotes) ? out.quotes : [];
      console.log(`[frontdesk]   chunk ${i + 1}/${chunks.length}: ${got.length} raw rows`);
      results[i] = got;
    } catch (err) {
      console.warn(`[frontdesk]   chunk ${i + 1}/${chunks.length} failed: ${String(err.message || err).slice(0, 200)}`);
      results[i] = null; // null = FAILED (distinct from a successful, genuinely empty [])
    }
  };

  await runChunk(0); // warm-up: resolve shape/model/budget once, single-threaded
  if (chunks.length > 1) {
    let next = 1;
    const worker = async () => {
      while (next < chunks.length) await runChunk(next++);
    };
    await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length - 1) }, worker));
  }

  // Collect freshly-structured rows per reprocessed day, tracking whether EVERY
  // chunk of that day succeeded (a failed chunk makes the day incomplete).
  const freshByDay = new Map();
  const dayComplete = new Map();
  for (let i = 0; i < chunks.length; i++) {
    const k = chunkOutDate[i];
    if (!dayComplete.has(k)) dayComplete.set(k, true);
    if (results[i] == null) { dayComplete.set(k, false); continue; }
    if (!freshByDay.has(k)) freshByDay.set(k, []);
    for (const q of results[i]) freshByDay.get(k).push({ ...q, _day: k });
  }

  // Assemble every kept day newest-first: reused days come straight from the last
  // output; reprocessed days prefer a COMPLETE fresh result, else keep the last
  // good copy (never overwritten by a partial), else write a partial. Days that
  // are not fully settled are flagged for retry, and their fingerprint is NOT
  // stored, so the next run re-structures them.
  const merged = [];
  const newDayHashes = {};
  const newIncomplete = new Set();
  for (const key of processKeys) {
    if (reuse.has(key)) {
      for (const q of prevByDay.get(key)) merged.push({ ...q, _day: key });
      if (key !== null) newDayHashes[key] = dayHash.get(key); // unchanged -> settled
      continue;
    }
    const hasFresh = freshByDay.has(key);
    const complete = dayComplete.get(key) === true && hasFresh;
    const cacheGood = prevByDay.has(key) && !prevIncomplete.has(key); // a complete prior copy
    if (complete) {
      merged.push(...freshByDay.get(key));
      if (key !== null) newDayHashes[key] = dayHash.get(key); // freshly structured -> settled
    } else if (cacheGood) {
      // reprocess came back incomplete but we have a COMPLETE prior copy — keep it
      // and retry next run (its fingerprint is NOT stored, so reuse won't skip it).
      for (const q of prevByDay.get(key)) merged.push({ ...q, _day: key });
      if (key !== null) newIncomplete.add(key);
    } else if (hasFresh) {
      merged.push(...freshByDay.get(key)); // partial fresh, no good cache to protect
      if (key !== null) newIncomplete.add(key);
    } else if (prevByDay.has(key)) {
      for (const q of prevByDay.get(key)) merged.push({ ...q, _day: key }); // stale/incomplete cache
      if (key !== null) newIncomplete.add(key);
    }
    // else: nothing for this day (failed, uncached) -> absent, retried next run
  }

  // 5. Validate, drop junk, re-id. Rows stay in newest-day-first order.
  const quotes = merged.map((q, i) => cleanRow(q, i)).filter(Boolean).map((q, i) => ({ ...q, id: `q${i + 1}` }));
  console.log(`[frontdesk] ${merged.length} raw rows -> ${quotes.length} valid rows`);

  if (!quotes.length) keepOld("0 valid rows after validation");

  // The days a dealer can pick on the board: every dated day present in the
  // output, newest first, and always the trading day itself (so the fallback
  // no-headers case still offers one option). Undated quotes carry quote_date
  // null and show under the trading day.
  const days_available = [...new Set([tradingDay, ...quotes.map((q) => q.quote_date).filter(Boolean)])]
    .sort()
    .reverse();
  console.log(`[frontdesk] days_available (newest first): ${days_available.join(", ")}`);

  // Per-day bookkeeping for the next run: which days are settled (fingerprint, so
  // they can be reused) and which were only partially structured (retry). Keep
  // markers only for days that actually made it into the output.
  const writtenDays = new Set(quotes.map((q) => q.quote_date).filter(Boolean));
  const day_hashes = Object.fromEntries(Object.entries(newDayHashes).filter(([d]) => writtenDays.has(d)));
  const incomplete_days = [...newIncomplete].filter((d) => writtenDays.has(d)).sort().reverse();
  if (reuse.size || incomplete_days.length) {
    console.log(`[frontdesk] reused ${reuse.size} day(s); incomplete (retry next run): ${incomplete_days.join(", ") || "none"}`);
  }

  // 5b. CCIL government benchmark (traded T-bills + G-Secs) — the desk prices
  //     corporate bonds as a spread over the matching-maturity govt security, so
  //     the frontend needs real govt levels, not an average of the chat's own
  //     Gsec lines. Fetch fresh; on failure keep the previous snapshot so a flaky
  //     CCIL endpoint never blanks the benchmark (reject-bad-keep-old).
  let govt_benchmark = await fetchGovtBenchmark();
  if (!govt_benchmark) {
    try { govt_benchmark = JSON.parse(readFileSync(OUT_PATH, "utf8")).govt_benchmark ?? null; } catch { govt_benchmark = null; }
    if (govt_benchmark) console.log("[frontdesk] CCIL unavailable — keeping previous benchmark snapshot");
  }

  // 6. Write.
  const payload = {
    generated_at: istIso(),
    source: DOC_URL,
    source_hash: docHash, // lets the next run skip the LLM when the doc is unchanged
    trading_day: tradingDay,
    days_available,
    day_hashes, // per-day content fingerprints -> reuse unchanged days next run
    incomplete_days, // days only partially structured -> re-structure next run
    quote_count: quotes.length,
    model: activeModel(),
    govt_benchmark, // CCIL T-bill + G-Sec snapshot for matching-maturity spreads
    quotes,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(`[frontdesk] wrote ${OUT_PATH} — ${quotes.length} quotes, model ${activeModel()}`);
}

main().catch((err) => {
  // A crash must not blank the board either: leave quotes.json as-is, exit 0 so
  // the workflow's commit step simply finds nothing changed.
  console.error(`[frontdesk] ERROR: ${err.stack || err.message || err}`);
  console.warn("[frontdesk] keeping existing quotes.json, exiting 0");
  process.exit(0);
});
