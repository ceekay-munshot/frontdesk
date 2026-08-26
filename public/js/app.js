/**
 * The Front Desk — app.js
 * =======================
 * Pure static ES module. Reads public/data/quotes.json (committed by the data
 * engine's GitHub Action) and renders the Live Board: a colorful, perfectly
 * aligned table of the day's bond dealing-desk quotes.
 *
 * No framework, no bundler. Tailwind (CDN) for styling, Lucide (global) for
 * icons — lucide.createIcons() is called after every render. The board polls
 * quotes.json so an open page picks up new data without a manual reload.
 */

/* =========================================================================
   Config
   ========================================================================= */

const DATA_URL = "data/quotes.json";
const POLL_MS = 45000; // re-check the committed file every 45s

/* Design tokens — read once from the CSS custom properties on :root (defined
   in index.html), so the inline-SVG charts draw from the SAME palette as the
   CSS. One source of truth; no scattered hex in the JS. Fallbacks keep the
   charts colored even if getComputedStyle is unavailable. */
const _root = getComputedStyle(document.documentElement);
const cv = (name, fallback) => _root.getPropertyValue(name).trim() || fallback;
const T = {
  grad1: cv("--grad-1", "#6366f1"), grad2: cv("--grad-2", "#8b5cf6"), grad3: cv("--grad-3", "#ec4899"),
  buy: cv("--c-buy", "#10b981"), buyInk: cv("--c-buy-ink", "#047857"),
  sell: cv("--c-sell", "#f43f5e"), sellInk: cv("--c-sell-ink", "#be123c"),
  act: cv("--c-act", "#f59e0b"), actInk: cv("--c-act-ink", "#b45309"),
  info: cv("--c-info", "#3b82f6"), infoInk: cv("--c-info-ink", "#1d4ed8"),
  pickup: cv("--c-pickup", "#14b8a6"), pickupInk: cv("--c-pickup-ink", "#0f766e"),
  brandInk: cv("--brand-ink", "#4338ca"),
  bonds: cv("--c-bonds", "#6366f1"), gsec: cv("--c-gsec", "#10b981"), dcm: cv("--c-dcm", "#f59e0b"),
  heatCool: cv("--heat-cool", "#3b82f6"), heatMid: cv("--heat-mid", "#eef2f6"), heatWarm: cv("--heat-warm", "#10b981"),
  tintIndigo: cv("--tint-indigo", "#a5b4fc"), tintEmerald: cv("--tint-emerald", "#6ee7b7"), tintAmber: cv("--tint-amber", "#fcd34d"),
  tintBlue: cv("--tint-blue", "#93c5fd"), tintTeal: cv("--tint-teal", "#5eead4"), tintRose: cv("--tint-rose", "#fda4af"),
  ink: cv("--n-900", "#0f172a"), n700: cv("--n-700", "#334155"), n600: cv("--n-600", "#475569"),
  n500: cv("--n-500", "#64748b"), n400: cv("--n-400", "#94a3b8"), n300: cv("--n-300", "#cbd5e1"), n200: cv("--n-200", "#e2e8f0"),
};

const TABS = [
  { id: "live", label: "Live Board", icon: "layout-list" },
  { id: "spread", label: "Spread Watch", icon: "git-compare-arrows" },
  { id: "opps", label: "Opportunities", icon: "sparkles" },
  { id: "pulse", label: "Desk Pulse", icon: "activity" },
];

/* Tenor buckets used across Spread Watch. */
const TENOR_BUCKETS = ["<=1y", "1-3y", "3-5y", "5-10y", "10y+"];
function tenorBucket(t) {
  if (!isNum(t)) return null;
  return t <= 1 ? "<=1y" : t <= 3 ? "1-3y" : t <= 5 ? "3-5y" : t <= 10 ? "5-10y" : "10y+";
}

/* Spread Watch diverging colors. Heatmap: blue (tight) -> gray (typical) ->
   emerald (wide/attractive), with the bps number shown in every cell as the
   primary read. Peer bars: emerald (cheap) / rose (rich), position primary. */
const SPREAD_COOL = T.heatCool; // tight  (little pickup)
const SPREAD_MID = T.heatMid;   // typical (median)
const SPREAD_WARM = T.heatWarm; // wide   (more pickup, attractive)
const CHEAP = T.buy;
const RICH = T.sell;

const SECTION = {
  Bonds: { label: "Bonds", dot: T.bonds, acc: "acc-bonds", chip: "bg-indigo-50 text-indigo-700 border border-indigo-200" },
  Gsec: { label: "Gsec", dot: T.gsec, acc: "acc-gsec", chip: "bg-emerald-50 text-emerald-700 border border-emerald-200" },
  DCM: { label: "DCM", dot: T.dcm, acc: "acc-dcm", chip: "bg-amber-50 text-amber-700 border border-amber-200" },
};

/** Section accent colour from the tokens (used for tooltip caps etc.). */
function sectionColor(sec) { return (SECTION[sec] || SECTION.Bonds).dot; }

const FLAG_LABEL = {
  bid_pls: "bid pls",
  offer_pls: "offer pls",
  cbc: "cbc",
  can_buy_more: "can buy+",
  can_sell: "can sell",
  done: "done",
  switch: "switch",
};

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* =========================================================================
   State
   ========================================================================= */

const state = {
  tab: "live",
  loading: true,
  error: null,
  data: null,
  section: "All",
  search: "",
  narrowOnly: false,
  grouped: false,
  showChatter: false, // Live Board hides "comment"/NOTE chatter by default
  sortKey: "time", // "time" | "maturity"
  sortDir: "desc", // "asc" | "desc"
  lastGeneratedAt: null,
  // Spread Watch
  spreadView: "govt", // "govt" | "peers"
  spreadSection: "All", // "All" | "Bonds" | "DCM"
  spreadTenor: "All", // "All" | one of TENOR_BUCKETS
  // Opportunities
  oppCat: "all", // "all" | "cheap" | "tight" | "pickup" | "twosided" | "rich"
  oppSection: "All", // "All" | "Bonds" | "Gsec" | "DCM"
  oppTenor: "All", // "All" | one of TENOR_BUCKETS
};

const els = {
  view: document.getElementById("view"),
  tabs: document.getElementById("tabs"),
  search: document.getElementById("search"),
  pill: document.getElementById("livePill"),
  pillText: document.getElementById("livePillText"),
  tooltip: document.getElementById("tooltip"),
};

/* =========================================================================
   Small helpers
   ========================================================================= */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

function fmtNum(n, dp) {
  if (!isNum(n)) return "—";
  if (dp != null) return n.toFixed(dp);
  return String(Math.round(n * 10000) / 10000);
}

/** Shared money/percent formatters so ₹cr and % read identically everywhere. */
const fmtCr = (v) => (isNum(v) ? "₹" + fmtNum(v) + " cr" : "—");
const fmtPct = (y, dp = 2) => (isNum(y) ? y.toFixed(dp) + "%" : "—");

function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
}

function fmtDate(s) {
  const p = parseISODate(s);
  return p ? `${String(p.d).padStart(2, "0")} ${MON[p.mo - 1]} '${String(p.y).slice(2)}` : "—";
}

/** HH:MM from a "HH:MM:SS" chat timestamp. */
function fmtTime(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(s || "");
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "—";
}

/** "HH:MM:SS" -> seconds since midnight (−1 when absent), for recency ranking. */
function tsSeconds(s) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s || "");
  return m ? +m[1] * 3600 + +m[2] * 60 + +(m[3] || 0) : -1;
}

/** HH:MM from an ISO generated_at that already carries +05:30. */
function fmtGenerated(iso) {
  const m = /T(\d{2}:\d{2})/.exec(iso || "");
  return m ? m[1] : null;
}

/** "25 Aug 2026" from an ISO "YYYY-MM-DD" trading day (null if unparseable). */
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return null;
  const mo = +m[2];
  if (mo < 1 || mo > 12) return null;
  return `${+m[3]} ${MONTHS_SHORT[mo - 1]} ${m[1]}`;
}

/** Newest day present across quotes (ISO YYYY-MM-DD), or null when none carry a date. */
function latestQuoteDay(quotes) {
  let m = null;
  for (const q of quotes || []) if (q.date && (m === null || q.date > m)) m = q.date;
  return m;
}

/** Distinct days present across quotes, newest first. */
function daysPresent(quotes) {
  return [...new Set((quotes || []).map((q) => q.date).filter(Boolean))].sort().reverse();
}

/** Quotes from the latest (live) day only. Older days feed the board's history
 *  but NOT the analysis tabs — a stale price there would invent a "deal" that is
 *  already gone. The live day is the authoritative `trading_day`, NOT merely the
 *  newest surviving quote: if the latest day's rows all failed to generate, we
 *  return an empty set (analysis shows "no data today") rather than silently
 *  treating an older day as current. Falls back to all quotes for legacy data
 *  that carries no per-quote date at all. */
function liveDayQuotes(quotes) {
  const all = quotes || [];
  if (!all.some((q) => q.date)) return all; // legacy data: no per-quote dates
  const td = state.data?.trading_day;
  if (td && /^\d{4}-\d{2}-\d{2}$/.test(td)) return all.filter((q) => q.date === td);
  const d = latestQuoteDay(all); // no valid trading_day: fall back to newest present
  return d ? all.filter((q) => q.date === d) : all;
}

/* =========================================================================
   Quote semantics
   ========================================================================= */

function sideStyle(side) {
  switch (side) {
    case "bid":
    case "buy":
      return { label: side === "buy" ? "BUY" : "BID", chip: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20" };
    case "offer":
    case "sell":
    case "ask":
      return { label: side.toUpperCase(), chip: "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-600/20" };
    case "two_way":
      return { label: "2-WAY", chip: "bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-600/20" };
    default:
      return { label: "NOTE", chip: "bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-500/20" };
  }
}

/** The number a one-sided quote is really "at". */
function repLevel(q) {
  return isNum(q.yield) ? q.yield : isNum(q.level) ? q.level : isNum(q.bid) ? q.bid : isNum(q.offer) ? q.offer : null;
}

/** A tight bid-offer? Measured on the ABSOLUTE gap so it is orientation-agnostic:
 *  the data carries yield two-ways in both conventions (bid<offer AND bid>offer),
 *  and tightness is the width of the market, not the sign. Yields close in
 *  absolute terms (<=0.06 = 6bps), prices wider (<=5). */
function narrowGap(bid, offer, meaning) {
  if (!isNum(bid) || !isNum(offer)) return false;
  const gap = Math.abs(offer - bid);
  if (gap <= 0) return false;
  return meaning === "yield" ? gap <= 0.06 : gap <= 5;
}

const isNarrowRow = (q) => q.side === "two_way" && narrowGap(q.bid, q.offer, q.level_meaning);

/** The Level/Yield cell: a main number + a tiny unit tag. */
function levelCell(q) {
  if (q.side === "two_way" && isNum(q.bid) && isNum(q.offer)) {
    const yld = q.level_meaning === "yield";
    return { main: `${fmtNum(q.bid, yld ? 2 : null)} / ${fmtNum(q.offer, yld ? 2 : null)}`, unit: yld ? "yld" : "px" };
  }
  if (isNum(q.yield)) return { main: fmtNum(q.yield, 2), unit: "yld" };
  if (isNum(q.level)) {
    const u = q.level_meaning === "price" ? "px" : q.level_meaning === "spread_bps" ? "bps" : q.level_meaning === "size_cr" ? "cr" : "lvl";
    return { main: fmtNum(q.level), unit: u };
  }
  if (isNum(q.bid)) return { main: fmtNum(q.bid), unit: "bid" };
  if (isNum(q.offer)) return { main: fmtNum(q.offer), unit: "ofr" };
  return { main: "—", unit: "" };
}

/* =========================================================================
   Filter / sort / group
   ========================================================================= */

function filterSectionSearch(quotes) {
  let rows = quotes;
  if (state.section !== "All") rows = rows.filter((q) => q.section === state.section);
  const term = state.search.trim().toLowerCase();
  if (term) {
    rows = rows.filter(
      (q) =>
        (q.issuer || "").toLowerCase().includes(term) ||
        (q.dealer || "").toLowerCase().includes(term) ||
        (q.firm || "").toLowerCase().includes(term)
    );
  }
  return rows;
}

function sortRows(rows) {
  const dir = state.sortDir === "asc" ? 1 : -1;
  const key = state.sortKey;
  const val = (q) => (key === "maturity" ? q.maturity || "" : q.timestamp || "");
  return rows.slice().sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    // Missing values always sort to the bottom regardless of direction.
    if (!av && !bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
  });
}

function groupBonds(rows) {
  const map = new Map();
  for (const q of rows) {
    // A row without an issuer isn't an identifiable bond — keep each on its own
    // (keyed by id) so unrelated instruments never collapse into one "—" group.
    const key = q.issuer ? `${q.issuer.toLowerCase()}||${q.maturity || ""}` : `__${q.id}`;
    if (!map.has(key)) {
      map.set(key, { issuer: q.issuer, maturity: q.maturity, tenor: q.tenor_years, section: q.section, coupon: q.coupon, instrument: q.instrument_type, items: [] });
    }
    map.get(key).items.push(q);
  }
  const groups = [];
  for (const g of map.values()) {
    // Decide the group's unit first, then pool bid/offer ONLY from quotes that
    // share it — so a price (80) never mixes with a yield (6.9) into a
    // nonsensical best-bid / best-offer / spread.
    const anyYield = g.items.some((q) => q.level_meaning === "yield");
    const meaning = anyYield ? "yield" : "price_or_spread";
    const sameUnit = (q) => (q.level_meaning === "yield") === anyYield;
    const bids = [];
    const offers = [];
    for (const q of g.items) {
      if (!sameUnit(q)) continue;
      if (q.side === "two_way") {
        if (isNum(q.bid)) bids.push(q.bid);
        if (isNum(q.offer)) offers.push(q.offer);
      } else if (["bid", "buy"].includes(q.side)) {
        const v = repLevel(q);
        if (v != null) bids.push(v);
      } else if (["offer", "sell", "ask"].includes(q.side)) {
        const v = repLevel(q);
        if (v != null) offers.push(v);
      }
    }
    const bestBid = bids.length ? Math.max(...bids) : null;
    const bestOffer = offers.length ? Math.min(...offers) : null;
    // The bid-offer WIDTH (magnitude): yield two-ways arrive in mixed orientation,
    // so a signed offer-bid would flip sign meaninglessly across rows.
    const spread = bestBid != null && bestOffer != null ? Math.round(Math.abs(bestOffer - bestBid) * 100) / 100 : null;
    groups.push({ ...g, bestBid, bestOffer, spread, meaning, count: g.items.length });
  }
  return groups;
}

function sortGroups(groups) {
  const order = { Bonds: 0, Gsec: 1, DCM: 2 };
  const ord = (s) => (order[s] ?? 99); // unknown sections sort last, never NaN
  const dir = state.sortDir === "asc" ? 1 : -1;
  return groups.slice().sort((a, b) => {
    if (ord(a.section) !== ord(b.section)) return ord(a.section) - ord(b.section);
    if (state.sortKey === "maturity") {
      const av = a.maturity || "";
      const bv = b.maturity || "";
      if (av !== bv) return !av ? 1 : !bv ? -1 : av < bv ? -1 * dir : dir;
    }
    return (a.issuer || "").localeCompare(b.issuer || "");
  });
}

/* =========================================================================
   Rendering — board chrome
   ========================================================================= */

function segButton(value, label) {
  const active = state.section === value;
  return `<button data-section="${value}" role="tab" aria-selected="${active}"
      class="rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
        active ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-700"
      }">${esc(label)}</button>`;
}

