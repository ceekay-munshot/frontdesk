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
  { id: "spread", label: "Spread Watch", icon: "git-compare-arrows", soon: true, blurb: "Bid-offer spreads per bond, widest and tightest, at a glance." },
  { id: "opps", label: "Opportunities", icon: "sparkles", soon: true, blurb: "Switches, narrow two-ways and rich/cheap ideas surfaced automatically." },
  { id: "pulse", label: "Desk Pulse", icon: "activity", soon: true, blurb: "Who is quoting what, how busy each section is, and where flow is building." },
];

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
    if (state.tab === "live" && !state.loading && !state.error) renderView();
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
