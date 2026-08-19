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
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { llmStructured, activeModel, llmBanner } from "./llm.mjs";

/* ---------------------------------------------------------------------------
   Configuration.
   ------------------------------------------------------------------------- */

const DOC_URL =
  "https://docs.google.com/document/d/11e0cnpJhjqCZJj3LMOF88oYZUGTwYCpZtKX6zVErU_4/export?format=txt";

/** Output file, resolved relative to this script so cwd never matters. */
const OUT_PATH = fileURLToPath(new URL("../public/data/quotes.json", import.meta.url));

/** Quote lines per LLM call. Each input line expands into a verbose 20-field
 *  JSON object (every field required, nulls included), so the OUTPUT is what
 *  bounds the chunk, not the input: 300-line chunks overflowed even a 65k
 *  max_tokens ceiling and truncated in production. ~60 lines keeps each reply
 *  near ~12k output tokens — comfortably inside the default budget, no
 *  truncation, fast. The day's arrays are merged back together. */
const CHUNK_LINES = 60;

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

Emit ONE row per genuine quote / order / desk-action line. SKIP pure noise and do not emit a row for
it: counterparty or mutual-fund tags on their own line (e.g. "axis mf", "nippon mf", "isec", "bob mf",
"ECL fin", "birla pen", "emf"), general chatter (e.g. "zoom bandh raka hain kya"), and chat read
markers ("Today", "Unread messages"). When in doubt whether a line is a real quote, skip it.

FIELD RULES:
- side: "bid" or "buy" when the dealer wants to BUY; "offer", "sell" or "ask" when they want to SELL;
  "two_way" when BOTH a bid and an offer are quoted; "comment" for a desk action with no clear side
  (a switch idea, "done", a request like "px pls" / "offers pls").
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
 * Walk the doc top-to-bottom, carrying the current section (default "Bonds")
 * and the current dealer/firm. Returns { records, sectionsFound, sectionCounts }.
 * A record is { section, dealer, firm, raw }.
 */
function sectionize(text) {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const records = [];
  const sectionsFound = new Set();
  const sectionCounts = { Bonds: 0, Gsec: 0, DCM: 0 };

  let section = "Bonds";
  let dealer = null;
  let firm = null;

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
      continue;
    }

    if (isDealerHeader(t)) {
      ({ dealer, firm } = splitHeader(t));
      continue;
    }

    records.push({ section, dealer, firm, raw: t });
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

  const tradingDay = istDay();
  console.log(`[frontdesk] trading day (IST): ${tradingDay}`);

  // 1. Fetch (reject-bad-keep-old on any failure).
  let text;
  try {
    text = await fetchDoc();
  } catch (err) {
    keepOld(`doc fetch failed: ${err.message || err}`);
  }
  if (!text || !text.trim()) keepOld("doc came back empty");

  // 2. Section + attribute.
  const { records, sectionsFound, sectionCounts } = sectionize(text);
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

  // 3. Annotate + chunk.
  const annotated = records.map(annotate);
  const chunks = chunk(annotated, CHUNK_LINES);
  console.log(`[frontdesk] ${records.length} quote lines -> ${chunks.length} LLM chunk(s)`);

  if (DRY_RUN) {
    console.log("\n[frontdesk] DRY RUN — skipping LLM. Sample annotated lines:\n");
    for (const l of annotated.slice(0, 25)) console.log("  " + l);
    console.log(`\n[frontdesk] ...and ${Math.max(0, annotated.length - 25)} more.`);
    return;
  }

  // 4. LLM: one structured call per chunk, IN SEQUENCE, merging the arrays.
  //    Sequential on purpose: llm.mjs carries a process-global token budget
  //    (its max_tokens auto-growth) and a resolved-provider/shape/model that are
  //    not concurrency-safe — parallel calls could race the budget and make a
  //    chunk throw, and a thrown chunk is dropped. Small (~60-line) chunks keep
  //    each reply well inside the budget, so ~16 sequential calls still finish in
  //    a few minutes, comfortably under the 10-minute refresh cron. A failed
  //    chunk is warned and skipped (its ~60 rows lost) rather than sinking the run.
  const merged = [];
  for (let i = 0; i < chunks.length; i++) {
    const user = `TRADING DAY: ${tradingDay} (Asia/Kolkata).\n\nOrganize these chat lines into the schema:\n\n${chunks[i].join("\n")}`;
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
      merged.push(...got);
    } catch (err) {
      console.warn(`[frontdesk]   chunk ${i + 1}/${chunks.length} failed: ${String(err.message || err).slice(0, 200)}`);
    }
  }

  // 5. Validate, drop junk, re-id.
  const quotes = merged.map((q, i) => cleanRow(q, i)).filter(Boolean).map((q, i) => ({ ...q, id: `q${i + 1}` }));
  console.log(`[frontdesk] ${merged.length} raw rows -> ${quotes.length} valid rows`);

  if (!quotes.length) keepOld("0 valid rows after validation");

  // 6. Write.
  const payload = {
    generated_at: istIso(),
    source: DOC_URL,
    trading_day: tradingDay,
    quote_count: quotes.length,
    model: activeModel(),
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