function toggleButton({ on, id, icon, label, tone }) {
  const ring = tone === "amber" ? "ring-amber-300 bg-amber-50 text-amber-700" : "ring-indigo-300 bg-indigo-50 text-indigo-700";
  return `<button data-toggle="${id}" aria-pressed="${on}"
      class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold ring-1 transition ${
        on ? ring : "text-slate-500 ring-slate-200 hover:bg-slate-50 hover:text-slate-700"
      }">
      <i data-lucide="${icon}" class="h-3.5 w-3.5"></i>${esc(label)}</button>`;
}

function controlsHTML() {
  return `
  <div class="mb-3 flex flex-wrap items-center gap-2">
    <!-- Section dropdown, styled as a segmented control -->
    <div class="inline-flex items-center rounded-xl bg-slate-100/80 p-1" role="tablist" aria-label="Section">
      ${["All", "Bonds", "Gsec", "DCM"].map((s) => segButton(s, s)).join("")}
    </div>

    <div class="mx-1 hidden h-5 w-px bg-slate-200 sm:block"></div>

    ${toggleButton({ on: state.grouped, id: "grouped", icon: "layers", label: "Group by bond" })}
    ${toggleButton({ on: state.narrowOnly, id: "narrow", icon: "diff", label: "Narrow only", tone: "amber" })}
    ${state.grouped ? "" : toggleButton({ on: state.showChatter, id: "chatter", icon: "messages-square", label: "Show desk chatter" })}

    <div class="ml-auto flex items-center gap-2 text-xs text-slate-400">
      <span>Sort</span>
      ${sortChip("time", "Time")}
      ${sortChip("maturity", "Maturity")}
    </div>
  </div>`;
}

function sortChip(key, label) {
  const active = state.sortKey === key;
  const arrow = active ? (state.sortDir === "asc" ? "arrow-up" : "arrow-down") : "arrows-up-down";
  return `<button data-sort="${key}"
      class="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-semibold transition ${
        active ? "bg-slate-900 text-white" : "text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50"
      }">
      ${esc(label)}<i data-lucide="${arrow}" class="h-3 w-3"></i></button>`;
}

function legendHTML() {
  const dot = (c, t) => `<span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-full" style="background:${c}"></span>${t}</span>`;
  return `<div class="hidden items-center gap-3 text-[11px] font-medium text-slate-400 md:flex">
      ${dot(T.buy, "Bid")}${dot(T.sell, "Offer")}${dot(T.grad2, "2-way")}
      <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-sm bg-amber-400"></span>Narrow</span>
    </div>`;
}

function sectionSummary() {
  if (!state.data) return "";
  const c = { Bonds: 0, Gsec: 0, DCM: 0 };
  // Count tradeable quotes only — desk chatter (side "comment") isn't a quote.
  for (const q of state.data.quotes) if (q.side !== "comment" && c[q.section] != null) c[q.section]++;
  return `${c.Bonds} Bonds · ${c.Gsec} Gsec · ${c.DCM} DCM`;
}

/** The board: controls + a fixed-height card whose body scrolls internally + a slim provenance footer. */
function boardChrome(bodyHTML, count, totalQuotes, chatterShown = 0) {
  const total = totalQuotes == null ? (state.data ? state.data.quotes.length : 0) : totalQuotes;
  const chatterTag = chatterShown ? ` · <span class="text-slate-400">${chatterShown} chatter</span>` : "";
  const showing = count == null ? "" : `<span class="font-semibold text-slate-600">${count}</span> of ${total} quotes${chatterTag}`;
  const gen = state.data ? fmtGenerated(state.data.generated_at) : null;
  const days = state.data ? daysPresent(state.data.quotes) : [];
  const latestLabel = fmtDay(state.data?.trading_day) || state.data?.trading_day || "—";
  const dayChip = days.length >= 2 ? `Showing ${days.length} days · latest ${latestLabel}` : `Trading day: ${latestLabel}`;
  return `
    ${controlsHTML()}
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/90 shadow-sm shadow-slate-200/50 backdrop-blur">
      <!-- card header -->
      <div class="flex shrink-0 items-center gap-3 border-b border-slate-100 px-4 py-2.5">
        <div class="flex items-center gap-2">
          <i data-lucide="radio-tower" class="h-4 w-4 text-indigo-500"></i>
          <h2 class="font-display text-sm font-bold text-slate-800">Live Board</h2>
        </div>
        <span class="hidden text-xs text-slate-400 sm:inline">${esc(sectionSummary())}</span>
        ${legendHTML()}
        <div class="ml-auto text-xs text-slate-400">${showing}</div>
      </div>
      <!-- card body: the ONLY scrolling region -->
      <div class="scroll-y min-h-0 flex-1 overflow-auto">
        ${bodyHTML}
      </div>
    </div>
    <div class="mt-2 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-slate-400">
      <span class="inline-flex items-center gap-1"><i data-lucide="file-text" class="h-3 w-3"></i>Source: shared Google Doc</span>
      <span class="inline-flex items-center gap-1"><i data-lucide="cpu" class="h-3 w-3"></i>Model: ${esc(state.data?.model || "—")}</span>
      <span class="inline-flex items-center gap-1"><i data-lucide="calendar" class="h-3 w-3"></i>${esc(dayChip)}</span>
      <span class="inline-flex items-center gap-1"><i data-lucide="refresh-cw" class="h-3 w-3"></i>Auto-refreshes every 10 min${gen ? ` · last ${gen}` : ""}</span>
    </div>`;
}

/* =========================================================================
   Rendering — table (flat) and grouped
   ========================================================================= */

const COLGROUP = `
  <colgroup>
    <col style="width:auto" />
    <col style="width:118px" />
    <col style="width:86px" />
    <col style="width:126px" />
    <col style="width:104px" />
    <col style="width:150px" />
    <col style="width:74px" />
  </colgroup>`;

function th(label, align, extra = "") {
  return `<th class="whitespace-nowrap px-3 py-2.5 text-${align} text-[11px] font-semibold uppercase tracking-wide text-slate-400 ${extra}">${label}</th>`;
}

function tableHTML(rows) {
  const head = `
    <thead class="sticky-head">
      <tr class="border-b border-slate-200 bg-slate-50/95 backdrop-blur">
        ${th("Issuer", "left")}
        ${th("Maturity", "left")}
        ${th("Side", "center")}
        ${th("Level / Yield", "right")}
        ${th("Size (₹cr)", "right")}
        ${th("Dealer", "left")}
        ${th("Time", "right")}
      </tr>
    </thead>`;

  // When the board holds more than one day, split it into date sections, newest
  // day first, each under a labelled divider (the latest day flagged "Live" — it
  // is the day the analysis tabs read). One day (or date-less data) renders flat.
  const dates = daysPresent(rows);
  let body;
  if (dates.length >= 2) {
    const parts = [];
    for (const d of dates) {
      const dayRows = rows.filter((r) => r.date === d);
      const n = dayRows.reduce((a, r) => a + (r.side !== "comment" ? 1 : 0), 0);
      // "Live" marks the authoritative trading day (the day the analysis tabs
      // read), not merely the newest day left after section/search filters.
      parts.push(dayHeaderRow(d, n, d === state.data?.trading_day));
      parts.push(dayRows.map(rowHTML).join(""));
    }
    const undated = rows.filter((r) => !r.date);
    if (undated.length) {
      parts.push(dayHeaderRow(null, undated.reduce((a, r) => a + (r.side !== "comment" ? 1 : 0), 0), false));
      parts.push(undated.map(rowHTML).join(""));
    }
    body = parts.join("");
  } else {
    body = rows.map(rowHTML).join("");
  }
  return `<table class="w-full min-w-[880px] border-collapse text-sm">${COLGROUP}${head}<tbody>${body}</tbody></table>`;
}

/** A full-width date divider inside the board body, separating one day's quotes
 *  from the next. The newest day carries a "Live" tag — that is the day the
 *  Spread / Opportunities / Pulse tabs analyse. */
function dayHeaderRow(iso, quoteCount, isLive) {
  const label = fmtDay(iso) || iso || "Undated";
  const live = isLive
    ? `<span class="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-700">Live</span>`
    : "";
  return `<tr class="day-sep"><td colspan="7" class="border-y border-slate-200 bg-slate-100/80 px-3 py-1.5">
      <span class="text-[11px] font-bold uppercase tracking-wide text-slate-500">${esc(label)}</span>
      <span class="ml-1.5 text-[11px] text-slate-400">· ${quoteCount} ${quoteCount === 1 ? "quote" : "quotes"}</span>${live}
    </td></tr>`;
}

function rowHTML(q) {
  const sec = SECTION[q.section] || SECTION.Bonds;
  const s = sideStyle(q.side);
  const lvl = levelCell(q);
  const mat = fmtDate(q.maturity);
  const tenor = isNum(q.tenor_years) ? `${q.tenor_years}y` : "";
  const narrow = isNarrowRow(q);

  const coupon = isNum(q.coupon) ? `${fmtNum(q.coupon, 2)}%` : "";
  const instr = q.instrument_type ? esc(q.instrument_type) : "";
  const sub = [coupon, instr].filter(Boolean).join(" · ");

  const secTag =
    state.section === "All"
      ? `<span class="ml-1.5 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${sec.chip}">${sec.label}</span>`
      : "";

  const flags = Array.isArray(q.flags) && q.flags.length
    ? `<span class="ml-0.5 inline-flex flex-wrap gap-1 align-middle">${q.flags
        .map((f) => `<span class="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">${esc(FLAG_LABEL[f] || f)}</span>`)
        .join("")}</span>`
    : "";

  const rowTip = JSON.stringify({ kind: "row", raw: q.raw, dealer: q.dealer || "", firm: q.firm || "", time: q.timestamp || "", accent: sectionColor(q.section) });
  return `
    <tr class="qrow ${narrow ? "narrow-glow" : sec.acc} border-b border-slate-100 cursor-default"
        data-tip="${esc(rowTip)}">
      <td class="px-3 py-2.5">
        <div class="flex items-center font-semibold text-slate-800">
          <span class="truncate">${esc(q.issuer || "—")}</span>${secTag}
        </div>
        <div class="mt-0.5 flex items-center text-[11px] text-slate-400">
          <span>${sub || "&nbsp;"}</span>${flags}
        </div>
      </td>
      <td class="px-3 py-2.5">
        <div class="nums font-medium text-slate-700">${mat}</div>
        <div class="nums text-[11px] text-slate-400">${tenor}</div>
      </td>
      <td class="px-3 py-2.5 text-center">
        <span class="inline-flex min-w-[52px] justify-center rounded-md px-2 py-1 text-[11px] font-bold ${s.chip}">${s.label}</span>
      </td>
      <td class="px-3 py-2.5 text-right">
        <div class="nums font-semibold text-slate-900">${esc(lvl.main)}</div>
        ${lvl.unit ? `<div class="text-[10px] uppercase tracking-wide text-slate-400">${lvl.unit}</div>` : ""}
      </td>
      <td class="px-3 py-2.5 text-right">
        <span class="nums font-medium text-slate-700">${isNum(q.size_cr) ? fmtNum(q.size_cr) : "—"}</span>
      </td>
      <td class="px-3 py-2.5">
        <div class="truncate font-medium text-slate-700">${esc(q.dealer || "—")}</div>
        <div class="truncate text-[11px] text-slate-400">${esc(q.firm || "")}</div>
      </td>
      <td class="px-3 py-2.5 text-right">
        <span class="nums text-xs text-slate-500">${fmtTime(q.timestamp)}</span>
      </td>
    </tr>`;
}

function groupedHTML(groups) {
  const head = `
    <thead class="sticky-head">
      <tr class="border-b border-slate-200 bg-slate-50/95 backdrop-blur">
        ${th("Bond", "left")}
        ${th("Best Bid", "right")}
        ${th("Best Offer", "right")}
        ${th("Spread", "right")}
        ${th("Quotes", "right")}
      </tr>
    </thead>`;

  const body = groups
    .map((g) => {
      const sec = SECTION[g.section] || SECTION.Bonds;
      const narrow = narrowGap(g.bestBid, g.bestOffer, g.meaning);
      const yld = g.meaning === "yield";
      const coupon = isNum(g.coupon) ? `${fmtNum(g.coupon, 2)}%` : "";
      const sub = [coupon, g.instrument, fmtDate(g.maturity)].filter((x) => x && x !== "—").join(" · ");
      const spread =
        g.spread != null
          ? `<span class="nums font-semibold ${narrow ? "text-amber-600" : "text-slate-700"}">${fmtNum(g.spread, yld ? 2 : null)}</span>`
          : `<span class="text-slate-300">—</span>`;
      return `
      <tr class="qrow ${narrow ? "narrow-glow" : sec.acc} border-b border-slate-100">
        <td class="px-3 py-2.5">
          <div class="flex items-center font-semibold text-slate-800">
            <span class="truncate">${esc(g.issuer || "—")}</span>
            <span class="ml-1.5 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${sec.chip}">${sec.label}</span>
          </div>
          <div class="mt-0.5 text-[11px] text-slate-400">${esc(sub) || "&nbsp;"}</div>
        </td>
        <td class="px-3 py-2.5 text-right"><span class="nums font-semibold text-emerald-600">${g.bestBid != null ? fmtNum(g.bestBid, yld ? 2 : null) : "—"}</span></td>
        <td class="px-3 py-2.5 text-right"><span class="nums font-semibold text-rose-600">${g.bestOffer != null ? fmtNum(g.bestOffer, yld ? 2 : null) : "—"}</span></td>
        <td class="px-3 py-2.5 text-right">${spread}</td>
        <td class="px-3 py-2.5 text-right"><span class="nums text-slate-500">${g.count}</span></td>
      </tr>`;
    })
    .join("");

  return `<table class="w-full min-w-[720px] border-collapse text-sm">
      <colgroup><col style="width:auto"/><col style="width:120px"/><col style="width:120px"/><col style="width:110px"/><col style="width:90px"/></colgroup>
      ${head}<tbody>${body}</tbody></table>`;
}

/* =========================================================================
   Rendering — states
   ========================================================================= */

function loadingHTML() {
  const bar = (w) => `<div class="shimmer h-3.5" style="width:${w}"></div>`;
  const row = () => `
    <div class="flex items-center gap-4 border-b border-slate-100 px-4 py-3.5">
      <div class="flex-1 space-y-2">${bar("48%")}${bar("28%")}</div>
      <div class="w-24">${bar("70%")}</div>
      <div class="w-16">${bar("100%")}</div>
      <div class="w-20">${bar("80%")}</div>
      <div class="w-28">${bar("64%")}</div>
      <div class="w-12">${bar("100%")}</div>
    </div>`;
  return `<div>${Array.from({ length: 9 }).map(row).join("")}</div>`;
}

function emptyHTML() {
  return `
    <div class="grid h-full min-h-[280px] place-items-center p-8 text-center">
      <div class="max-w-sm">
        <div class="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-slate-100">
          <i data-lucide="inbox" class="h-7 w-7 text-slate-400"></i>
        </div>
        <h3 class="font-display text-base font-bold text-slate-700">No quotes match</h3>
        <p class="mt-1 text-sm text-slate-500">
          Nothing here for the current filters. Try a different section, clear the search, or switch off “Narrow only”.
        </p>
        <button data-action="reset" class="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-700">
          <i data-lucide="rotate-ccw" class="h-4 w-4"></i>Reset filters
        </button>
      </div>
    </div>`;
}

