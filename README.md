# The Front Desk — Bond Dealing Desk Dashboard

A live, auto-updating board of bond dealing-desk quotes for an Indian brokerage.

All day, bond dealers post quotes in a Reuters/RM group chat — *"I want to buy/sell
this bond at this price."* A junior trader pastes those messages into a shared
Google Doc. The messages are messy shorthand and scroll away fast. **The Front Desk**
reads that Google Doc automatically, uses an LLM to clean the messy lines into
structured rows, and shows them on one clean, colorful board a dealer can glance at
and act on. When the doc updates, the board updates — no manual work.

> **Phase 1** (this repo) ships the **live data engine** and the **Live Board** tab.
> Spread Watch, Opportunities, and Desk Pulse are stubbed as "Coming next" and land
> in later phases.

---

## How it works

The system is two decoupled halves that meet at a single file, `public/data/quotes.json`.
There is **no build step** anywhere.

```
                       ┌──────────────────────────────────────────────┐
                       │  A) DATA ENGINE  (GitHub Action, every 10m)   │
                       │                                               │
  Google Doc  ──txt──▶ │  parse-quotes.mjs                            │
  (link-shared,        │    1. fetch the doc export                    │
   no login)           │    2. split into Bonds / Gsec / DCM           │
                       │    3. track dealer per line                   │
                       │    4. LLM cleans → strict JSON  (llm.mjs)     │
                       │    5. validate, drop junk                     │
                       │                                               │
                       │        writes ▼                               │
                       │   public/data/quotes.json  ──git commit──┐    │
                       └──────────────────────────────────────────┼────┘
                                                                  │
                                              push to main        │
                                                                  ▼
                       ┌──────────────────────────────────────────────┐
                       │  B) FRONTEND  (Cloudflare Pages, static)      │
                       │                                               │
                       │  index.html + js/app.js  ──fetch──▶ quotes.json│
                       │    renders the Live Board, polls for updates  │
                       └──────────────────────────────────────────────┘
```

- **A) Data engine** — a scheduled GitHub Action (`.github/workflows/refresh-quotes.yml`)
  runs `scripts/parse-quotes.mjs`, which fetches the Google Doc, cleans it with an LLM,
  and commits `public/data/quotes.json` back to the branch. Node 22, ESM, zero npm
  dependencies (global `fetch`).
- **B) Frontend** — a pure static site (`public/`) that reads `public/data/quotes.json`
  and renders the board. No framework, no bundler. Tailwind + Lucide + Google Fonts
  over CDN. Cloudflare Pages auto-deploys on push to `main`.

