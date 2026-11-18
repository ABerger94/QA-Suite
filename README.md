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

## Gates (enforced at the data layer, not just labels)

- **Release:** a lot can't be saved as *Released* until every required test is entered and within spec, a record-review sign-off (reviewer + date) and *Released by* are recorded, and no hold is open on the lot.
- **CAPA closure:** a case can't be saved as *Closed* until there is a root-cause statement, every corrective and preventive action is complete, and an effectiveness check (metric + date) is recorded as **Pass**.
- **Incoming accept:** a load can't be accepted unless the COA has been received, is complete, and is within spec, and any internal tests are within spec.

## Data

- Everything is stored in the browser's `localStorage`. Nothing is sent anywhere, and the page makes no external requests.
- Sample records are tagged **SAMPLE** wherever they appear. Sample dates are anchored to 2026-11-18 and shifted to the day you first open the page, so "last 30 days" stats stay meaningful. Use **Remove sample records** to clear them while keeping sites, specs and the compliance checklist as templates. **Data ▾** has reset, clear, backup and restore.

## Development

There is no build step. Edit `index.html` and open it in a browser. The original design document is in [`docs/DESIGN.md`](docs/DESIGN.md).