function errorHTML() {
  return `
    <div class="grid h-full min-h-[280px] place-items-center p-8 text-center">
      <div class="max-w-sm">
        <div class="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-rose-50">
          <i data-lucide="cloud-alert" class="h-7 w-7 text-rose-500"></i>
        </div>
        <h3 class="font-display text-base font-bold text-slate-700">Couldn’t load the board</h3>
        <p class="mt-1 text-sm text-slate-500">${esc(state.error || "The quotes file could not be read.")}</p>
        <button data-action="retry" class="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-700">
          <i data-lucide="refresh-cw" class="h-4 w-4"></i>Try again
        </button>
      </div>
    </div>`;
}

/* =========================================================================
   Spread Watch — computation (all in the browser, from quotes.json)
   ========================================================================= */

const trunc = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

/* A real bond/govt yield lives in a single-digit band; a "yield" outside it is a
   mis-parsed size or price (e.g. 80, 92, 25) that would otherwise distort the
   curve, heatmap and peer gaps. This is the ONE place Spread Watch and
   Opportunities read a yield, so guarding here excludes those values from every
   spread computation at once — the Live Board still shows each quote's raw level
   as-is (it never calls usableYield). */
const USABLE_Y_MIN = 2, USABLE_Y_MAX = 13;

/** Usable yield for a quote: q.yield, else the mid of a yield two-way, else null —
 *  but only when it falls in the plausible [2, 13]% band (else null). */
function usableYield(q) {
  let y = null;
  if (isNum(q.yield)) y = q.yield;
  else if (q.side === "two_way" && isNum(q.bid) && isNum(q.offer) && q.level_meaning === "yield") y = (q.bid + q.offer) / 2;
  return y != null && y >= USABLE_Y_MIN && y <= USABLE_Y_MAX ? y : null;
}

function median(arr) {
  if (!arr || !arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fmtBps(v, signed) {
  if (!isNum(v)) return "—";
  const r = Math.round(v);
  return (signed && r > 0 ? "+" : "") + r;
}

/** Government curve: Gsec (tenor, usableYield) points, duplicate tenors collapsed
 *  by median (keeps a stray outlier from spiking the line), sorted by tenor.
 *  Returns [{t,y}] or null when there are fewer than 2 distinct points. */
/* Government yields realistically sit in a single-digit band; a value outside
   this is a mis-parse (a price/spread that landed in the yield field) and, left
   in, it rescales the whole curve chart. Same spirit as the tenor guard above
   and the Opportunities plausibility band. */
const GOVT_Y_MIN = 2, GOVT_Y_MAX = 12;
function buildGovtCurve(enriched) {
  const byTenor = new Map();
  for (const e of enriched) {
    if (e.section !== "Gsec") continue;
    if (!(e.tenor > 0 && e.tenor <= 50)) continue; // ignore implausible tenors (bad LLM data)
    if (!(e.uy >= GOVT_Y_MIN && e.uy <= GOVT_Y_MAX)) continue; // ignore implausible yields (bad LLM data)
    if (!byTenor.has(e.tenor)) byTenor.set(e.tenor, []);
    byTenor.get(e.tenor).push(e.uy);
  }
  const pts = [...byTenor.entries()].map(([t, ys]) => ({ t, y: median(ys) })).sort((a, b) => a.t - b.t);
  return pts.length >= 2 ? pts : null;
}

/** Linear interpolation on the sorted curve, clamped beyond the ends. */
function govtYieldAt(pts, t) {
  if (!pts || !pts.length) return null;
  if (t <= pts[0].t) return pts[0].y;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].y;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (t >= a.t && t <= b.t) return b.t === a.t ? (a.y + b.y) / 2 : a.y + (b.y - a.y) * (t - a.t) / (b.t - a.t);
  }
  return pts[pts.length - 1].y;
}

/**
 * The shared full-day compute pass. Builds the government curve and the corp
 * BOND universe (one row per issuer+maturity) with each bond's leave-one-out
 * peer gap AND its spread over the government curve — the same two Phase-2
 * measures that Spread Watch and Opportunities both read, computed exactly
 * once, one way. No display filters here; each caller filters its own view.
 */
function computeUniverse() {
  const quotes = liveDayQuotes(state.data?.quotes || []); // analysis reads the live day only
  const total = quotes.length;
  const quoteTotal = quotes.reduce((n, q) => n + (q.side !== "comment" ? 1 : 0), 0); // tradeable quotes, not chatter

  let withUY = 0, withUYT = 0;
  const enriched = [];
  for (const q of quotes) {
    const uy = usableYield(q);
    if (uy != null) withUY++;
    if (uy != null && isNum(q.tenor_years)) {
      withUYT++;
      enriched.push({ q, uy, tenor: q.tenor_years, bucket: tenorBucket(q.tenor_years), section: q.section, issuer: q.issuer || "—", maturity: q.maturity || "" });
    }
  }

  const govtCurve = buildGovtCurve(enriched);
  const corp = enriched.filter((e) => e.section === "Bonds" || e.section === "DCM");

  // Aggregate corp quotes -> bonds (issuer+maturity), median yield; keep the
  // underlying items so a card can show a representative dealer / time / raw line.
  const bondMap = new Map();
  for (const e of corp) {
    const key = `${e.section}||${e.issuer.toLowerCase()}||${e.maturity}`;
    if (!bondMap.has(key)) bondMap.set(key, { issuer: e.issuer, maturity: e.maturity, section: e.section, tenor: e.tenor, bucket: e.bucket, uys: [], sizes: [], who: new Set(), items: [] });
    const b = bondMap.get(key);
    b.uys.push(e.uy);
    b.items.push(e);
    if (isNum(e.q.size_cr)) b.sizes.push(e.q.size_cr);
    if (e.q.dealer) b.who.add(e.q.dealer);
    if (e.q.firm) b.who.add(e.q.firm);
  }
  const bonds = [...bondMap.values()].map((b) => {
    const repr = b.items.reduce((a, c) => (tsSeconds(c.q.timestamp) >= tsSeconds(a.q.timestamp) ? c : a), b.items[0]);
    return { issuer: b.issuer, maturity: b.maturity, section: b.section, tenor: b.tenor, bucket: b.bucket, uy: median(b.uys), n: b.uys.length, size: b.sizes.length ? Math.max(...b.sizes) : null, who: [...b.who].join(" ").toLowerCase(), repr };
  });

  // Leave-one-out peer median (vs Peers) + spread over the govt curve (vs Govt),
  // attached to every bond.
  const peerGroups = new Map();
  for (const b of bonds) {
    const k = `${b.section}||${b.bucket}`;
    if (!peerGroups.has(k)) peerGroups.set(k, []);
    peerGroups.get(k).push(b);
  }
  for (const b of bonds) {
    const others = peerGroups.get(`${b.section}||${b.bucket}`).filter((x) => x !== b);
    const pm = others.length ? median(others.map((x) => x.uy)) : null;
    b.peerMedian = pm;
    b.gap = pm != null ? Math.round((b.uy - pm) * 100) : null;
    b.govtSpread = govtCurve ? Math.round((b.uy - govtYieldAt(govtCurve, b.tenor)) * 100) : null;
  }

  return { total, quoteTotal, withUY, withUYT, enriched, corp, govtCurve, bonds };
}

/**
 * Spread Watch's compute pass: the shared universe + the heatmap + display
 * filters. Returns coverage counts, the curve, heatmap rows, peer bonds, and
 * the headline stats.
 */
function computeSpread() {
  const { total, quoteTotal, withUY, withUYT, govtCurve, corp, bonds } = computeUniverse();

  // ---- Heatmap: per corp quote, spread vs govt; median per issuer x bucket.
  let issuerRows = [];
  if (govtCurve) {
    // Keys include section so an issuer that trades BOTH Bonds and DCM keeps two
    // separate rows (one section's yields never contaminate the other's).
    // Keys are lowercased (like the peer aggregation) so casing variants of the
    // same issuer don't split into separate rows; the first spelling seen is kept
    // for display.
    const cellMap = new Map(); // section|||issuerLC|||bucket -> exact observations
    const issuerAgg = new Map(); // section|||issuerLC -> {issuer(display), section, who}
    for (const e of corp) {
      const gy = govtYieldAt(govtCurve, e.tenor);
      if (gy == null) continue;
      const iss = e.issuer.toLowerCase();
      const ck = `${e.section}|||${iss}|||${e.bucket}`;
      if (!cellMap.has(ck)) cellMap.set(ck, []);
      cellMap.get(ck).push({ spread: (e.uy - gy) * 100, corpY: e.uy, govtY: gy });
      const ik = `${e.section}|||${iss}`;
      if (!issuerAgg.has(ik)) issuerAgg.set(ik, { issuer: e.issuer, section: e.section, who: new Set() });
      const ia = issuerAgg.get(ik);
      if (e.q.dealer) ia.who.add(e.q.dealer);
      if (e.q.firm) ia.who.add(e.q.firm);
    }
    issuerRows = [...issuerAgg.values()].map((it) => {
      const issLC = it.issuer.toLowerCase();
      const cells = {};
      for (const bk of TENOR_BUCKETS) {
        const obs = cellMap.get(`${it.section}|||${issLC}|||${bk}`);
        if (obs && obs.length) {
          // True median: for an even count, average the TWO central observations'
          // spread AND their yields, so corp - govt still reproduces the tile.
          const s = obs.slice().sort((a, b) => a.spread - b.spread);
          const n = s.length, m = Math.floor(n / 2);
          const pick = n % 2 ? [s[m]] : [s[m - 1], s[m]];
          const mean = (f) => pick.reduce((x, o) => x + f(o), 0) / pick.length;
          cells[bk] = { median: Math.round(mean((o) => o.spread)), n, corpY: mean((o) => o.corpY), govtY: mean((o) => o.govtY) };
        }
      }
      return { issuer: it.issuer, section: it.section, who: [...it.who].join(" ").toLowerCase(), cells };
    });
  }

  // ---- Display filters (section / search / tenor).
  const term = state.search.trim().toLowerCase();
  const secOk = (s) => (state.spreadSection === "All" ? true : s === state.spreadSection);
  // The header field promises "issuer or dealer", so match issuer AND the
  // dealers/firms that quoted it (carried through aggregation as `who`).
  const searchOk = (issuer, who) => !term || issuer.toLowerCase().includes(term) || (!!who && who.includes(term));
  const buckets = state.spreadTenor === "All" ? TENOR_BUCKETS : [state.spreadTenor];

  let rows = issuerRows.filter((r) => secOk(r.section) && searchOk(r.issuer, r.who));
  if (state.spreadTenor !== "All") rows = rows.filter((r) => r.cells[state.spreadTenor]);
  // Average over the DISPLAYED buckets only, so selecting a tenor re-labels and
  // re-ranks rows by the cells actually on screen (not hidden ones).
  rows = rows.map((r) => {
    const vals = buckets.filter((bk) => r.cells[bk]).map((bk) => r.cells[bk].median);
    return { ...r, avg: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0 };
  });
  rows.sort((a, b) => b.avg - a.avg);

  const cellVals = [];
  for (const r of rows) for (const bk of buckets) if (r.cells[bk]) cellVals.push(r.cells[bk].median);
  const sortedCells = cellVals.slice().sort((a, b) => a - b);
  const gridStats = sortedCells.length
    ? { min: sortedCells[0], med: median(sortedCells), max: sortedCells[sortedCells.length - 1] }
    : null;

  let dispBonds = bonds.filter((b) => secOk(b.section) && searchOk(b.issuer, b.who) && isNum(b.gap));
  if (state.spreadTenor !== "All") dispBonds = dispBonds.filter((b) => b.bucket === state.spreadTenor);
  dispBonds.sort((a, b) => b.gap - a.gap);

  const avgPickup = cellVals.length ? Math.round(cellVals.reduce((s, v) => s + v, 0) / cellVals.length) : null;
  let widest = null;
  for (const r of rows) for (const bk of buckets) if (r.cells[bk] && (!widest || r.cells[bk].median > widest.v)) widest = { issuer: r.issuer, bucket: bk, v: r.cells[bk].median };
  const cheapest = dispBonds.length && dispBonds[0].gap > 0 ? dispBonds[0] : null;
  const richest = dispBonds.length && dispBonds[dispBonds.length - 1].gap < 0 ? dispBonds[dispBonds.length - 1] : null;

  return { total, quoteTotal, withUY, withUYT, govtCurve, rows, buckets, gridStats, bonds: dispBonds, avgPickup, widest, cheapest, richest };
}

/* =========================================================================
   Spread Watch — color helpers (diverging scale for the heatmap)
   ========================================================================= */

