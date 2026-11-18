# QA Lab Suite

A connected quality-assurance workspace in a single self-contained `index.html`: environmental monitoring, finished-product evaluation and release, incoming materials / COA control, holds and deviation/CAPA investigation, trending, a one-page audit packet, and a compliance checklist.

**Live:** https://aberger94.github.io/QA-Suite/ (once GitHub Pages is enabled on `main`)

## What it does

| Module | Highlights |
|---|---|
| Dashboard | Open holds, overdue actions, swab sites due, lots awaiting release, loads awaiting COA, overdue assessments; a live "what's drifting" strip; recent activity across modules |
| Environmental Monitoring | Swab records (ATP / Listeria spp. / L. monocytogenes) by site and zone 1–4, repeat-positive flagging, investigations with corrective actions |
| Product Evaluation & Release | pH, Brix, sensory and other tests auto-checked against per-product specs. **Release gate enforced in code**; out-of-spec results force *On Hold* and log a hold |
| Incoming & COA Control | Receiving log, COA values vs internal spec, Accept / Hold / Reject. **Accept is blocked** without a COA that's complete and in spec |
| Holds, Deviations & CAPA | Hold log with aging and disposition; case flow Deviation → Containment → 5 Whys + fishbone → separate corrective and preventive actions → effectiveness check → closure. **Closure gate enforced in code** |
| Trending Center | Test results by lot with spec limits and Ppk, in-house vs outside-lab comparison, EM failures per week, a live Pareto chart, supplier performance |
| Audit Packet | One-click, print-clean, one-page summary for an auditor or the QA Manager |
| Compliance Checklist | HACCP, GMP, FSMA, BRC and Organic program assessment items with due dates; overdue items show on the dashboard |

Across the suite:
- **One-tap cross-module CAPA cases** from a Zone 1 or repeat EM positive, a failed lot, a held or out-of-spec incoming load, a hold, an EM investigation, or a trending finding. The case is pre-filled from the source record and linked back to it.
- Global search (press `/`) and per-module CSV export
- JSON backup/restore, plus **Download offline copy**: a standalone HTML file with your current data baked in

## Two ways to run it

| | **Demo mode** (default) | **Server mode** |
|---|---|---|
| Where data lives | This browser only (`localStorage`) | Shared Turso database, through a Cloudflare Worker API |
| Devices | One | Any number, e.g. your phone and laptop |
| Who did what | Typed names | Per-person sign-in with roles (viewer / tech / manager / admin) |
| Review, release, CAPA closure | Typed reviewer and releaser | **Electronic signatures**: password re-entered at signing; printed name, server time and meaning; tied to the exact record version |
| History | Activity feed | Append-only, hash-chained **audit trail** with before/after values and a reason for change |
| Set up | Nothing — open the page | See [`docs/DEPLOY.md`](docs/DEPLOY.md) (about 20 minutes) |

Server mode switches on when the `<meta name="qa-api">` tag in `index.html` points at your API, or per device via **Data → Connect to a shared server**. Add `?demo` to the URL to force demo mode. For how server mode maps to 21 CFR Part 11, and what your organization still has to supply (validation, SOPs, the FDA certification letter), see [`docs/PART11.md`](docs/PART11.md).

## Gates (enforced at the data layer, not just labels)

- **Release:** a lot can't be saved as *Released* until every required test is entered and within spec, a record-review sign-off (reviewer + date) and *Released by* are recorded, and no hold is open on the lot.
- **CAPA closure:** a case can't be saved as *Closed* until there is a root-cause statement, every corrective and preventive action is complete, and an effectiveness check (metric + date) is recorded as **Pass**.
- **Incoming accept:** a load can't be accepted unless the COA has been received, is complete, and is within spec, and any internal tests are within spec.

In server mode the same gates run again **on the server** (`api/src/rules.js` is the single source; `index.html` carries a byte-identical copy, checked by `npm run check-rules`). On top of that, release and closure can only happen through an e-signature from the right role, and a lot's review signature is voided if its results change.

## Data

- **Demo mode:** everything is stored in the browser's `localStorage`. Nothing is sent anywhere, and the page makes no external requests.
- **Server mode:** records are stored in Turso. Each device keeps a read-only cache so the app still opens with no signal; saving and signing need a connection.
- Sample records are tagged **SAMPLE** wherever they appear. Sample dates are anchored to 2026-11-18 and shifted to the day you first open the page, so "last 30 days" stats stay meaningful. Use **Remove sample records** to clear them while keeping sites, specs and the compliance checklist as templates. **Data ▾** has reset, clear, backup and restore.

## Development

```
index.html            the whole front end (no build step)
api/                  Cloudflare Worker + Turso API
  src/app.js          routes: auth, sync, e-signatures, audit trail, users
  src/rules.js        gate rules shared with index.html
  schema.sql          tables + append-only triggers
  dev.mjs             local server: page + API against a SQLite file
  test/api.test.mjs   API tests
tests/                browser tests (demo mode, server mode)
docs/                 DESIGN, DEPLOY, PART11
```

- `cd api && npm install && npm run dev` serves everything at http://localhost:8787 (setup token `dev-setup-token`).
- `npm test` runs the API tests. `node tests/demo-mode.e2e.js` and `node tests/server-mode.e2e.js` run the browser tests (they need Playwright).
