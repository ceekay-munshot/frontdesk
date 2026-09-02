/**
 * ccil.mjs — the government benchmark feed.
 * =========================================
 * The desk prices corporate bonds as a SPREAD over the matching-maturity
 * government security (a Treasury Bill for <=1y paper, a G-Sec beyond) — never
 * over an average of the whole curve. The authoritative source for those levels
 * is CCIL (ccilindia.com), whose home dashboard exposes the most-liquid traded
 * G-Secs and T-bills as JSON via a Liferay portlet resource endpoint.
 *
 *   fetchGovtBenchmark() -> { as_of, points: [{ type, name, maturity, yield }] }
 *                           or null on any failure (caller keeps the last good
 *                           snapshot — reject-bad-keep-old, like the parser).
 *
 * Each point is a real traded government security:
 *   { type:"tbill"|"gsec", name:"06.94 GS 2036", maturity:"2036-07-01", yield:6.9754 }
 *
 * Server-side only (the GitHub Action / parser). A browser cannot fetch CCIL
 * directly — it sends no CORS headers — so the parser embeds this snapshot in
 * quotes.json and the static frontend reads it from there.
 *
 * Node 22 (global fetch). No dependencies.
 */

/** Home dashboard "G-Sec table" portlet — most-liquid traded G-Secs AND T-bills.
 *  The X-Requested-With header is REQUIRED; without it the portlet replies
 *  "Data not found". */
const CCIL_GSEC_URL =
  "https://www.ccilindia.com/home?p_p_id=CCIL_HomeCombineGraphTable_CCIL_HomeCombineGraphTablePortlet_INSTANCE_uzwa" +
  "&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&p_p_resource_id=gsecTable";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse a CCIL instrument name into { type, maturity(ISO), name }.
 *   "091 DTB 03122026"  -> tbill, 2026-12-03  (ddmmyyyy tail)
 *   "06.94 GS 2036"      -> gsec,  2036-07-01  (year only -> mid-year approx)
 *   Returns null for anything we can't place (SDLs, specials, …). */
export function parseCcilName(rawName) {
  const nm = String(rawName || "").replace(/\s+/g, " ").trim();
  const isBill = /\b(?:DTB|TB|CMB)\b/.test(nm);
  const dm = nm.match(/(\d{2})(\d{2})(\d{4})\s*$/); // ddmmyyyy at the end
  if (isBill && dm) {
    const [, dd, mm, yyyy] = dm;
    if (+mm >= 1 && +mm <= 12 && +dd >= 1 && +dd <= 31) return { type: "tbill", maturity: `${yyyy}-${mm}-${dd}`, name: nm };
  }
  const gy = nm.match(/\bGS\s+(\d{4})/) || (/\bGS\b/.test(nm) && nm.match(/(\d{4})\s*$/));
  if (gy) return { type: "gsec", maturity: `${gy[1]}-07-01`, name: nm }; // year only -> mid-year
  return null;
}

async function fetchOnce() {
  const res = await fetch(CCIL_GSEC_URL, {
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://www.ccilindia.com/",
      Accept: "application/json, text/plain, */*",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`CCIL ${res.status}`);
  const text = await res.text();
  if (!text || /data not found/i.test(text)) throw new Error("CCIL: data not found");
  return JSON.parse(text);
}

/**
 * Fetch and normalise the CCIL government benchmark. Retries the flaky endpoint
 * a few times; returns null (not throw) so the parser can keep the last good
 * snapshot rather than blanking the benchmark.
 */
export async function fetchGovtBenchmark() {
  let data = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      data = await fetchOnce();
      break;
    } catch (err) {
      if (attempt === 3) {
        console.warn(`[ccil] benchmark fetch failed: ${String(err.message || err).slice(0, 160)}`);
        return null;
      }
      await sleep(1200 * 2 ** attempt);
    }
  }
  const rows = Array.isArray(data?.result1) ? data.result1 : [];
  const points = [];
  for (const r of rows) {
    const y = r?.gltr_trad_scnd_rate;
    if (typeof y !== "number" || !Number.isFinite(y) || y <= 0 || y > 15) continue; // real govt yields only
    const p = parseCcilName(r?.gltr_ismt_idnt);
    if (!p) continue;
    points.push({ type: p.type, name: p.name, maturity: p.maturity, yield: Math.round(y * 10000) / 10000 });
  }
  if (points.length < 2) {
    console.warn(`[ccil] only ${points.length} usable benchmark point(s) — treating as unavailable`);
    return null;
  }
  const as_of = typeof data?.maxTradeTimestamp === "string" ? data.maxTradeTimestamp : null;
  console.log(`[ccil] benchmark: ${points.length} points (${points.filter((p) => p.type === "tbill").length} T-bill, ${points.filter((p) => p.type === "gsec").length} G-Sec) as of ${as_of}`);
  return { as_of, points };
}