function hexToRgb(h) { h = h.replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function lerpColor(c1, c2, t) {
  const a = hexToRgb(c1), b = hexToRgb(c2);
  const m = (i) => Math.round(a[i] + (b[i] - a[i]) * t);
  return `#${[m(0), m(1), m(2)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
function luminance(hex) { const [r, g, b] = hexToRgb(hex).map((v) => v / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
function textOn(hex) { return luminance(hex) < 0.6 ? "#ffffff" : "#0f172a"; }
/** Diverging: min -> cool (tight), median -> neutral gray, max -> warm/green (wide). */
function divergingColor(v, min, med, max) {
  if (!isNum(v) || max === min) return SPREAD_MID;
  if (v <= med) return lerpColor(SPREAD_COOL, SPREAD_MID, med > min ? (v - min) / (med - min) : 1);
  return lerpColor(SPREAD_MID, SPREAD_WARM, max > med ? (v - med) / (max - med) : 0);
}

/* =========================================================================
   Spread Watch — tooltips (rich, built at hover from a JSON payload)
   ========================================================================= */

function renderTip(o) {
  const L = (t) => `<div class="tt-label">${t}</div>`;
  const row = (k, v) => `<div style="display:flex;justify-content:space-between;gap:18px"><span style="color:${T.n400}">${k}</span><span style="font-variant-numeric:tabular-nums">${v}</span></div>`;
  if (o.kind === "row") {
    const meta = [o.dealer, o.firm].filter(Boolean).join(" · ");
    const time = o.time ? ` · ${o.time}` : "";
    return `${L("Original line")}${esc(o.raw)}${meta ? `<div class="tt-label" style="margin-top:6px">${esc(meta)}${esc(time)}</div>` : ""}`;
  }
  if (o.kind === "info") {
    return `${L("How to read Spread Watch")}<div style="line-height:1.55">
      <b>Yield</b> = the return a bond pays. <b>Spread</b> = the EXTRA yield over a benchmark.
      <div style="margin-top:6px"><b style="color:${T.tintIndigo}">vs Government</b> — extra yield over the government curve at the same maturity. Bigger = the bond is "cheaper" (pays more) = more attractive to buy.</div>
      <div style="margin-top:4px"><b style="color:${T.tintEmerald}">vs Peers</b> — how a bond's yield compares to other bonds of similar maturity. Above the group = cheap (buy); below = rich (expensive).</div></div>`;
  }
  if (o.kind === "curve") return `${L("Government curve")}${row("Tenor", o.t + "y")}${row("Govt yield", o.y.toFixed(2) + "%")}`;
  if (o.kind === "cell") return `${L("Pickup over government")}<div style="font-weight:600;margin-bottom:4px">${esc(o.issuer)}</div>${row("Tenor bucket", o.bucket)}${row("Median spread", fmtBps(o.spread) + " bps")}${row("Corp yield", o.corpY.toFixed(2) + "%")}${row("Govt yield", o.govtY.toFixed(2) + "%")}${row("Backed by", o.n + (o.n === 1 ? " quote" : " quotes"))}`;
  if (o.kind === "bar") return `${L(o.gap >= 0 ? "Cheaper than peers (buy)" : "Richer than peers")}<div style="font-weight:600;margin-bottom:4px">${esc(o.issuer)}${o.maturity ? ` · ${fmtDate(o.maturity)}` : ""}</div>${row("Its yield", o.uy.toFixed(2) + "%")}${row("Peer median", o.peer.toFixed(2) + "%")}${row("Gap", fmtBps(o.gap, true) + " bps")}${o.size != null ? row("Size", fmtCr(o.size)) : ""}`;
  if (o.kind === "oppinfo") {
    return `${L("How to read Opportunities")}<div style="line-height:1.55">Today's quotes, scanned for the few worth acting on now:
      <div style="margin-top:6px"><b style="color:${T.tintEmerald}">Cheap (buy)</b> — yields more than similar bonds. <b style="color:${T.tintAmber}">Tight market</b> — a two-way with a small bid–offer gap; easy to deal.</div>
      <div style="margin-top:4px"><b style="color:${T.tintTeal}">Big pickup</b> — pays a lot over the government curve. <b style="color:${T.tintBlue}">Two-sided</b> — a buyer and a seller are both active. <b style="color:${T.tintRose}">Rich (sell)</b> — yields less than peers; don't overpay.</div>
      <div style="margin-top:4px;color:${T.n400}">Sorted strongest-first. All figures are bps unless shown otherwise.</div></div>`;
  }
  if (o.kind === "opp") {
    const rows = (o.rows || []).map(([k, v]) => row(esc(k), esc(v))).join("");
    const raws = [o.raw, o.buyRaw, o.sellRaw].filter(Boolean);
    const rawHtml = raws.length ? `<div class="tt-label" style="margin-top:7px">Original line${raws.length > 1 ? "s" : ""}</div>${raws.map((r) => esc(r)).join("<br>")}` : "";
    return `${L(esc(o.title || "Opportunity"))}${rows}${rawHtml}`;
  }
  if (o.kind === "pulseinfo") {
    return `${L("How to read Desk Pulse")}<div style="line-height:1.55">A quick read on the desk today:
      <div style="margin-top:6px"><b style="color:${T.tintIndigo}">Market split</b> — how many quotes in each section. <b style="color:${T.tintEmerald}">Buy vs sell</b> — is the desk mostly looking to buy or to sell.</div>
      <div style="margin-top:4px"><b>Activity</b> — quotes every 30 minutes, so you can see when it was busiest. <b>Most-active</b> — the issuers and dealers posting the most today.</div>
      <div style="margin-top:4px;color:${T.n400}">Everything here is a live count from today's quotes — no jargon needed.</div></div>`;
  }
  if (o.kind === "donutseg") {
    return `${L(esc(o.label))}${row("Quotes", o.count)}${row("Share", o.pct + "%")}${o.sub ? `<div style="color:${T.n400};margin-top:3px">${esc(o.sub)}</div>` : ""}`;
  }
  if (o.kind === "timeline") {
    return `${L("Activity")}${row("Time", esc(o.label))}${row("Quotes", o.count)}`;
  }
  if (o.kind === "rankissuer") {
    return `${L(esc(o.name))}${row("Quotes", o.count)}${row("Buy interest", o.buy)}${row("Sell interest", o.sell)}${o.other ? row("Two-way / other", o.other) : ""}`;
  }
  if (o.kind === "rankdealer") {
    return `${L(esc(o.name))}${o.firm ? `<div style="color:${T.n400};margin-bottom:3px">${esc(o.firm)}</div>` : ""}${row("Quotes posted", o.count)}`;
  }
  return "";
}

/* =========================================================================
   Spread Watch — SVG charts (hand-rolled, no chart library)
   ========================================================================= */

