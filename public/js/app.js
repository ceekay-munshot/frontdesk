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

const TABS = [
  { id: "live", label: "Live Board", icon: "layout-list" },
  { id: "spread", label: "Spread Watch", icon: "git-compare-arrows" },
  { id: "opps", label: "Opportunities", icon: "sparkles", soon: true, blurb: "Switches, narrow two-ways and rich/cheap ideas surfaced automatically." },
  { id: "pulse", label: "Desk Pulse", icon: "activity", soon: true, blurb: "Who is quoting what, how busy each section is, and where flow is building." },
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
const SPREAD_COOL = "#3b82f6"; // tight  (little pickup)
const SPREAD_MID = "#eef2f6";  // typical (median)
const SPREAD_WARM = "#10b981"; // wide   (more pickup, attractive)
const CHEAP = "#10b981";
const RICH = "#f43f5e";

const SECTION = {
  Bonds: { label: "Bonds", dot: "#6366f1", acc: "acc-bonds", chip: "bg-indigo-50 text-indigo-700 border border-indigo-200" },
  Gsec: { label: "Gsec", dot: "#10b981", acc: "acc-gsec", chip: "bg-emerald-50 text-emerald-700 border border-emerald-200" },
  DCM: { label: "DCM", dot: "#f59e0b", acc: "acc-dcm", chip: "bg-amber-50 text-amber-700 border border-amber-200" },
};

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
  sortKey: "time", // "time" | "maturity"
  sortDir: "desc", // "asc" | "desc"
  lastGeneratedAt: null,
  // Spread Watch
  spreadView: "govt", // "govt" | "peers"
  spreadSection: "All", // "All" | "Bonds" | "DCM"
  spreadTenor: "All", // "All" | one of TENOR_BUCKETS
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

/** HH:MM from an ISO generated_at that already carries +05:30. */
function fmtGenerated(iso) {
  const m = /T(\d{2}:\d{2})/.exec(iso || "");
  return m ? m[1] : null;
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

/** A tight bid-offer? Yields are close in absolute terms (<=0.06), prices wider (<=5). */
function narrowGap(bid, offer, meaning) {
  if (!isNum(bid) || !isNum(offer)) return false;
  const gap = offer - bid;
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
    const key = `${(q.issuer || "—").toLowerCase()}||${q.maturity || ""}`;
    if (!map.has(key)) {
      map.set(key, { issuer: q.issuer, maturity: q.maturity, tenor: q.tenor_years, section: q.section, coupon: q.coupon, instrument: q.instrument_type, items: [] });
    }
    map.get(key).items.push(q);
  }
  const groups = [];
  for (const g of map.values()) {
    const bids = [];
    const offers = [];
    let anyYield = false;
    for (const q of g.items) {
      if (q.level_meaning === "yield") anyYield = true;
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
    const meaning = anyYield ? "yield" : "price_or_spread";
    const spread = bestBid != null && bestOffer != null ? Math.round((bestOffer - bestBid) * 100) / 100 : null;
    groups.push({ ...g, bestBid, bestOffer, spread, meaning, count: g.items.length });
  }
  return groups;
}

function sortGroups(groups) {
  const order = { Bonds: 0, Gsec: 1, DCM: 2 };
  const dir = state.sortDir === "asc" ? 1 : -1;
  return groups.slice().sort((a, b) => {
    if (order[a.section] !== order[b.section]) return order[a.section] - order[b.section];
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
      ${dot("#10b981", "Bid")}${dot("#f43f5e", "Offer")}${dot("#8b5cf6", "2-way")}
      <span class="inline-flex items-center gap-1"><span class="h-2 w-2 rounded-sm bg-amber-400"></span>Narrow</span>
    </div>`;
}

function sectionSummary() {
  if (!state.data) return "";
  const c = { Bonds: 0, Gsec: 0, DCM: 0 };
  for (const q of state.data.quotes) c[q.section]++;
  return `${c.Bonds} Bonds · ${c.Gsec} Gsec · ${c.DCM} DCM`;
}

/** The board: controls + a fixed-height card whose body scrolls internally + a slim provenance footer. */
function boardChrome(bodyHTML, count) {
  const total = state.data ? state.data.quotes.length : 0;
  const showing = count == null ? "" : `<span class="font-semibold text-slate-600">${count}</span> of ${total} quotes`;
  const gen = state.data ? fmtGenerated(state.data.generated_at) : null;
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
      <span class="inline-flex items-center gap-1"><i data-lucide="calendar" class="h-3 w-3"></i>Trading day: ${esc(state.data?.trading_day || "—")}</span>
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

  const body = rows.map(rowHTML).join("");
  return `<table class="w-full min-w-[880px] border-collapse text-sm">${COLGROUP}${head}<tbody>${body}</tbody></table>`;
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

  return `
    <tr class="qrow ${narrow ? "narrow-glow" : sec.acc} border-b border-slate-100 cursor-default"
        data-raw="${esc(q.raw)}" data-dealer="${esc(q.dealer || "")}" data-firm="${esc(q.firm || "")}" data-time="${esc(q.timestamp || "")}">
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

function placeholderHTML(tabId) {
  const t = TABS.find((x) => x.id === tabId) || {};
  return `
    <div class="grid min-h-0 flex-1 place-items-center">
      <div class="max-w-md rounded-2xl border border-dashed border-slate-300 bg-white/70 px-8 py-12 text-center backdrop-blur">
        <div class="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl grad-bar shadow-lg shadow-indigo-500/25">
          <i data-lucide="${esc(t.icon || "sparkles")}" class="h-8 w-8 text-white"></i>
        </div>
        <div class="mb-2 inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">
          <i data-lucide="clock" class="h-3 w-3"></i>Coming next
        </div>
        <h2 class="font-display text-xl font-extrabold text-slate-800">${esc(t.label || "")}</h2>
        <p class="mx-auto mt-2 max-w-xs text-sm text-slate-500">${esc(t.blurb || "This tab is on the way.")}</p>
        <button data-action="goLive" class="mt-6 inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700">
          <i data-lucide="layout-list" class="h-4 w-4"></i>Back to Live Board
        </button>
      </div>
    </div>`;
}

/* =========================================================================
   Spread Watch — computation (all in the browser, from quotes.json)
   ========================================================================= */

const trunc = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

/** Usable yield for a quote: q.yield, else the mid of a yield two-way, else null. */
function usableYield(q) {
  if (isNum(q.yield)) return q.yield;
  if (q.side === "two_way" && isNum(q.bid) && isNum(q.offer) && q.level_meaning === "yield") return (q.bid + q.offer) / 2;
  return null;
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
function buildGovtCurve(enriched) {
  const byTenor = new Map();
  for (const e of enriched) {
    if (e.section !== "Gsec") continue;
    if (!(e.tenor > 0 && e.tenor <= 50)) continue; // ignore implausible tenors (bad LLM data)
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
 * The one compute pass Spread Watch renders from. Curve and peer medians are
 * built over the FULL day; the section/search/tenor controls only filter what
 * is displayed. Returns coverage counts, the curve, heatmap rows, peer bonds,
 * and the headline stats.
 */
function computeSpread() {
  const quotes = state.data?.quotes || [];
  const total = quotes.length;

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

  // ---- Peers: aggregate corp quotes -> bonds (issuer+maturity), median yield,
  //      then peer median over bonds sharing a section + tenor bucket.
  const bondMap = new Map();
  for (const e of corp) {
    const key = `${e.section}||${e.issuer.toLowerCase()}||${e.maturity}`;
    if (!bondMap.has(key)) bondMap.set(key, { issuer: e.issuer, maturity: e.maturity, section: e.section, tenor: e.tenor, bucket: e.bucket, uys: [], sizes: [], who: new Set() });
    const b = bondMap.get(key);
    b.uys.push(e.uy);
    if (isNum(e.q.size_cr)) b.sizes.push(e.q.size_cr);
    if (e.q.dealer) b.who.add(e.q.dealer);
    if (e.q.firm) b.who.add(e.q.firm);
  }
  const bonds = [...bondMap.values()].map((b) => ({ issuer: b.issuer, maturity: b.maturity, section: b.section, tenor: b.tenor, bucket: b.bucket, uy: median(b.uys), n: b.uys.length, size: b.sizes.length ? Math.max(...b.sizes) : null, who: [...b.who].join(" ").toLowerCase() }));
  const peerGroups = new Map();
  for (const b of bonds) {
    const k = `${b.section}||${b.bucket}`;
    if (!peerGroups.has(k)) peerGroups.set(k, []);
    peerGroups.get(k).push(b.uy);
  }
  for (const b of bonds) {
    const pm = median(peerGroups.get(`${b.section}||${b.bucket}`));
    b.peerMedian = pm;
    b.gap = pm != null ? Math.round((b.uy - pm) * 100) : null;
  }

  // ---- Heatmap: per corp quote, spread vs govt; median per issuer x bucket.
  let issuerRows = [];
  if (govtCurve) {
    // Keys include section so an issuer that trades BOTH Bonds and DCM keeps two
    // separate rows (one section's yields never contaminate the other's).
    const cellMap = new Map(); // section|||issuer|||bucket -> observations
    const issuerAgg = new Map(); // section|||issuer -> {issuer, section, who}
    for (const e of corp) {
      const gy = govtYieldAt(govtCurve, e.tenor);
      if (gy == null) continue;
      const spread = Math.round((e.uy - gy) * 100);
      const ck = `${e.section}|||${e.issuer}|||${e.bucket}`;
      if (!cellMap.has(ck)) cellMap.set(ck, []);
      cellMap.get(ck).push({ spread, corpY: e.uy, govtY: gy });
      const ik = `${e.section}|||${e.issuer}`;
      if (!issuerAgg.has(ik)) issuerAgg.set(ik, { issuer: e.issuer, section: e.section, who: new Set() });
      const ia = issuerAgg.get(ik);
      if (e.q.dealer) ia.who.add(e.q.dealer);
      if (e.q.firm) ia.who.add(e.q.firm);
    }
    issuerRows = [...issuerAgg.values()].map((it) => {
      const cells = {};
      for (const bk of TENOR_BUCKETS) {
        const obs = cellMap.get(`${it.section}|||${it.issuer}|||${bk}`);
        if (obs && obs.length) {
          // The cell shows the MEDIAN OBSERVATION (a real quote), so its corp and
          // govt yields reproduce exactly the spread on the tile.
          const s = obs.slice().sort((a, b) => a.spread - b.spread);
          const mid = s[Math.floor((s.length - 1) / 2)];
          cells[bk] = { median: mid.spread, n: obs.length, corpY: mid.corpY, govtY: mid.govtY };
        }
      }
      const vals = Object.values(cells).map((c) => c.median);
      const avgSpread = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
      return { issuer: it.issuer, section: it.section, who: [...it.who].join(" ").toLowerCase(), avgSpread, cells };
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
  rows.sort((a, b) => b.avgSpread - a.avgSpread);

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

  return { total, withUY, withUYT, govtCurve, rows, buckets, gridStats, bonds: dispBonds, avgPickup, widest, cheapest, richest };
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
  const row = (k, v) => `<div style="display:flex;justify-content:space-between;gap:18px"><span style="color:#94a3b8">${k}</span><span style="font-variant-numeric:tabular-nums">${v}</span></div>`;
  if (o.kind === "info") {
    return `${L("How to read Spread Watch")}<div style="line-height:1.55">
      <b>Yield</b> = the return a bond pays. <b>Spread</b> = the EXTRA yield over a benchmark.
      <div style="margin-top:6px"><b style="color:#a5b4fc">vs Government</b> — extra yield over the government curve at the same maturity. Bigger = the bond is "cheaper" (pays more) = more attractive to buy.</div>
      <div style="margin-top:4px"><b style="color:#6ee7b7">vs Peers</b> — how a bond's yield compares to other bonds of similar maturity. Above the group = cheap (buy); below = rich (expensive).</div></div>`;
  }
  if (o.kind === "curve") return `${L("Government curve")}${row("Tenor", o.t + "y")}${row("Govt yield", o.y.toFixed(2) + "%")}`;
  if (o.kind === "cell") return `${L("Pickup over government")}<div style="font-weight:600;margin-bottom:4px">${esc(o.issuer)}</div>${row("Tenor bucket", o.bucket)}${row("Median spread", fmtBps(o.spread) + " bps")}${row("Corp yield", o.corpY.toFixed(2) + "%")}${row("Govt yield", o.govtY.toFixed(2) + "%")}${row("Backed by", o.n + (o.n === 1 ? " quote" : " quotes"))}`;
  if (o.kind === "bar") return `${L(o.gap >= 0 ? "Cheaper than peers (buy)" : "Richer than peers")}<div style="font-weight:600;margin-bottom:4px">${esc(o.issuer)}${o.maturity ? ` · ${fmtDate(o.maturity)}` : ""}</div>${row("Its yield", o.uy.toFixed(2) + "%")}${row("Peer median", o.peer.toFixed(2) + "%")}${row("Gap", fmtBps(o.gap, true) + " bps")}${o.size != null ? row("Size", "₹" + fmtNum(o.size) + " cr") : ""}`;
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
  for (let t = 0; t <= maxT; t += step) xg += `<line x1="${sx(t).toFixed(1)}" y1="${pt}" x2="${sx(t).toFixed(1)}" y2="${H - pb}" stroke="#eef2f6"/><text x="${sx(t).toFixed(1)}" y="${H - pb + 15}" text-anchor="middle" font-size="10" fill="#94a3b8">${t}y</text>`;
  const ymid = (dMin + dMax) / 2;
  const yg = [dMin, ymid, dMax].map((v) => `<line x1="${pl}" y1="${sy(v).toFixed(1)}" x2="${W - pr}" y2="${sy(v).toFixed(1)}" stroke="#f1f5f9"/><text x="${pl - 6}" y="${(sy(v) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#94a3b8">${v.toFixed(2)}</text>`).join("");
  const dots = curve.map((p) => {
    const tip = JSON.stringify({ kind: "curve", t: p.t, y: p.y });
    return `<circle cx="${sx(p.t).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4" fill="#6366f1"/><circle cx="${sx(p.t).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="12" fill="transparent" data-tip="${esc(tip)}" style="cursor:pointer"/>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="w-full" style="max-height:220px" role="img" aria-label="Government yield curve: yield by tenor">
    <defs><linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6366f1" stop-opacity="0.22"/><stop offset="100%" stop-color="#6366f1" stop-opacity="0"/></linearGradient></defs>
    ${xg}${yg}
    <path d="${area}" fill="url(#curveFill)"/>
    <path d="${line}" fill="none" stroke="#6366f1" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
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
  const hdr = `<text x="${(zeroX + half / 2).toFixed(0)}" y="13" text-anchor="middle" font-size="10" font-weight="600" fill="#059669">cheaper → (buy)</text><text x="${(zeroX - half / 2).toFixed(0)}" y="13" text-anchor="middle" font-size="10" font-weight="600" fill="#e11d48">← richer</text>`;
  const zero = `<line x1="${zeroX.toFixed(1)}" y1="${top - 2}" x2="${zeroX.toFixed(1)}" y2="${H - bot}" stroke="#cbd5e1" stroke-dasharray="3 3"/>`;
  const bars = shown.map((b, i) => {
    const y = top + i * rowH, cy = y + rowH / 2;
    const x2 = bx(b.gap), left = Math.min(zeroX, x2), w = Math.max(2, Math.abs(x2 - zeroX));
    const col = b.gap >= 0 ? CHEAP : RICH;
    const valX = b.gap >= 0 ? x2 + 4 : x2 - 4, anchor = b.gap >= 0 ? "start" : "end";
    const tip = JSON.stringify({ kind: "bar", issuer: b.issuer, maturity: b.maturity, uy: +b.uy.toFixed(2), peer: +b.peerMedian.toFixed(2), gap: b.gap, size: b.size });
    return `<g data-tip="${esc(tip)}" style="cursor:pointer">
      <rect x="0" y="${y}" width="${W}" height="${rowH}" fill="transparent"/>
      <text x="${labelW - 10}" y="${(cy + 3.5).toFixed(1)}" text-anchor="end" font-size="11" fill="#334155">${esc(trunc(b.issuer, 22))}</text>
      <rect x="${left.toFixed(1)}" y="${y + 4}" width="${w.toFixed(1)}" height="${rowH - 8}" rx="3" fill="${col}"/>
      <text x="${valX.toFixed(1)}" y="${(cy + 3.5).toFixed(1)}" text-anchor="${anchor}" font-size="10" font-weight="600" fill="${b.gap >= 0 ? "#047857" : "#be123c"}">${fmtBps(b.gap, true)}</text>
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="w-full" role="img" aria-label="Bond yield vs peer median, cheapest to richest">${hdr}${zero}${bars}</svg>`;
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
      const tip = JSON.stringify({ kind: "cell", issuer: r.issuer, bucket: bk, spread: c.median, corpY: +c.corpY.toFixed(2), govtY: +c.govtY.toFixed(2), n: c.n });
      return `<td class="px-1.5 py-1.5 text-right"><span class="inline-block w-full rounded-md px-2 py-1 text-right text-xs font-bold nums" style="background:${bg};color:${textOn(bg)}" data-tip="${esc(tip)}">${fmtBps(c.median)}</span></td>`;
    }).join("");
    return `<tr class="heat-row border-b border-slate-100">
      <td class="heat-issuer sticky left-0 z-10 bg-white px-3 py-1.5">
        <div class="flex items-center gap-1.5"><span class="truncate font-semibold text-slate-800" style="max-width:190px">${esc(r.issuer)}</span>
        <span class="rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${sec.chip}">${sec.label}</span></div>
        <div class="text-[10px] text-slate-400 nums">avg ${fmtBps(r.avgSpread)} bps</div>
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
  const cov = c ? `<span class="font-semibold text-slate-600">${c.withUYT}</span> of ${c.total} quotes carry a usable yield + tenor` : "";
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
      <span class="inline-flex items-center gap-1"><i data-lucide="calendar" class="h-3 w-3"></i>Trading day: ${esc(state.data?.trading_day || "—")}</span>
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
    els.pill.querySelector("span.pulse")?.style.setProperty("background", "#f43f5e");
    els.pillText.textContent = "Offline";
    return;
  }
  const gen = fmtGenerated(state.data?.generated_at);
  els.pillText.textContent = gen ? `Live · updated ${gen}` : "Live";
}

function renderView() {
  const view = els.view;
  if (state.tab === "spread") {
    renderSpreadView();
    return;
  }
  if (state.tab !== "live") {
    view.innerHTML = placeholderHTML(state.tab);
    afterRender();
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
  let count;
  let bodyHTML;
  if (state.grouped) {
    let groups = groupBonds(base);
    if (state.narrowOnly) groups = groups.filter((g) => narrowGap(g.bestBid, g.bestOffer, g.meaning));
    groups = sortGroups(groups);
    count = groups.length;
    bodyHTML = groups.length ? groupedHTML(groups) : emptyHTML();
  } else {
    let rows = base;
    if (state.narrowOnly) rows = rows.filter(isNarrowRow);
    rows = sortRows(rows);
    count = rows.length;
    bodyHTML = rows.length ? tableHTML(rows) : emptyHTML();
  }

  view.innerHTML = boardChrome(bodyHTML, count);
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
    if ((state.tab === "live" || state.tab === "spread") && !state.loading && !state.error) renderView();
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
    } else if (a === "goLive") {
      state.tab = "live";
      render();
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

els.view.addEventListener("mouseover", (e) => {
  const row = e.target.closest("tr[data-raw]");
  if (!row) return;
  const meta = [row.dataset.dealer, row.dataset.firm].filter(Boolean).join(" · ");
  const time = row.dataset.time ? ` · ${row.dataset.time}` : "";
  els.tooltip.innerHTML =
    `<div class="tt-label">Original line</div>${esc(row.dataset.raw)}` +
    (meta ? `<div class="tt-label" style="margin-top:6px">${esc(meta)}${esc(time)}</div>` : "");
  els.tooltip.classList.add("show");
  positionTooltip(e);
});
els.view.addEventListener("mousemove", (e) => {
  if (els.tooltip.classList.contains("show") && e.target.closest("tr[data-raw]")) positionTooltip(e);
});
els.view.addEventListener("mouseout", (e) => {
  const row = e.target.closest("tr[data-raw]");
  if (row && !row.contains(e.relatedTarget)) els.tooltip.classList.remove("show");
});

/* Spread Watch: tenor dropdown + rich [data-tip] tooltips (heatmap cells, bars,
   curve dots, the info button). The payload is JSON in the attribute; the HTML
   is built at hover time with esc() on every dynamic field. */
els.view.addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-spread-tenor]");
  if (sel) {
    state.spreadTenor = sel.value;
    renderView();
  }
});

els.view.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip]");
  if (!el) return;
  let obj;
  try { obj = JSON.parse(el.dataset.tip); } catch { return; }
  els.tooltip.innerHTML = renderTip(obj);
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