The LLM client (`scripts/llm.mjs`, `scripts/check-llm.mjs`) is copied **verbatim** from
the sibling repo [`dakshamconcall`](https://github.com/ceekay-munshot/dakshamconcall)
(`screener-test/`). It talks to **Claude via Amazon Bedrock** (primary, model chain
`anthropic.claude-sonnet-5` → `anthropic.claude-opus-4-8`) with **automatic OpenAI
fallback**, streaming, strict JSON-schema structured output, retries, and `max_tokens`
auto-growth. The parser imports `llmStructured()`, `activeModel()`, and `llmBanner()`
and changes nothing inside it.

---

## The data source

A public, link-shared Google Doc (no login), fetched via its plain-text export:

```
https://docs.google.com/document/d/11e0cnpJhjqCZJj3LMOF88oYZUGTwYCpZtKX6zVErU_4/export?format=txt
```

The doc has three sections, each marked by a bare line `Bonds`, `Gsec`, or `DCM`:

| Section   | What it holds                              |
| --------- | ------------------------------------------ |
| **Bonds** | Corporate NCDs (the default until a marker)|
| **Gsec**  | Government securities (G-Sec, SDL, T-Bills) |
| **DCM**   | Money-market: CP / CD                       |

Under each section, a **dealer header** line — a person's name plus their firm, e.g.
`Sunita Patil Lkp Securities Ltd.` — owns every quote line beneath it until the next
header. The parser detects headers as digit-free lines that name a broking firm and end
in a corporate suffix, which is what keeps bond issuers (`Tata Capital Ltd. 8.01% …`,
which carry numbers) from being mistaken for headers.

**Safety rails ("reject-bad-keep-old").** If the doc is unreachable or empty, has no
quote-like lines, or the model returns zero valid rows, the engine **leaves the existing
`quotes.json` untouched** and exits 0 with a warning. A bad run never blanks the board.
The committed seed file also means the site shows data before the first Action run, and
if the doc is ever unreachable.

### Inspect the parse without spending a paisa

```bash
node scripts/parse-quotes.mjs --dry     # or: DRY_RUN=1 node scripts/parse-quotes.mjs
```

A dry run fetches the live doc, prints which sections it found and how many lines each,
how many LLM chunks it would send, and a sample of the annotated transcript — **without
calling the LLM**, so no key is required.

_Last dry run against the live doc found all three sections:_ **Bonds (472 lines),
Gsec (124 lines), DCM (334 lines)** → 930 quote lines → 4 LLM chunks.

---

## GitHub Action secrets

Set these in **Settings → Secrets and variables → Actions**. They use the **same names
as `dakshamconcall`**, so the same values work in both repos.

| Secret              | Required?   | Purpose                                                             |
| ------------------- | ----------- | ------------------------------------------------------------------ |
| `BEDROCK_API_KEY`   | **Yes**\*   | Bearer token for Claude via Amazon Bedrock (the primary provider). |
| `BEDROCK_REGION`    | Optional    | Bedrock region. Defaults to `us-east-1`.                            |
| `BEDROCK_MODEL`     | Optional    | Pin one model instead of the default chain. Blank = the chain.     |
| `LLM_PROVIDER`      | Optional    | `openai` to flip OpenAI to primary. Blank = Bedrock first.         |
| `OPENAI_API_KEY`    | Optional\*  | Enables the automatic OpenAI fallback (and primary if flipped).    |
| `OPENAI_MODEL`      | Optional    | OpenAI model. `llm.mjs` defaults to `gpt-4o`.                       |
| `FIRECRAWL_API_KEY` | Optional    | Firecrawl fallback fetch (unused by the doc export; wired for parity). |

\* At least one of `BEDROCK_API_KEY` / `OPENAI_API_KEY` must be set. Bedrock is primary;
OpenAI is the automatic backup so a single dead key never kills a run.

The workflow runs a **preflight** (`node scripts/check-llm.mjs`) before parsing: one tiny
structured call that fails fast — in seconds — if the key is bad, and logs which provider
and model answered.

### Schedule

```
cron: "*/10 3-12 * * 1-5"   # every 10 min, 03:00–12:59 UTC (≈08:30–18:30 IST), Mon–Fri
```

Plus a manual **workflow_dispatch** trigger (with an optional `bedrock_model` input to
A/B a model for one run). A `concurrency` group prevents overlapping runs from colliding,
and the push uses a 4-attempt `git pull --rebase` loop so a refresh that races another
commit still lands.

---

## The `quotes.json` contract

`public/data/quotes.json` is the single interface between the engine and every tab
(now and in later phases). Its shape:

```jsonc
{
  "generated_at": "2026-08-19T09:35:00+05:30", // ISO-8601, +05:30 (IST)
  "source":       "https://docs.google.com/.../export?format=txt",
  "trading_day":  "2026-08-19",                // IST date the run used for tenor math
  "quote_count":  26,
  "model":        "anthropic.claude-sonnet-5", // activeModel() that produced it ("seed" for the seed file)
  "quotes":       [ /* Quote[] — see below */ ]
}
```

Each **Quote** (the LLM output schema is strict: `additionalProperties:false`, every
field required, nullable fields typed as `["type","null"]`):

| Field             | Type                | Notes                                                                             |
| ----------------- | ------------------- | --------------------------------------------------------------------------------- |
| `id`              | string              | Deterministic `q1`, `q2`, … reassigned in code so it's unique across chunks.       |
| `dealer`          | string \| null      | Person who posted the quote.                                                       |
| `firm`            | string \| null      | Their firm.                                                                        |
| `section`         | `"Bonds"\|"Gsec"\|"DCM"` | Which desk section.                                                           |
| `issuer`          | string \| null      | Bond issuer / entity.                                                              |
| `instrument_type` | string \| null      | e.g. `NCD`, `SDL`, `GS`, `T-Bill`, `CP`, `CD`.                                     |
| `coupon`          | number \| null      | Stated coupon %, e.g. `7.3`.                                                       |
| `maturity`        | string \| null      | ISO `YYYY-MM-DD` when parseable from messy dates (`01DEC27`, `31/8/2026`, …).       |
| `tenor_years`     | number \| null      | Years from `trading_day` to `maturity`, 1 decimal.                                 |
| `side`            | `bid\|offer\|two_way\|buy\|sell\|ask\|comment` | Direction of the quote.                                |
| `bid`             | number \| null      | Two-way bid.                                                                       |
| `offer`           | number \| null      | Two-way offer.                                                                     |
| `level`           | number \| null      | A bare number before OFFER/BID with no other meaning.                             |
| `level_meaning`   | `size_cr\|price\|yield\|spread_bps\|price_or_spread\|unknown` | How to read `level`/two-ways.         |
| `size_cr`         | number \| null      | Deal size in ₹ crore (a number followed by `cr`/`crs`).                            |
| `yield`           | number \| null      | A `@ 6.35`-style or standalone yield.                                             |
| `timestamp`       | string \| null      | The chat `HH:MM:SS` if present.                                                    |
| `flags`           | string[]            | Subset of `bid_pls`, `offer_pls`, `cbc`, `can_buy_more`, `can_sell`, `done`, `switch`. |
| `raw`             | string              | **The exact original line** (never invented). Shown in the row tooltip.            |
| `confidence`      | number \| null      | 0–1, the model's confidence the structured row matches the messy line.            |

**Validation in code:** a row is kept only if `raw` is a non-empty string and both
`section` and `side` are valid; everything else is coerced to safe types or dropped.

---

## The Live Board (Phase 1)

Reads `quotes.json` and renders a color-coded table — **Issuer · Maturity · Side ·
Level/Yield · Size (₹cr) · Dealer · Time** — with:

- **Bids green, offers red**, two-way shown as `bid / offer`; **narrow two-ways**
  (a tight bid-offer gap) get a subtle **amber glow**.
- **Group by bond** — collapse by issuer + maturity to show best bid, best offer, and
  the bid-offer spread per bond.
- **Section dropdown** (All / Bonds / Gsec / DCM), **search** (issuer or dealer), and a
  **Narrow quotes only** toggle.
- **Sort** by Time or Maturity; **row hover** reveals the original `raw` chat line.
- Right-aligned, tabular figures with zero misalignment; the page never scrolls — the
  table lives in a fixed-height card whose body scrolls internally. Fully responsive,
  with loading / empty / error states.

The board **polls `quotes.json` every 45s**, so an open page picks up a fresh commit
without a manual reload (and flashes the "Live · updated …" pill when new data lands).

---

## File tree

```
frontdesk/
├─ .github/workflows/
│  └─ refresh-quotes.yml     # scheduled data-engine Action (cron + dispatch)
├─ public/                   # ← Cloudflare Pages output directory
│  ├─ index.html             # header, tabs, Live Board shell
│  ├─ js/
│  │  └─ app.js              # ES module: fetch, render, filter/sort/group, states
│  └─ data/
│     └─ quotes.json         # the engine's output (seed committed; overwritten each run)
├─ scripts/
│  ├─ llm.mjs                # LLM client — copied verbatim from dakshamconcall
│  ├─ check-llm.mjs          # preflight key check — copied verbatim
│  └─ parse-quotes.mjs       # the parser: doc → sections → LLM → quotes.json
└─ README.md
```

---

## Deploy (Cloudflare Pages)

1. Connect the repo to Cloudflare Pages.
2. **Build command:** _none_. **Build output directory:** `public`.
3. Deploys automatically on push to `main`. The GitHub Action commits fresh
   `quotes.json` on its schedule, which triggers a redeploy.

## Local preview

Any static server pointed at `public/` works, e.g.:

```bash
cd public && python3 -m http.server 8099   # then open http://localhost:8099
```

---

## Roadmap

- **Spread Watch** — bid-offer spreads per bond, widest and tightest at a glance.
- **Opportunities** — switches, narrow two-ways, and rich/cheap ideas surfaced automatically.
- **Desk Pulse** — who's quoting what, how busy each section is, where flow is building.

All three read the same `quotes.json` contract above.