function govtCurveSVG(curve) {
  const W = 680, H = 196, pl = 42, pr = 16, pt = 16, pb = 28;
  const ts = curve.map((p) => p.t), ys = curve.map((p) => p.y);
  // Curve tenors are already filtered to <=50 in buildGovtCurve, but clamp the
  // axis domain and use a fixed step anyway so a stray value can never spawn a
  // runaway number of ticks.
  const maxT = Math.min(50, Math.max(2, Math.ceil(Math.max(...ts))));
  const step = maxT <= 12 ? 2 : Math.ceil(maxT / 6);
  const dMin = Math.min(...ys), dMax = Math.max(...ys);
  const pad = Math.max(0.15, (dMax - dMin) * 0.2);
  const y0 = dMin - pad, y1 = dMax + pad;
  const sx = (t) => pl + (Math.min(t, maxT) / maxT) * (W - pl - pr);
  const sy = (y) => H - pb - ((y - y0) / (y1 - y0)) * (H - pt - pb);
  const line = curve.map((p, i) => `${i ? "L" : "M"}${sx(p.t).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(" ");
  const area = `${line} L${sx(ts[ts.length - 1]).toFixed(1)} ${(H - pb).toFixed(1)} L${sx(ts[0]).toFixed(1)} ${(H - pb).toFixed(1)} Z`;
  let xg = "";
  for (let t = 0; t <= maxT; t += step) xg += `<text x="${sx(t).toFixed(1)}" y="${H - pb + 16}" text-anchor="middle" font-size="10" fill="${T.n400}">${t}y</text>`;
  const ymid = (dMin + dMax) / 2;
  const yg = [dMin, ymid, dMax].map((v) => `<line x1="${pl}" y1="${sy(v).toFixed(1)}" x2="${W - pr}" y2="${sy(v).toFixed(1)}" stroke="${T.n200}" stroke-opacity="0.7"/><text x="${pl - 6}" y="${(sy(v) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${T.n400}">${v.toFixed(2)}</text>`).join("");
  const dots = curve.map((p) => {
    const X = sx(p.t).toFixed(1), Y = sy(p.y).toFixed(1);
    const tip = JSON.stringify({ kind: "curve", t: p.t, y: p.y, accent: T.grad1 });
    // A per-dot crosshair, revealed by the .cd:hover rule; the wide transparent
    // circle is the hover/hit target that also carries the tooltip.
    return `<g class="cd">
      <line class="cross" x1="${X}" y1="${pt}" x2="${X}" y2="${H - pb}" stroke="${T.grad1}" stroke-opacity="0.45" stroke-dasharray="3 3"/>
      <line class="cross" x1="${pl}" y1="${Y}" x2="${X}" y2="${Y}" stroke="${T.grad1}" stroke-opacity="0.45" stroke-dasharray="3 3"/>
      <circle cx="${X}" cy="${Y}" r="4" fill="${T.grad1}"/>
      <circle cx="${X}" cy="${Y}" r="13" fill="transparent" data-tip="${esc(tip)}" style="cursor:pointer"/>
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="w-full" style="max-height:224px" role="img" aria-label="Government yield curve: yield by tenor">
    <defs><linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${T.grad1}" stop-opacity="0.22"/><stop offset="100%" stop-color="${T.grad1}" stop-opacity="0"/></linearGradient></defs>
    ${xg}${yg}
    <path d="${area}" fill="url(#curveFill)"/>
    <path d="${line}" fill="none" stroke="${T.grad1}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  </svg>`;
}

function peersShown(bonds) {
  const cheap = bonds.filter((b) => b.gap > 0).slice(0, 12);
  const rich = bonds.filter((b) => b.gap < 0).slice(-12);
  return [...cheap, ...rich];
}

function peersBarsSVG(shown) {
  const n = shown.length;
  if (!n) return "";
  const W = 720, rowH = 22, top = 24, bot = 8, labelW = 156, plotR = W - 14;
  const H = top + n * rowH + bot;
  const zeroX = labelW + (plotR - labelW) / 2;
  const half = (plotR - labelW) / 2 - 6;
  const maxAbs = Math.max(1, ...shown.map((b) => Math.abs(b.gap)));
  const bx = (g) => zeroX + (g / maxAbs) * half;
  const hdr = `<text x="${(zeroX + half / 2).toFixed(0)}" y="13" text-anchor="middle" font-size="10" font-weight="600" fill="${T.buyInk}">cheaper → (buy)</text><text x="${(zeroX - half / 2).toFixed(0)}" y="13" text-anchor="middle" font-size="10" font-weight="600" fill="${T.sellInk}">← richer</text>`;
  const zero = `<line x1="${zeroX.toFixed(1)}" y1="${top - 2}" x2="${zeroX.toFixed(1)}" y2="${H - bot}" stroke="${T.n300}" stroke-dasharray="3 3"/>`;
  const bars = shown.map((b, i) => {
    const y = top + i * rowH, cy = y + rowH / 2;
    const x2 = bx(b.gap), left = Math.min(zeroX, x2), w = Math.max(2, Math.abs(x2 - zeroX));
    const col = b.gap >= 0 ? "url(#peerBuy)" : "url(#peerSell)";
    const valX = b.gap >= 0 ? x2 + 4 : x2 - 4, anchor = b.gap >= 0 ? "start" : "end";
    const tip = JSON.stringify({ kind: "bar", issuer: b.issuer, maturity: b.maturity, uy: +b.uy.toFixed(2), peer: +b.peerMedian.toFixed(2), gap: b.gap, size: b.size, accent: b.gap >= 0 ? T.buy : T.sell });
    return `<g data-tip="${esc(tip)}" style="cursor:pointer">
      <rect x="0" y="${y}" width="${W}" height="${rowH}" fill="transparent"/>
      <text x="${labelW - 10}" y="${(cy + 3.5).toFixed(1)}" text-anchor="end" font-size="11" fill="${T.n700}">${esc(trunc(b.issuer, 22))}</text>
      <rect x="${left.toFixed(1)}" y="${y + 4}" width="${w.toFixed(1)}" height="${rowH - 8}" rx="3" fill="${col}"/>
      <text x="${valX.toFixed(1)}" y="${(cy + 3.5).toFixed(1)}" text-anchor="${anchor}" font-size="10" font-weight="600" fill="${b.gap >= 0 ? T.buyInk : T.sellInk}">${fmtBps(b.gap, true)}</text>
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="hov w-full" role="img" aria-label="Bond yield vs peer median, cheapest to richest">
    <defs>
      <linearGradient id="peerBuy" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="${T.buy}" stop-opacity="0.82"/><stop offset="100%" stop-color="${T.buy}"/></linearGradient>
      <linearGradient id="peerSell" x1="1" y1="0" x2="0" y2="0"><stop offset="0%" stop-color="${T.sell}" stop-opacity="0.82"/><stop offset="100%" stop-color="${T.sell}"/></linearGradient>
    </defs>${hdr}${zero}${bars}</svg>`;
}

/* =========================================================================
   Spread Watch — heatmap table + peers table
   ========================================================================= */

function spreadGridHTML(rows, buckets, gridStats) {
  if (!rows.length || !gridStats) return spreadEmpty("No corporate spreads", "No Bonds/DCM quotes with a usable yield and tenor match these filters.", "grid-3x3");
  const head = `<thead class="sticky-head"><tr class="border-b border-slate-200 bg-slate-50/95 backdrop-blur">
    <th class="sticky left-0 z-20 bg-slate-50 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">Issuer</th>
    ${buckets.map((b) => `<th class="px-2 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-400 nums">${b}</th>`).join("")}
  </tr></thead>`;
  const body = rows.map((r) => {
    const sec = SECTION[r.section] || SECTION.Bonds;
    const cells = buckets.map((bk) => {
      const c = r.cells[bk];
      if (!c) return `<td class="px-2 py-2 text-right"><span class="text-slate-200">·</span></td>`;
      const bg = divergingColor(c.median, gridStats.min, gridStats.med, gridStats.max);
      const tip = JSON.stringify({ kind: "cell", issuer: r.issuer, bucket: bk, spread: c.median, corpY: +c.corpY.toFixed(2), govtY: +c.govtY.toFixed(2), n: c.n, accent: bg });
      return `<td class="px-1.5 py-1.5 text-right"><span class="inline-block w-full rounded-md px-2 py-1 text-right text-xs font-bold nums" style="background:${bg};color:${textOn(bg)}" data-tip="${esc(tip)}">${fmtBps(c.median)}</span></td>`;
    }).join("");
    return `<tr class="heat-row hov border-b border-slate-100">
      <td class="heat-issuer sticky left-0 z-10 bg-white px-3 py-1.5">
        <div class="flex items-center gap-1.5"><span class="truncate font-semibold text-slate-800" style="max-width:190px">${esc(r.issuer)}</span>
        <span class="rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${sec.chip}">${sec.label}</span></div>
        <div class="text-[10px] text-slate-400 nums">avg ${fmtBps(r.avg)} bps</div>
      </td>${cells}</tr>`;
  }).join("");
  return `<table class="w-full min-w-[560px] border-collapse text-sm"><colgroup><col style="width:auto"/>${buckets.map(() => '<col style="width:92px"/>').join("")}</colgroup>${head}<tbody>${body}</tbody></table>`;
}

function peersTableHTML(shown) {
  const head = `<thead class="sticky-head"><tr class="border-b border-slate-200 bg-slate-50/95 backdrop-blur">
    ${th("Bond", "left")}${th("Its yield", "right")}${th("Peer median", "right")}${th("Gap (bps)", "right")}${th("Size (₹cr)", "right")}</tr></thead>`;
  const body = shown.map((b) => {
    const sec = SECTION[b.section] || SECTION.Bonds;
    const col = b.gap >= 0 ? "text-emerald-600" : "text-rose-600";
    return `<tr class="qrow ${sec.acc} border-b border-slate-100">
      <td class="px-3 py-2"><div class="flex items-center gap-1.5"><span class="truncate font-semibold text-slate-800" style="max-width:230px">${esc(b.issuer)}</span><span class="rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${sec.chip}">${sec.label}</span></div><div class="text-[11px] text-slate-400">${b.maturity ? fmtDate(b.maturity) : "—"} · ${b.bucket}</div></td>
      <td class="px-3 py-2 text-right nums font-semibold text-slate-900">${b.uy.toFixed(2)}</td>
      <td class="px-3 py-2 text-right nums text-slate-500">${b.peerMedian.toFixed(2)}</td>
      <td class="px-3 py-2 text-right nums font-bold ${col}">${fmtBps(b.gap, true)}</td>
      <td class="px-3 py-2 text-right nums text-slate-600">${b.size != null ? fmtNum(b.size) : "—"}</td>
    </tr>`;
  }).join("");
  return `<table class="w-full min-w-[560px] border-collapse text-sm"><colgroup><col style="width:auto"/><col style="width:92px"/><col style="width:112px"/><col style="width:100px"/><col style="width:104px"/></colgroup>${head}<tbody>${body}</tbody></table>`;
}

/* =========================================================================
   Spread Watch — controls, chrome, bodies, states
   ========================================================================= */

function spreadViewToggle() {
  const opt = (v, label, icon) => {
    const a = state.spreadView === v;
    return `<button data-spread-view="${v}" class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${a ? "grad-bar text-white shadow-sm shadow-indigo-500/25" : "text-slate-500 hover:text-slate-700"}"><i data-lucide="${icon}" class="h-3.5 w-3.5"></i>${label}</button>`;
  };
  return `<div class="inline-flex items-center rounded-xl bg-slate-100/80 p-1">${opt("govt", "vs Government", "landmark")}${opt("peers", "vs Peers", "users")}</div>`;
}

function spreadSectionSeg() {
  const opt = (v) => {
    const a = state.spreadSection === v;
    return `<button data-spread-section="${v}" class="rounded-lg px-3 py-1.5 text-xs font-semibold transition ${a ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-700"}">${v}</button>`;
  };
  return `<div class="inline-flex items-center rounded-xl bg-slate-100/80 p-1">${["All", "Bonds", "DCM"].map(opt).join("")}</div>`;
}

function spreadTenorSelect() {
  const opts = ["All", ...TENOR_BUCKETS].map((t) => `<option value="${t}" ${state.spreadTenor === t ? "selected" : ""}>${t === "All" ? "All tenors" : t}</option>`).join("");
  return `<select data-spread-tenor class="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 outline-none transition focus:border-indigo-300 focus:ring-2 focus:ring-indigo-200">${opts}</select>`;
}

function spreadStatChips(c) {
  const chip = (icon, label, value, tone) => `<span class="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] ${tone}"><i data-lucide="${icon}" class="h-3 w-3"></i><span class="opacity-70">${label}</span><span class="font-bold nums">${esc(value)}</span></span>`;
  if (state.spreadView === "govt") {
    return chip("trending-up", "Avg pickup", c.avgPickup != null ? fmtBps(c.avgPickup) + " bps" : "—", "border-indigo-200 bg-indigo-50 text-indigo-700") +
      chip("flame", "Widest", c.widest ? `${trunc(c.widest.issuer, 15)} ${fmtBps(c.widest.v)}` : "—", "border-emerald-200 bg-emerald-50 text-emerald-700");
  }
  return chip("arrow-up-right", "Cheapest", c.cheapest ? `${trunc(c.cheapest.issuer, 14)} ${fmtBps(c.cheapest.gap, true)}` : "—", "border-emerald-200 bg-emerald-50 text-emerald-700") +
    chip("arrow-down-right", "Richest", c.richest ? `${trunc(c.richest.issuer, 14)} ${fmtBps(c.richest.gap, true)}` : "—", "border-rose-200 bg-rose-50 text-rose-700");
}

function spreadControlsHTML(c) {
  return `<div class="mb-3 flex flex-wrap items-center gap-2">
    ${spreadViewToggle()}
    <div class="mx-1 hidden h-5 w-px bg-slate-200 sm:block"></div>
    ${spreadSectionSeg()}
    ${spreadTenorSelect()}
    <button class="grid h-8 w-8 place-items-center rounded-lg text-slate-400 ring-1 ring-slate-200 transition hover:text-indigo-600 hover:ring-indigo-200" data-tip="${esc(JSON.stringify({ kind: "info" }))}" aria-label="How to read Spread Watch"><i data-lucide="info" class="h-4 w-4"></i></button>
    <div class="ml-auto flex flex-wrap items-center gap-2">${c ? spreadStatChips(c) : ""}</div>
  </div>`;
}

function spreadLegend() {
  if (state.spreadView === "govt") {
    return `<div class="hidden items-center gap-2 text-[11px] font-medium text-slate-400 md:flex"><span>tight</span><span class="h-2 w-16 rounded-full" style="background:linear-gradient(90deg,${SPREAD_COOL},${SPREAD_MID},${SPREAD_WARM})"></span><span>wide · more pickup</span></div>`;
  }
  const dot = (col, t) => `<span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-full" style="background:${col}"></span>${t}</span>`;
  return `<div class="hidden items-center gap-3 text-[11px] font-medium text-slate-400 md:flex">${dot(CHEAP, "cheap (buy)")}${dot(RICH, "rich")}</div>`;
}

function spreadEmpty(title, msg, icon) {
  return `<div class="grid h-full min-h-[300px] place-items-center p-8 text-center"><div class="max-w-sm">
    <div class="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-slate-100"><i data-lucide="${icon || "inbox"}" class="h-7 w-7 text-slate-400"></i></div>
    <h3 class="font-display text-base font-bold text-slate-700">${title}</h3>
    <p class="mt-1 text-sm leading-relaxed text-slate-500">${msg}</p>
  </div></div>`;
}

function spreadSkeleton() {
  return `<div class="space-y-3 p-4">${Array.from({ length: 9 }).map(() => `<div class="shimmer h-6"></div>`).join("")}</div>`;
}

function govtBody(c) {
  return `<div class="space-y-4 p-4">
    <section class="rounded-xl border border-slate-100 bg-white/70 p-3">
      <div class="mb-1 flex flex-wrap items-center gap-2">
        <i data-lucide="line-chart" class="h-4 w-4 text-indigo-500"></i>
        <h3 class="font-display text-sm font-bold text-slate-700">Government yield curve</h3>
        <span class="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-600">${c.govtCurve.length} points · hover a dot</span>
      </div>
      ${govtCurveSVG(c.govtCurve)}
    </section>
    <section>
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <i data-lucide="grid-3x3" class="h-4 w-4 text-indigo-500"></i>
        <h3 class="font-display text-sm font-bold text-slate-700">Spread grid — pickup over government (bps)</h3>
        <div class="ml-auto flex items-center gap-2 text-[11px] text-slate-400"><span>tight</span><span class="h-2.5 w-24 rounded-full" style="background:linear-gradient(90deg,${SPREAD_COOL},${SPREAD_MID},${SPREAD_WARM})"></span><span>wide (more pickup)</span></div>
      </div>
      <div class="overflow-x-auto rounded-xl border border-slate-100">${spreadGridHTML(c.rows, c.buckets, c.gridStats)}</div>
    </section>
  </div>`;
}

function peersBody(c) {
  const shown = peersShown(c.bonds);
  if (!shown.length) return spreadEmpty("No peer comparisons yet", "No Bonds/DCM bonds with a usable yield match these filters.", "users");
  return `<div class="space-y-4 p-4">
    <section>
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <i data-lucide="arrow-left-right" class="h-4 w-4 text-indigo-500"></i>
        <h3 class="font-display text-sm font-bold text-slate-700">Cheapest &amp; richest vs peers (bps)</h3>
        <span class="text-[11px] text-slate-400">green = cheaper (buy) · red = richer · hover a bar</span>
      </div>
      <div class="rounded-xl border border-slate-100 bg-white/60 p-2">${peersBarsSVG(shown)}</div>
    </section>
    <section><div class="overflow-x-auto rounded-xl border border-slate-100">${peersTableHTML(shown)}</div></section>
  </div>`;
}

function spreadChrome(bodyHTML, c) {
  const cov = c ? `<span class="font-semibold text-slate-600">${c.withUYT}</span> of ${c.quoteTotal} quotes carry a usable yield + tenor` : "";
  const gen = state.data ? fmtGenerated(state.data.generated_at) : null;
  return `
    ${spreadControlsHTML(c)}
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/90 shadow-sm shadow-slate-200/50 backdrop-blur">
      <div class="flex shrink-0 items-center gap-3 border-b border-slate-100 px-4 py-2.5">
        <div class="flex items-center gap-2"><i data-lucide="git-compare-arrows" class="h-4 w-4 text-indigo-500"></i><h2 class="font-display text-sm font-bold text-slate-800">Spread Watch</h2></div>
        ${spreadLegend()}
        <div class="ml-auto text-xs text-slate-400">${cov}</div>
      </div>
      <div class="scroll-y min-h-0 flex-1 overflow-auto">${bodyHTML}</div>
    </div>
    <div class="mt-2 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-slate-400">
      <span class="inline-flex items-center gap-1"><i data-lucide="calculator" class="h-3 w-3"></i>Spreads computed live in your browser from quotes.json</span>
      <span class="inline-flex items-center gap-1"><i data-lucide="cpu" class="h-3 w-3"></i>Model: ${esc(state.data?.model || "—")}</span>
      <span class="inline-flex items-center gap-1"><i data-lucide="calendar" class="h-3 w-3"></i>Trading day: ${esc(fmtDay(state.data?.trading_day) || state.data?.trading_day || "—")}</span>
      ${gen ? `<span class="inline-flex items-center gap-1"><i data-lucide="refresh-cw" class="h-3 w-3"></i>Updated ${gen}</span>` : ""}
    </div>`;
}

function renderSpreadView() {
  if (state.loading) { els.view.innerHTML = spreadChrome(spreadSkeleton(), null); afterRender(); return; }
  if (state.error) { els.view.innerHTML = spreadChrome(errorHTML(), null); afterRender(); return; }
  const c = computeSpread();
  let body;
  if (c.withUYT === 0) {
    body = spreadEmpty("No usable yields yet", "None of today's quotes carry both a yield and a tenor, so spreads can't be computed. This view fills in as yield-bearing quotes arrive.", "gauge");
  } else if (state.spreadView === "govt") {
    body = c.govtCurve
      ? govtBody(c)
      : spreadEmpty("Government curve unavailable today", "We need at least two Gsec quotes with a usable yield to build the curve. Switch to <b>vs Peers</b> — it doesn't need the curve.", "triangle-alert");
  } else {
    body = peersBody(c);
  }
  els.view.innerHTML = spreadChrome(body, c);
  afterRender();
}

/* =========================================================================
   Opportunities — the alert brain (reads the SAME universe as Spread Watch)
   ========================================================================= */

// color = vivid accent (fills, icon, strength bar); colorInk = AA-safe on white
// (headline text); bg/text = Tailwind soft chip. One meaning per colour.
// `plain` = the plain-English one-liner shown on the card (a layperson reads it
// at a glance); the exact bps stay in the headline number and the tooltip.
const OPP_CAT = {
  cheap: { label: "Cheap (buy)", icon: "trending-up", color: T.buy, colorInk: T.buyInk, bg: "bg-emerald-50", text: "text-emerald-700", plain: "Cheaper than similar bonds — pays more, worth buying" },
  tight: { label: "Tight market", icon: "gauge", color: T.act, colorInk: T.actInk, bg: "bg-amber-50", text: "text-amber-700", plain: "Easy to trade — buy & sell prices are very close" },
  pickup: { label: "Big pickup", icon: "landmark", color: T.pickup, colorInk: T.pickupInk, bg: "bg-teal-50", text: "text-teal-700", plain: "Pays a lot extra over government bonds" },
  twosided: { label: "Two-sided", icon: "arrow-left-right", color: T.info, colorInk: T.infoInk, bg: "bg-blue-50", text: "text-blue-700", plain: "A buyer & a seller are both active — you could match them" },
  rich: { label: "Rich (sell)", icon: "trending-down", color: T.sell, colorInk: T.sellInk, bg: "bg-rose-50", text: "text-rose-700", plain: "Pricier than similar bonds — don't overpay" },
};

// Plausibility guardrails: the LLM occasionally mis-parses a price/level into the
// yield field, which would otherwise surface as a nonsense "+1900 bps" alert.
// Opportunities (a curation layer) drops values outside a real-bond band so the
// tab only shows things actually worth acting on. The shared math is untouched.
const OPP_Y_MIN = 3, OPP_Y_MAX = 18; // plausible bond yield %
const OPP_GAP_CAP = 250;             // bps, |peer gap| beyond this = parse noise
const OPP_PICKUP_CAP = 600;          // bps, govt spread beyond this = parse noise
const plausibleY = (y) => isNum(y) && y >= OPP_Y_MIN && y <= OPP_Y_MAX;

const BUY_SIDES = new Set(["bid", "buy"]);
const SELL_SIDES = new Set(["offer", "sell", "ask"]);

/** Normalize a metric across a category to a 0–100 strength (10..100 so the
 *  weakest still reads as present); invert for "smaller is stronger" (tight). */
function assignStrength(items, valueFn, invert) {
  if (!items.length) return;
  const vs = items.map(valueFn);
  const mn = Math.min(...vs), mx = Math.max(...vs);
  for (const it of items) {
    if (mx === mn) { it.strength = 100; continue; }
    let t = (valueFn(it) - mn) / (mx - mn);
    if (invert) t = 1 - t;
    it.strength = Math.round(10 + 90 * t);
  }
}

function levelStr(q) {
  const l = levelCell(q);
  return l.unit ? `${l.main} ${l.unit}` : l.main;
}

/**
 * Scan today's quotes for the handful worth acting on now, in five categories,
 * each with a plain headline + why-line + 0–100 strength. Reuses the Phase-2
 * peer gap and govt spread verbatim (via computeUniverse). Applies the tab's
 * section/tenor/search filters, then caps each view so it reads like a short
 * list of best moves, not a spreadsheet.
 */
function computeOpportunities() {
  const u = computeUniverse();
  const quotes = liveDayQuotes(state.data?.quotes || []); // analysis reads the live day only

  // Freshness: a quote in the most-recent ~15% of the day gets a "fresh" dot.
  const tss = quotes.map((q) => tsSeconds(q.timestamp)).filter((v) => v >= 0).sort((a, b) => a - b);
  const freshCut = tss.length ? tss[Math.min(tss.length - 1, Math.floor(tss.length * 0.85))] : Infinity;
  const isFresh = (q) => q && tsSeconds(q.timestamp) >= 0 && tsSeconds(q.timestamp) >= freshCut;

  const term = state.search.trim().toLowerCase();
  const secOk = (s) => (state.oppSection === "All" ? true : s === state.oppSection);
  const tenOk = (bk) => (state.oppTenor === "All" ? true : bk === state.oppTenor);
  const hitsSearch = (issuer, who) => !term || (issuer || "").toLowerCase().includes(term) || (who || "").toLowerCase().includes(term);

  const pct = fmtPct; // shared formatter
  const bondWho = (b) => `${b.repr?.q?.dealer || ""} ${b.repr?.q?.firm || ""} ${b.who || ""}`;

  const baseFromBond = (b, type) => {
    const q = b.repr?.q || {};
    return {
      type, key: `${b.section}|${(b.issuer || "").toLowerCase()}|${b.maturity || ""}`,
      issuer: b.issuer, maturity: b.maturity, section: b.section, bucket: b.bucket, tenor: b.tenor,
      size: b.size, dealer: q.dealer, firm: q.firm, time: q.timestamp, fresh: isFresh(q), raw: q.raw,
      _val: 0,
    };
  };

  // ---- Bond-level categories from the shared universe (peer gap + govt spread).
  const cheap = [], rich = [], pickup = [];
  for (const b of u.bonds) {
    if (!plausibleY(b.uy) || !secOk(b.section) || !tenOk(b.bucket) || !hitsSearch(b.issuer, bondWho(b))) continue;
    if (isNum(b.gap) && Math.abs(b.gap) <= OPP_GAP_CAP) {
      if (b.gap >= 10) {
        const o = baseFromBond(b, "cheap"); o._val = b.gap;
        o.headline = `+${b.gap} bps`; o.sub = "vs peers";
        o.why = `Pays ${b.gap} bps more yield than similar ${b.bucket} bonds — attractive to buy.`;
        o.rows = [["Its yield", pct(b.uy)], ["Peer median", pct(b.peerMedian)], ["Gap vs peers", fmtBps(b.gap, true) + " bps"]];
        cheap.push(o);
      } else if (b.gap <= -10) {
        const o = baseFromBond(b, "rich"); o._val = -b.gap;
        o.headline = `${b.gap} bps`; o.sub = "vs peers";
        o.why = `Yields ${-b.gap} bps LESS than similar bonds — expensive; don't overpay.`;
        o.rows = [["Its yield", pct(b.uy)], ["Peer median", pct(b.peerMedian)], ["Gap vs peers", fmtBps(b.gap, true) + " bps"]];
        rich.push(o);
      }
    }
    if (isNum(b.govtSpread) && b.govtSpread >= 100 && b.govtSpread <= OPP_PICKUP_CAP) {
      const o = baseFromBond(b, "pickup"); o._val = b.govtSpread;
      const govtY = b.uy - b.govtSpread / 100;
      o.headline = `+${b.govtSpread} bps`; o.sub = "over govt";
      o.why = `Pays ${b.govtSpread} bps over the government curve for its maturity — a big yield pickup.`;
      o.rows = [["Its yield", pct(b.uy)], ["Govt curve", pct(govtY)], ["Pickup", "+" + b.govtSpread + " bps"]];
      pickup.push(o);
    }
  }

  // ---- Tight two-way markets (yield two-ways, gap in bps).
  const tight = [];
  for (const q of quotes) {
    if (!q.issuer) continue; // a card needs a bond to name
    if (q.side !== "two_way" || q.level_meaning !== "yield" || !isNum(q.bid) || !isNum(q.offer)) continue;
    if (!plausibleY(q.bid) || !plausibleY(q.offer)) continue;
    // Absolute gap: yield two-ways come in both orientations (bid<offer AND
    // bid>offer). Requiring offer>bid used to drop genuinely tight markets that
    // were quoted the other way round; tightness is the |bid-offer| width.
    const gap = Math.abs(Math.round((q.offer - q.bid) * 100));
    if (gap <= 0 || gap > 8) continue;
    const bucket = tenorBucket(q.tenor_years);
    if (!secOk(q.section) || !tenOk(bucket) || !hitsSearch(q.issuer, `${q.dealer || ""} ${q.firm || ""}`)) continue;
    tight.push({
      type: "tight", key: `${q.section}|${(q.issuer || "").toLowerCase()}|${q.maturity || ""}`,
      issuer: q.issuer || "—", maturity: q.maturity, section: q.section, bucket, tenor: q.tenor_years,
      size: q.size_cr, dealer: q.dealer, firm: q.firm, time: q.timestamp, fresh: isFresh(q), raw: q.raw, _val: gap,
      headline: `${gap} bps`, sub: "wide",
      why: `Only ${gap} bps between bid (${fmtNum(q.bid, 2)}) and offer (${fmtNum(q.offer, 2)}) — a tight, liquid market; easy to deal now.`,
      rows: [["Bid yield", pct(q.bid)], ["Offer yield", pct(q.offer)], ["Bid-offer", gap + " bps"]],
    });
  }

  // ---- Two-sided interest: same bond bid by one desk, offered by another.
  const twosided = [];
  const byBond = new Map();
  for (const q of quotes) {
    if (!q.issuer) continue;
    const k = `${q.section}|${q.issuer.toLowerCase()}|${q.maturity || ""}`;
    if (!byBond.has(k)) byBond.set(k, { issuer: q.issuer, section: q.section, maturity: q.maturity || "", tenor: q.tenor_years, buys: [], sells: [] });
    const e = byBond.get(k);
    if (BUY_SIDES.has(q.side)) e.buys.push(q);
    else if (SELL_SIDES.has(q.side)) e.sells.push(q);
  }
  for (const e of byBond.values()) {
    if (!e.buys.length || !e.sells.length) continue;
    const dealers = new Set([...e.buys, ...e.sells].map((q) => q.dealer).filter(Boolean));
    if (dealers.size < 2) continue; // need at least two different desks
    const bucket = tenorBucket(e.tenor);
    const whoAll = [...e.buys, ...e.sells].map((q) => `${q.dealer || ""} ${q.firm || ""}`).join(" ");
    if (!secOk(e.section) || !tenOk(bucket) || !hitsSearch(e.issuer, whoAll)) continue;
    const recent = (arr) => arr.slice().sort((a, b) => tsSeconds(b.timestamp) - tsSeconds(a.timestamp));
    const buysR = recent(e.buys), sellsR = recent(e.sells);
    let buy = buysR[0];
    let sell = sellsR.find((s) => s.dealer && s.dealer !== buy.dealer);
    if (!sell) {
      // The most-recent buyer has no differing seller; try another buyer so the
      // card genuinely shows two DIFFERENT desks (never the same dealer X vs X).
      buy = buysR.find((b) => b.dealer && sellsR.some((s) => s.dealer && s.dealer !== b.dealer)) || buy;
      sell = sellsR.find((s) => s.dealer && s.dealer !== buy.dealer);
    }
    if (!sell) continue; // no genuine two-desk cross
    const size = (isNum(buy.size_cr) ? buy.size_cr : 0) + (isNum(sell.size_cr) ? sell.size_cr : 0);
    const time = tsSeconds(buy.timestamp) >= tsSeconds(sell.timestamp) ? buy.timestamp : sell.timestamp;
    twosided.push({
      type: "twosided", key: `${e.section}|${e.issuer.toLowerCase()}|${e.maturity}`,
      issuer: e.issuer, maturity: e.maturity, section: e.section, bucket, tenor: e.tenor,
      size: size || null, dealer: null, firm: null, time, fresh: isFresh(buy) || isFresh(sell), raw: null,
      _val: size + tsSeconds(time) / 100000, // interest + recency
      headline: "Both sides", sub: "active",
      buy: { level: levelStr(buy), dealer: buy.dealer || "—", raw: buy.raw },
      sell: { level: levelStr(sell), dealer: sell.dealer || "—", raw: sell.raw },
      why: "One desk is bidding and another is offering the same bond — a possible cross.",
      rows: [["Buyer", `${buy.dealer || "—"} @ ${levelStr(buy)}`], ["Seller", `${sell.dealer || "—"} @ ${levelStr(sell)}`]],
    });
  }

  // Strength per category (over the filtered set), strongest first.
  assignStrength(cheap, (o) => o._val); cheap.sort((a, b) => b.strength - a.strength);
  assignStrength(rich, (o) => o._val); rich.sort((a, b) => b.strength - a.strength);
  assignStrength(pickup, (o) => o._val); pickup.sort((a, b) => b.strength - a.strength);
  assignStrength(tight, (o) => o._val, true); tight.sort((a, b) => b.strength - a.strength);
  assignStrength(twosided, (o) => o._val); twosided.sort((a, b) => b.strength - a.strength);

  const counts = { cheap: cheap.length, tight: tight.length, pickup: pickup.length, twosided: twosided.length, rich: rich.length };
  counts.actionable = counts.cheap + counts.tight + counts.pickup + counts.twosided; // rich excluded from "right now"

  // The view. "All" = the strongest across the default categories (not rich),
  // one card per bond, capped to a readable handful; a category = its own list.
  let items;
  if (state.oppCat === "all") {
    const seen = new Set();
    items = [...cheap, ...tight, ...pickup, ...twosided]
      .sort((a, b) => b.strength - a.strength)
      .filter((o) => (seen.has(o.key) ? false : seen.add(o.key)))
      .slice(0, 16);
  } else {
    items = ({ cheap, tight, pickup, twosided, rich }[state.oppCat] || []).slice(0, 24);
  }

  return { total: u.total, withUYT: u.withUYT, govtCurve: u.govtCurve, counts, items };
}

/* --------------------------- Opportunities — UI --------------------------- */

function oppCard(o) {
  const c = OPP_CAT[o.type] || OPP_CAT.cheap;
  const sec = SECTION[o.section] || SECTION.Bonds;
  const fresh = o.fresh ? `<span class="ml-1 inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500 pulse" title="fresh quote"></span>` : "";
  const tip = JSON.stringify({ kind: "opp", title: c.label, rows: o.rows || [], raw: o.raw, buyRaw: o.buy?.raw, sellRaw: o.sell?.raw, accent: c.color });

  const primary = o.type === "twosided"
    ? `<div class="mt-2 grid grid-cols-2 gap-1.5">
         <div class="rounded-lg bg-emerald-50 px-2 py-1.5"><div class="text-[9px] font-bold uppercase tracking-wide text-emerald-600">Buyer</div><div class="nums text-sm font-bold text-emerald-700">${esc(o.buy.level)}</div><div class="truncate text-[10px] text-slate-500">${esc(o.buy.dealer)}</div></div>
         <div class="rounded-lg bg-rose-50 px-2 py-1.5"><div class="text-[9px] font-bold uppercase tracking-wide text-rose-600">Seller</div><div class="nums text-sm font-bold text-rose-700">${esc(o.sell.level)}</div><div class="truncate text-[10px] text-slate-500">${esc(o.sell.dealer)}</div></div>
       </div>`
    : `<div class="mt-2 flex items-baseline gap-1.5"><span class="font-display text-2xl font-extrabold leading-none nums" style="color:${c.colorInk}">${esc(o.headline)}</span><span class="text-[11px] font-semibold text-slate-400">${esc(o.sub || "")}</span></div>`;

  return `
    <div class="opp-card group relative flex flex-col rounded-2xl border border-slate-200 bg-white p-3.5" style="--opp-accent:${c.color}" data-tip="${esc(tip)}">
      <div class="flex items-center gap-2">
        <span class="grid h-7 w-7 shrink-0 place-items-center rounded-lg ${c.bg}"><i data-lucide="${c.icon}" class="h-4 w-4" style="color:${c.color}"></i></span>
        <span class="text-[10px] font-bold uppercase tracking-wide ${c.text}">${c.label}</span>
        <span class="ml-auto rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${sec.chip}">${sec.label}</span>
      </div>
      <div class="mt-2 flex items-center">
        <span class="truncate font-display text-sm font-bold text-slate-800">${esc(o.issuer || "—")}</span>${fresh}
      </div>
      <div class="text-[11px] text-slate-400 nums">${o.maturity ? fmtDate(o.maturity) : "—"}${o.bucket ? " · " + o.bucket : ""}</div>
      ${primary}
      <div class="mt-1.5 flex-1 text-[12px] leading-snug text-slate-500">${esc(c.plain || o.why)}</div>
      <div class="mt-2.5 flex items-center gap-1.5 text-[11px] text-slate-400">
        <span class="nums">${fmtCr(o.size)}</span>
        <span class="text-slate-300">·</span>
        <span class="truncate">${esc(o.dealer || (o.type === "twosided" ? "2 desks" : "—"))}</span>
        <span class="ml-auto nums">${fmtTime(o.time)}</span>
      </div>
      <div class="mt-2 h-1 w-full overflow-hidden rounded-full bg-slate-100"><div class="h-full rounded-full" style="width:${o.strength}%;background:${c.color}"></div></div>
    </div>`;
}

function oppChip(id, label, count, color, inkColor) {
  const active = state.oppCat === id;
  return `<button data-opp-cat="${id}" class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${active ? "text-white shadow-sm" : "text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 hover:text-slate-800"}" style="${active ? `background:${inkColor || color}` : ""}">
    ${esc(label)}<span class="rounded-full px-1.5 text-[10px] ${active ? "bg-white/25" : "bg-slate-100 text-slate-500"}">${count}</span></button>`;
}

function oppSectionSeg() {
  const opt = (v) => {
    const a = state.oppSection === v;
    return `<button data-opp-section="${v}" class="rounded-lg px-3 py-1.5 text-xs font-semibold transition ${a ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-700"}">${v}</button>`;
  };
  return `<div class="inline-flex items-center rounded-xl bg-slate-100/80 p-1">${["All", "Bonds", "Gsec", "DCM"].map(opt).join("")}</div>`;
}

function oppTenorSelect() {
  const opts = ["All", ...TENOR_BUCKETS].map((t) => `<option value="${t}" ${state.oppTenor === t ? "selected" : ""}>${t === "All" ? "All tenors" : t}</option>`).join("");
  return `<select data-opp-tenor class="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 outline-none transition focus:border-indigo-300 focus:ring-2 focus:ring-indigo-200">${opts}</select>`;
}

function oppControls(o) {
  const counts = o ? o.counts : { cheap: 0, tight: 0, pickup: 0, twosided: 0, rich: 0, actionable: 0 };
  const chips =
    oppChip("all", "All", counts.actionable, T.brandInk, T.brandInk) +
    oppChip("cheap", "Cheap (buy)", counts.cheap, OPP_CAT.cheap.color, OPP_CAT.cheap.colorInk) +
    oppChip("tight", "Tight markets", counts.tight, OPP_CAT.tight.color, OPP_CAT.tight.colorInk) +
    oppChip("pickup", "Big pickup", counts.pickup, OPP_CAT.pickup.color, OPP_CAT.pickup.colorInk) +
    oppChip("twosided", "Two-sided", counts.twosided, OPP_CAT.twosided.color, OPP_CAT.twosided.colorInk) +
    oppChip("rich", "Rich (sell)", counts.rich, OPP_CAT.rich.color, OPP_CAT.rich.colorInk);
  return `<div class="mb-3 space-y-2">
    <div class="flex flex-wrap items-center gap-1.5">${chips}</div>
    <div class="flex flex-wrap items-center gap-2">
      ${oppSectionSeg()}${oppTenorSelect()}
      <button class="grid h-8 w-8 place-items-center rounded-lg text-slate-400 ring-1 ring-slate-200 transition hover:text-indigo-600 hover:ring-indigo-200" data-tip="${esc(JSON.stringify({ kind: "oppinfo" }))}" aria-label="How to read Opportunities"><i data-lucide="info" class="h-4 w-4"></i></button>
      <span class="ml-auto text-xs font-semibold text-slate-500">${o ? `${counts.actionable} opportunities right now` : ""}</span>
    </div>
  </div>`;
}

function oppEmpty() {
  return spreadEmpty("No opportunities here", "Nothing meets the alert thresholds for these filters right now. Try “All”, a different section/tenor, or clear the search.", "radar");
}

function oppChrome(bodyHTML, o) {
  const gen = state.data ? fmtGenerated(state.data.generated_at) : null;
  const shown = o && state.oppCat === "all" && o.items.length ? `strongest ${o.items.length} across today` : "";
  return `
    ${oppControls(o)}
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/90 shadow-sm shadow-slate-200/50 backdrop-blur">
      <div class="flex shrink-0 items-center gap-3 border-b border-slate-100 px-4 py-2.5">
        <div class="flex items-center gap-2"><i data-lucide="sparkles" class="h-4 w-4 text-indigo-500"></i><h2 class="font-display text-sm font-bold text-slate-800">Opportunities</h2></div>
        <span class="hidden text-xs text-slate-400 sm:inline">act on the strongest first</span>
        <div class="ml-auto text-xs text-slate-400">${shown}</div>
      </div>
      <div class="scroll-y min-h-0 flex-1 overflow-auto">${bodyHTML}</div>
    </div>
    <div class="mt-2 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-slate-400">
      <span class="inline-flex items-center gap-1"><i data-lucide="calculator" class="h-3 w-3"></i>Scanned live in your browser from quotes.json</span>
      <span class="inline-flex items-center gap-1"><i data-lucide="cpu" class="h-3 w-3"></i>Model: ${esc(state.data?.model || "—")}</span>
      <span class="inline-flex items-center gap-1"><i data-lucide="calendar" class="h-3 w-3"></i>Trading day: ${esc(fmtDay(state.data?.trading_day) || state.data?.trading_day || "—")}</span>
      ${gen ? `<span class="inline-flex items-center gap-1"><i data-lucide="refresh-cw" class="h-3 w-3"></i>Updated ${gen}</span>` : ""}
    </div>`;
}

function renderOppsView() {
  if (state.loading) { els.view.innerHTML = oppChrome(spreadSkeleton(), null); afterRender(); return; }
  if (state.error) { els.view.innerHTML = oppChrome(errorHTML(), null); afterRender(); return; }
  const o = computeOpportunities();
  let body;
  if (o.withUYT === 0 && o.counts.twosided === 0) {
    body = spreadEmpty("No opportunities yet", "Today's quotes don't carry enough yields or two-way markets to scan yet. This fills in as the desk quotes through the day.", "radar");
  } else if (!o.items.length) {
    body = oppEmpty();
  } else {
    body = `<div class="grid gap-3 p-4" style="grid-template-columns:repeat(auto-fill,minmax(248px,1fr))">${o.items.map(oppCard).join("")}</div>`;
  }
  els.view.innerHTML = oppChrome(body, o);
  afterRender();
}

/* =========================================================================
   Desk Pulse — "what's happening on the desk today" overview
   All hand-rolled inline SVG (donut, split bar, activity bars, rankings);
   pure counting, so it works even on a day with few priced quotes.
   ========================================================================= */

/** "HH:MM" from seconds-since-midnight (wraps a day defensively). */
function hhmm(sec) {
  sec = ((Math.round(sec) % 86400) + 86400) % 86400;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const PULSE_BUCKET = 1800;        // 30-minute activity buckets
const PULSE_OTHER = T.n300;       // two-way / note quotes in the issuer split

function computePulse() {
  const quotes = liveDayQuotes(state.data?.quotes || []); // analysis reads the live day only
  const total = quotes.length;

  // --- Section mix (donut).
  const secCount = { Bonds: 0, Gsec: 0, DCM: 0 };
  for (const q of quotes) if (secCount[q.section] != null) secCount[q.section]++;
  const secTotal = secCount.Bonds + secCount.Gsec + secCount.DCM;
  const sections = ["Bonds", "Gsec", "DCM"].map((k) => ({
    key: k, label: SECTION[k].label, color: SECTION[k].dot, count: secCount[k],
    pct: secTotal ? (secCount[k] / secTotal) * 100 : 0,
  }));

  // --- Buy vs Sell balance (directional quotes only; two-way/notes shown apart).
  let buy = 0, sell = 0, twoway = 0, other = 0;
  for (const q of quotes) {
    if (BUY_SIDES.has(q.side)) buy++;
    else if (SELL_SIDES.has(q.side)) sell++;
    else if (q.side === "two_way") twoway++;
    else other++;
  }

  // --- Activity through the day (30-min buckets across the active range).
  const counts = new Map();
  for (const q of quotes) {
    const s = tsSeconds(q.timestamp);
    if (s < 0) continue;
    counts.set(Math.floor(s / PULSE_BUCKET), (counts.get(Math.floor(s / PULSE_BUCKET)) || 0) + 1);
  }
  let timeline = [], withTime = 0, peak = null;
  if (counts.size) {
    const bmin = Math.min(...counts.keys()), bmax = Math.max(...counts.keys());
    for (let b = bmin; b <= bmax; b++) {
      const startSec = b * PULSE_BUCKET, count = counts.get(b) || 0;
      withTime += count;
      const t = { b, startSec, label: hhmm(startSec), endLabel: hhmm(startSec + PULSE_BUCKET), count };
      timeline.push(t);
      if (!peak || count > peak.count) peak = t;
    }
  }

  // --- Most-active issuers (by quote count, with buy/sell split).
  const issMap = new Map();
  for (const q of quotes) {
    const name = (q.issuer || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!issMap.has(key)) issMap.set(key, { name, count: 0, buy: 0, sell: 0, other: 0 });
    const it = issMap.get(key);
    it.count++;
    if (BUY_SIDES.has(q.side)) it.buy++;
    else if (SELL_SIDES.has(q.side)) it.sell++;
    else it.other++;
  }
  const topIssuers = [...issMap.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 10);

  // --- Most-active dealers (by quotes posted).
  const dlrMap = new Map();
  for (const q of quotes) {
    const name = (q.dealer || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!dlrMap.has(key)) dlrMap.set(key, { name, count: 0, firms: new Set() });
    const it = dlrMap.get(key);
    it.count++;
    if (q.firm) it.firms.add(q.firm);
  }
  const topDealers = [...dlrMap.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 10)
    .map((d) => ({ name: d.name, count: d.count, firm: [...d.firms][0] || "" }));

  return {
    total, sections, secTotal, buy, sell, twoway, other,
    timeline, withTime, peak, topIssuers, topDealers,
    stats: { total, dealers: dlrMap.size, issuers: issMap.size },
  };
}

/* --------------------------- Desk Pulse — SVG ----------------------------- */

function pkNote(msg) {
  return `<div class="grid min-h-[120px] place-items-center px-4 text-center text-xs text-slate-400">${esc(msg)}</div>`;
}

/** Donut ring via stroke-dasharray (no arc math); each segment carries a tip. */
function donutSVG(segments, opts = {}) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (!total) return pkNote(opts.empty || "No data yet");
  const size = 180, cx = size / 2, cy = size / 2, r = 62, sw = 24, C = 2 * Math.PI * r;
  let off = 0;
  const rings = segments.filter((s) => s.value > 0).map((s) => {
    const frac = s.value / total, dash = Math.max(0, frac * C - 1.5);
    const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}"
      stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}" stroke-dashoffset="${(-off * C).toFixed(2)}"
      class="pk-seg" style="cursor:pointer" data-tip="${esc(JSON.stringify({ kind: "donutseg", label: s.label, count: s.value, pct: +(frac * 100).toFixed(1), sub: s.sub || "", accent: s.color }))}"></circle>`;
    off += frac;
    return el;
  }).join("");
  return `<svg viewBox="0 0 ${size} ${size}" class="block" style="max-height:184px;margin:0 auto" role="img" aria-label="${esc(opts.aria || "")}">
    <g class="hov" transform="rotate(-90 ${cx} ${cy})">${rings}</g>
    <text x="${cx}" y="${cy - 1}" text-anchor="middle" font-size="27" font-weight="800" fill="${T.ink}" style="font-variant-numeric:tabular-nums;pointer-events:none">${esc(String(opts.centerBig ?? total))}</text>
    <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="10" font-weight="700" fill="${T.n400}" letter-spacing="0.06em" style="pointer-events:none">${esc(opts.centerSmall || "")}</text>
  </svg>`;
}

/** Two-segment balance bar (buy vs sell); white % inside each side. */
function splitBarSVG(buy, sell, opts = {}) {
  const total = buy + sell;
  if (!total) return pkNote("No directional (bid/offer) quotes yet");
  const W = 340, H = 46, r = 12;
  const buyFrac = buy / total, buyW = buyFrac * W;
  const buyPct = Math.round(buyFrac * 100), sellPct = 100 - buyPct;
  const tip = (label, count, pct, sub, accent) => esc(JSON.stringify({ kind: "donutseg", label, count, pct, sub, accent }));
  const buyTxt = buyW > 34 ? `<text x="14" y="${H / 2 + 4.5}" font-size="13" font-weight="800" fill="#fff" style="font-variant-numeric:tabular-nums">${buyPct}%</text>` : "";
  const sellTxt = (W - buyW) > 34 ? `<text x="${W - 14}" y="${H / 2 + 4.5}" text-anchor="end" font-size="13" font-weight="800" fill="#fff" style="font-variant-numeric:tabular-nums">${sellPct}%</text>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" class="hov w-full" style="max-height:50px" role="img" aria-label="${esc(opts.aria || "")}">
    <defs><clipPath id="pkSplitClip"><rect x="0" y="0" width="${W}" height="${H}" rx="${r}"></rect></clipPath></defs>
    <g clip-path="url(#pkSplitClip)">
      <rect x="0" y="0" width="${buyW.toFixed(1)}" height="${H}" fill="${T.buyInk}" class="pk-seg" style="cursor:pointer" data-tip="${tip("Buy interest", buy, buyPct, "bids / buys", T.buy)}"></rect>
      <rect x="${buyW.toFixed(1)}" y="0" width="${(W - buyW).toFixed(1)}" height="${H}" fill="${T.sellInk}" class="pk-seg" style="cursor:pointer" data-tip="${tip("Sell interest", sell, sellPct, "offers / sells", T.sell)}"></rect>
      ${buyTxt}${sellTxt}
      <line x1="${buyW.toFixed(1)}" y1="0" x2="${buyW.toFixed(1)}" y2="${H}" stroke="#fff" stroke-width="2"></line>
    </g>
  </svg>`;
}

/** Activity bars per 30-min bucket; hour x-labels thinned to ~7. */
function timelineSVG(timeline, opts = {}) {
  const n = timeline.length;
  if (!n) return pkNote("No timestamps on today's quotes yet");
  const W = 720, H = 172, pl = 30, pr = 12, pt = 14, pb = 24;
  const plotW = W - pl - pr, plotH = H - pt - pb;
  const maxC = Math.max(1, ...timeline.map((t) => t.count));
  const bw = plotW / n;
  const sy = (c) => pt + plotH - (c / maxC) * plotH;
  const bars = timeline.map((t, i) => {
    const x0 = pl + i * bw, y = sy(t.count), h = pt + plotH - y, pad = Math.min(3, bw * 0.16);
    const tip = esc(JSON.stringify({ kind: "timeline", label: `${t.label}–${t.endLabel}`, count: t.count, accent: T.grad1 }));
    return `<g class="pk-seg" style="cursor:pointer" data-tip="${tip}">
      <rect x="${x0.toFixed(1)}" y="${pt}" width="${bw.toFixed(1)}" height="${plotH}" fill="transparent"></rect>
      <rect x="${(x0 + pad / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - pad).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="url(#pkTimeGrad)"></rect>
    </g>`;
  }).join("");
  const grid = `<line x1="${pl}" y1="${(pt + plotH).toFixed(1)}" x2="${W - pr}" y2="${(pt + plotH).toFixed(1)}" stroke="${T.n200}"></line>
    <line x1="${pl}" y1="${pt}" x2="${W - pr}" y2="${pt}" stroke="${T.n200}" stroke-opacity="0.5"></line>
    <text x="${pl - 6}" y="${pt + 4}" text-anchor="end" font-size="9" fill="${T.n300}" style="font-variant-numeric:tabular-nums">${maxC}</text>`;
  const hours = [];
  timeline.forEach((t, i) => { if (t.startSec % 3600 === 0) hours.push(i); });
  let step = 1; while (hours.length / step > 7) step++;
  const xlabels = hours.filter((_, k) => k % step === 0).map((i) => {
    const cx = pl + (i + 0.5) * bw;
    return `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9.5" fill="${T.n400}">${timeline[i].label}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="hov w-full" style="max-height:190px" role="img" aria-label="${esc(opts.aria || "")}">
    <defs><linearGradient id="pkTimeGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${T.grad2}"></stop><stop offset="100%" stop-color="${T.grad1}"></stop></linearGradient></defs>
    ${grid}${bars}${xlabels}
  </svg>`;
}

/** Horizontal ranking bars. mode "issuer" = stacked buy/sell/other; "dealer" = single. */
function rankBarsSVG(items, mode) {
  const n = items.length;
  if (!n) return pkNote("Nothing to rank yet");
  const W = 384, rowH = 26, top = 4, bot = 4, labelW = 124, valW = 30;
  const H = top + n * rowH + bot, plotR = W - valW;
  const maxV = Math.max(1, ...items.map((it) => it.count));
  const fullTo = (v) => labelW + (v / maxV) * (plotR - labelW);
  const rows = items.map((it, i) => {
    const y = top + i * rowH, cy = y + rowH / 2, barY = y + 5, barH = rowH - 10;
    const end = fullTo(it.count), fullW = Math.max(2, end - labelW);
    let seg, tip;
    if (mode === "issuer") {
      const unit = fullW / Math.max(1, it.count);
      let cx = labelW;
      const push = (val, col) => { if (val <= 0) return ""; const w = val * unit; const s = `<rect x="${cx.toFixed(1)}" y="${barY}" width="${Math.max(0.4, w).toFixed(1)}" height="${barH}" fill="${col}"></rect>`; cx += w; return s; };
      seg = `<defs><clipPath id="pkRankClip${i}"><rect x="${labelW}" y="${barY}" width="${fullW.toFixed(1)}" height="${barH}" rx="3"></rect></clipPath></defs>
        <g clip-path="url(#pkRankClip${i})"><rect x="${labelW}" y="${barY}" width="${fullW.toFixed(1)}" height="${barH}" fill="${T.heatMid}"></rect>${push(it.buy, CHEAP)}${push(it.sell, RICH)}${push(it.other, PULSE_OTHER)}</g>`;
      tip = esc(JSON.stringify({ kind: "rankissuer", name: it.name, count: it.count, buy: it.buy, sell: it.sell, other: it.other, accent: T.grad1 }));
    } else {
      seg = `<rect x="${labelW}" y="${barY}" width="${fullW.toFixed(1)}" height="${barH}" rx="3" fill="url(#pkRankGrad)"></rect>`;
      tip = esc(JSON.stringify({ kind: "rankdealer", name: it.name, count: it.count, firm: it.firm || "", accent: T.grad2 }));
    }
    return `<g class="pk-seg" style="cursor:pointer" data-tip="${tip}">
      <rect x="0" y="${y}" width="${W}" height="${rowH}" fill="transparent"></rect>
      <text x="${labelW - 8}" y="${(cy + 3.5).toFixed(1)}" text-anchor="end" font-size="11" fill="${T.n700}">${esc(trunc(it.name, 16))}</text>
      ${seg}
      <text x="${(end + 5).toFixed(1)}" y="${(cy + 3.5).toFixed(1)}" font-size="10" font-weight="700" fill="${T.n600}" style="font-variant-numeric:tabular-nums">${it.count}</text>
    </g>`;
  }).join("");
  const grad = mode === "dealer" ? `<defs><linearGradient id="pkRankGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="${T.grad1}"></stop><stop offset="100%" stop-color="${T.grad2}"></stop></linearGradient></defs>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" class="hov w-full" role="img" aria-label="${esc(mode === "issuer" ? "Most active issuers by quote count" : "Most active dealers by quotes posted")}">${grad}${rows}</svg>`;
}

/* --------------------------- Desk Pulse — cards --------------------------- */

const pkDot = (c, t) => `<span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-full" style="background:${c}"></span>${esc(t)}</span>`;

function pulseCard({ icon, title, legend, body, span }) {
  return `<section class="pulse-card ${span ? "lg:col-span-2 " : ""}flex flex-col rounded-xl border border-slate-100 bg-white/70 p-3.5">
    <div class="mb-2.5 flex flex-wrap items-center gap-2">
      <i data-lucide="${icon}" class="h-4 w-4 text-indigo-500"></i>
      <h3 class="font-display text-sm font-bold text-slate-700">${esc(title)}</h3>
      ${legend ? `<div class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium text-slate-400">${legend}</div>` : ""}
    </div>
    <div class="flex flex-1 flex-col justify-center">${body}</div>
  </section>`;
}

function pulseBody(p) {
  // 1 — Activity through the day (wide hero).
  const activity = pulseCard({
    icon: "bar-chart-3", title: "Activity through the day", span: true,
    legend: `<span class="inline-flex items-center gap-1"><span class="h-2 w-6 rounded-full" style="background:linear-gradient(90deg,${T.grad2},${T.grad1})"></span>quotes / 30 min</span>${p.peak ? `<span>busiest <b class="text-slate-500 nums">${esc(p.peak.label)}</b> · ${p.peak.count}</span>` : ""}`,
    body: timelineSVG(p.timeline, { aria: "Quotes per 30 minutes through the day" }),
  });

  // 2 — Market split (donut) with a 3-cell breakdown as its legend.
  const msList = `<div class="mt-3 grid grid-cols-3 gap-2">${p.sections.map((s) => `
    <div class="rounded-lg bg-slate-50 px-2 py-1.5 text-center">
      <div class="flex items-center justify-center gap-1"><span class="h-2 w-2 rounded-full" style="background:${s.color}"></span><span class="text-[10px] font-semibold text-slate-500">${esc(s.label)}</span></div>
      <div class="mt-0.5 nums text-sm font-bold text-slate-800">${s.count}</div>
      <div class="nums text-[10px] text-slate-400">${s.pct.toFixed(0)}%</div>
    </div>`).join("")}</div>`;
  const market = pulseCard({
    icon: "pie-chart", title: "Market split",
    body: donutSVG(p.sections.map((s) => ({ label: s.label, value: s.count, color: s.color, sub: "section" })),
      { aria: "Messages by section", centerBig: p.secTotal, centerSmall: "MESSAGES", empty: "No messages yet" }) + msList,
  });

  // 3 — Buy vs Sell balance + a plain-language takeaway.
  const net = p.buy === p.sell ? "balanced" : p.buy > p.sell ? "net BUYING" : "net SELLING";
  const netCol = p.buy > p.sell ? T.buyInk : p.sell > p.buy ? T.sellInk : T.n500;
  const buysell = pulseCard({
    icon: "scale", title: "Buy vs sell balance",
    legend: `${pkDot(CHEAP, "Buy")}${pkDot(RICH, "Sell")}`,
    body: `<div class="flex h-full flex-col justify-center gap-3">
      ${splitBarSVG(p.buy, p.sell, { aria: "Buy versus sell interest" })}
      <div class="flex items-center justify-between gap-2">
        <div><div class="nums text-lg font-extrabold" style="color:${T.buyInk}">${p.buy}</div><div class="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Buy interest</div></div>
        <div class="text-center"><div class="text-[11px] font-bold uppercase tracking-wide" style="color:${netCol}">${net}</div><div class="nums mt-0.5 text-[10px] text-slate-400">${p.twoway} two-way · ${p.other} notes</div></div>
        <div class="text-right"><div class="nums text-lg font-extrabold" style="color:${T.sellInk}">${p.sell}</div><div class="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Sell interest</div></div>
      </div>
    </div>`,
  });

  // 4 — Most-active issuers (stacked buy/sell/other).
  const issuers = pulseCard({
    icon: "building-2", title: "Most-active issuers",
    legend: `${pkDot(CHEAP, "Buy")}${pkDot(RICH, "Sell")}${pkDot(PULSE_OTHER, "2-way / other")}`,
    body: rankBarsSVG(p.topIssuers, "issuer"),
  });

  // 5 — Most-active dealers.
  const dealers = pulseCard({
    icon: "users", title: "Most-active dealers",
    legend: `<span>by quotes posted</span>`,
    body: rankBarsSVG(p.topDealers, "dealer"),
  });

  return `<div class="grid grid-cols-1 gap-3 p-4 lg:grid-cols-2">${activity}${market}${buysell}${issuers}${dealers}</div>`;
}

function pulseStatChips(p) {
  const chip = (icon, label, value) => `<span class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600"><i data-lucide="${icon}" class="h-3 w-3"></i><span class="opacity-70">${label}</span><span class="font-bold nums text-slate-800">${esc(value)}</span></span>`;
  return chip("layers", "Messages", p.stats.total) + chip("users", "Active dealers", p.stats.dealers) + chip("building-2", "Active issuers", p.stats.issuers);
}

function pulseControls(p) {
  return `<div class="mb-3 flex flex-wrap items-center gap-2">
    <button class="grid h-8 w-8 place-items-center rounded-lg text-slate-400 ring-1 ring-slate-200 transition hover:text-indigo-600 hover:ring-indigo-200" data-tip="${esc(JSON.stringify({ kind: "pulseinfo" }))}" aria-label="How to read Desk Pulse"><i data-lucide="info" class="h-4 w-4"></i></button>
    <span class="text-xs font-semibold text-slate-500">Desk overview · today</span>
    <div class="ml-auto flex flex-wrap items-center gap-2">${p ? pulseStatChips(p) : ""}</div>
  </div>`;
}

function pulseSkeleton() {
  const card = (h, span) => `<div class="${span ? "lg:col-span-2 " : ""}rounded-xl border border-slate-100 bg-white/70 p-3.5"><div class="shimmer mb-3 h-4" style="width:40%"></div><div class="shimmer" style="height:${h}px"></div></div>`;
  return `<div class="grid grid-cols-1 gap-3 p-4 lg:grid-cols-2">${card(150, true)}${card(240)}${card(150)}${card(250)}${card(250)}</div>`;
}

function pulseChrome(bodyHTML, p) {
  const gen = state.data ? fmtGenerated(state.data.generated_at) : null;
  const cov = p ? `<span class="font-semibold text-slate-600">${p.total}</span> quotes today` : "";
  return `
    ${pulseControls(p)}
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/90 shadow-sm shadow-slate-200/50 backdrop-blur">
      <div class="flex shrink-0 items-center gap-3 border-b border-slate-100 px-4 py-2.5">
        <div class="flex items-center gap-2"><i data-lucide="activity" class="h-4 w-4 text-indigo-500"></i><h2 class="font-display text-sm font-bold text-slate-800">Desk Pulse</h2></div>
        <span class="hidden text-xs text-slate-400 sm:inline">who's busy and where flow is building</span>
        <div class="ml-auto text-xs text-slate-400">${cov}</div>
      </div>
      <div class="scroll-y min-h-0 flex-1 overflow-auto">${bodyHTML}</div>
    </div>
    <div class="mt-2 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-slate-400">
      <span class="inline-flex items-center gap-1"><i data-lucide="calculator" class="h-3 w-3"></i>Counted live in your browser from quotes.json</span>
      <span class="inline-flex items-center gap-1"><i data-lucide="cpu" class="h-3 w-3"></i>Model: ${esc(state.data?.model || "—")}</span>
      <span class="inline-flex items-center gap-1"><i data-lucide="calendar" class="h-3 w-3"></i>Trading day: ${esc(fmtDay(state.data?.trading_day) || state.data?.trading_day || "—")}</span>
      ${gen ? `<span class="inline-flex items-center gap-1"><i data-lucide="refresh-cw" class="h-3 w-3"></i>Updated ${gen}</span>` : ""}
    </div>`;
}

function renderPulseView() {
  if (state.loading) { els.view.innerHTML = pulseChrome(pulseSkeleton(), null); afterRender(); return; }
  if (state.error) { els.view.innerHTML = pulseChrome(errorHTML(), null); afterRender(); return; }
  const p = computePulse();
  const body = p.total
    ? pulseBody(p)
    : spreadEmpty("No desk activity yet", "Today's quotes haven't loaded yet. This overview fills in as the desk quotes through the day.", "activity");
  els.view.innerHTML = pulseChrome(body, p);
  afterRender();
}

/* =========================================================================
   Render orchestration
   ========================================================================= */

function renderTabs() {
  els.tabs.innerHTML = TABS.map((t) => {
    const active = t.id === state.tab;
    return `<button data-tab="${t.id}"
        class="group relative flex items-center gap-1.5 whitespace-nowrap px-3 py-2.5 text-sm font-semibold transition ${
          active ? "text-slate-900" : "text-slate-500 hover:text-slate-700"
        }">
        <i data-lucide="${t.icon}" class="h-4 w-4 ${active ? "text-indigo-500" : "text-slate-400 group-hover:text-slate-500"}"></i>
        ${esc(t.label)}
        ${t.soon && !active ? `<span class="ml-0.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">soon</span>` : ""}
        <span class="absolute inset-x-2 -bottom-px h-0.5 rounded-full ${active ? "grad-bar" : "bg-transparent"}"></span>
      </button>`;
  }).join("");
}

function renderPill() {
  if (state.loading) {
    els.pillText.textContent = "Connecting…";
    return;
  }
  if (state.error) {
    els.pill.className =
      "inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700";
    els.pill.querySelector("span.pulse")?.style.setProperty("background", T.sell);
    els.pillText.textContent = "Offline";
    return;
  }
  const gen = fmtGenerated(state.data?.generated_at);
  // Date-splitting keeps the board to a single day, so name that day outright.
  // The per-tab footers carry the "updated HH:MM" freshness, so the pill stays short.
  const day = fmtDay(state.data?.trading_day);
  els.pillText.textContent = day
    ? `Desk chat · ${day}`
    : gen
      ? `Latest desk chat · updated ${gen}`
      : "Latest desk chat";
}

function renderView() {
  const view = els.view;
  if (state.tab === "spread") {
    renderSpreadView();
    return;
  }
  if (state.tab === "opps") {
    renderOppsView();
    return;
  }
  if (state.tab === "pulse") {
    renderPulseView();
    return;
  }
  if (state.loading) {
    view.innerHTML = boardChrome(loadingHTML(), null);
    afterRender();
    return;
  }
  if (state.error) {
    view.innerHTML = boardChrome(errorHTML(), null);
    afterRender();
    return;
  }

  const base = filterSectionSearch(state.data.quotes);
  const baseQuotes = base.filter((q) => q.side !== "comment"); // exclude desk chatter
  const totalQuotes = state.data.quotes.reduce((n, q) => n + (q.side !== "comment" ? 1 : 0), 0);
  let count;
  let chatterShown = 0;
  let bodyHTML;
  if (state.grouped) {
    // Grouping is about tradeable bonds — chatter is never grouped. It pools
    // bid/offer per bond into a best bid/offer/spread, which is only meaningful
    // within ONE day; restrict to the live day so a historical quote can never
    // synthesise a cross-day spread. (The flat board still shows every day.)
    let groups = groupBonds(liveDayQuotes(baseQuotes));
    if (state.narrowOnly) groups = groups.filter((g) => narrowGap(g.bestBid, g.bestOffer, g.meaning));
    groups = sortGroups(groups);
    count = groups.length;
    bodyHTML = groups.length ? groupedHTML(groups) : emptyHTML();
  } else {
    let rows = state.showChatter ? base : baseQuotes;
    if (state.narrowOnly) rows = rows.filter(isNarrowRow);
    rows = sortRows(rows);
    count = rows.reduce((n, q) => n + (q.side !== "comment" ? 1 : 0), 0); // count real quotes, not chatter
    chatterShown = rows.length - count;
    bodyHTML = rows.length ? tableHTML(rows) : emptyHTML();
  }

  view.innerHTML = boardChrome(bodyHTML, count, totalQuotes, chatterShown);
  afterRender();
}

function afterRender() {
  window.lucide?.createIcons();
}

function render() {
  renderTabs();
  renderPill();
  renderView();
}

/* =========================================================================
   Data
   ========================================================================= */

async function loadData({ initial = false } = {}) {
  if (initial) {
    state.loading = true;
    state.error = null;
    render();
  }
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json || !Array.isArray(json.quotes)) throw new Error("Malformed quotes file");
    // Defensive: keep only well-formed rows so a stray null/garbage element can
    // never throw mid-render and strand the board on the loading skeleton. The
    // engine already guarantees this shape; this is belt-and-braces.
    json.quotes = json.quotes.filter(
      (q) => q && typeof q === "object" && typeof q.section === "string" && typeof q.side === "string"
    );

    const changed = json.generated_at !== state.lastGeneratedAt;
    state.data = json;
    state.lastGeneratedAt = json.generated_at;
    state.loading = false;
    state.error = null;

    if (initial || changed) {
      render();
      if (!initial && changed) flashUpdated();
    }
  } catch (err) {
    state.loading = false;
    // A failed poll after a good first load shouldn't wipe the board.
    if (!state.data) {
      state.error = String(err.message || err);
    }
    render();
  }
}

function flashUpdated() {
  els.pill.classList.remove("flash");
  void els.pill.offsetWidth; // reflow so the animation restarts
  els.pill.classList.add("flash");
}

/* =========================================================================
   Events
   ========================================================================= */

let searchTimer = null;
els.search.addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => {
    state.search = v;
    if ((state.tab === "live" || state.tab === "spread" || state.tab === "opps") && !state.loading && !state.error) renderView();
  }, 120);
});

els.tabs.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  state.tab = btn.dataset.tab;
  render();
});

// Delegated clicks inside the view (controls, sort, state buttons).
els.view.addEventListener("click", (e) => {
  const spreadViewBtn = e.target.closest("button[data-spread-view]");
  if (spreadViewBtn) {
    state.spreadView = spreadViewBtn.dataset.spreadView;
    renderView();
    return;
  }
  const spreadSecBtn = e.target.closest("button[data-spread-section]");
  if (spreadSecBtn) {
    state.spreadSection = spreadSecBtn.dataset.spreadSection;
    renderView();
    return;
  }
  const oppCatBtn = e.target.closest("button[data-opp-cat]");
  if (oppCatBtn) {
    state.oppCat = oppCatBtn.dataset.oppCat;
    renderView();
    return;
  }
  const oppSecBtn = e.target.closest("button[data-opp-section]");
  if (oppSecBtn) {
    state.oppSection = oppSecBtn.dataset.oppSection;
    renderView();
    return;
  }
  const sectionBtn = e.target.closest("button[data-section]");
  if (sectionBtn) {
    state.section = sectionBtn.dataset.section;
    renderView();
    return;
  }
  const toggle = e.target.closest("button[data-toggle]");
  if (toggle) {
    if (toggle.dataset.toggle === "grouped") state.grouped = !state.grouped;
    if (toggle.dataset.toggle === "narrow") state.narrowOnly = !state.narrowOnly;
    if (toggle.dataset.toggle === "chatter") state.showChatter = !state.showChatter;
    renderView();
    return;
  }
  const sortBtn = e.target.closest("button[data-sort]");
  if (sortBtn) {
    const key = sortBtn.dataset.sort;
    if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else {
      state.sortKey = key;
      state.sortDir = key === "time" ? "desc" : "asc";
    }
    renderView();
    return;
  }
  const action = e.target.closest("button[data-action]");
  if (action) {
    const a = action.dataset.action;
    if (a === "reset") {
      state.section = "All";
      state.search = "";
      els.search.value = "";
      state.narrowOnly = false;
      renderView();
    } else if (a === "retry") {
      loadData({ initial: true });
    }
  }
});

/* Custom tooltip showing the original raw chat line (delegated on the view). */
function positionTooltip(e) {
  const t = els.tooltip;
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const r = t.getBoundingClientRect();
  if (x + r.width + 8 > window.innerWidth) x = e.clientX - r.width - pad;
  if (y + r.height + 8 > window.innerHeight) y = e.clientY - r.height - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}

/* Tenor dropdowns + the ONE shared tooltip for every chart AND table (Live
   Board rows, heatmap cells, peer bars, curve dots, donut/activity/ranking
   segments, opportunity cards, the info buttons). The payload is JSON in a
   data-tip attribute; the HTML is built at hover time with esc() on every
   dynamic field, and the tooltip's colour cap is set from the payload accent. */
els.view.addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-spread-tenor]");
  if (sel) {
    state.spreadTenor = sel.value;
    renderView();
  }
  const oppSel = e.target.closest("select[data-opp-tenor]");
  if (oppSel) {
    state.oppTenor = oppSel.value;
    renderView();
  }
});

els.view.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip]");
  if (!el) return;
  let obj;
  try { obj = JSON.parse(el.dataset.tip); } catch { return; }
  els.tooltip.innerHTML = renderTip(obj);
  els.tooltip.style.setProperty("--tt-accent", obj.accent || T.grad2);
  els.tooltip.classList.add("show");
  positionTooltip(e);
});
els.view.addEventListener("mousemove", (e) => {
  if (els.tooltip.classList.contains("show") && e.target.closest("[data-tip]")) positionTooltip(e);
});
els.view.addEventListener("mouseout", (e) => {
  const el = e.target.closest("[data-tip]");
  if (el && !el.contains(e.relatedTarget)) els.tooltip.classList.remove("show");
});

/* =========================================================================
   Boot
   ========================================================================= */

render(); // paint the loading skeleton immediately
loadData({ initial: true });
setInterval(() => {
  // Poll quietly in the background; only re-renders if generated_at changed.
  if (!document.hidden) loadData();
}, POLL_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadData();
});
