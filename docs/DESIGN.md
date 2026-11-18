# QA Lab Suite — Design Document

**Status:** Phases 1–3 built in `index.html` (2026-11-18). Phase 4 (publish on GitHub Pages) pending merge to `main`.
**Destination:** Static webpage, hosted from GitHub repo `ABerger94/QA-Suite` via GitHub Pages (single self-contained `index.html`, no backend, no external requests required to run).

## Build notes — decisions made during implementation

These go slightly beyond the original spec. All of them are easy to revert.

- **Release gate** also requires *Released by* and **no open hold on the lot**. The hold has to be dispositioned in Holds & CAPA first. Releasing a hold doesn't release the lot; the lot still has to pass its own gate.
- **Closure gate** also requires a root-cause statement and **all corrective and preventive actions complete**, in addition to a Pass effectiveness check.
- **Incoming accept gate**: *Accept* is blocked unless the COA has been received, is complete, and is within spec, and any internal tests are within spec. *Hold* and *Reject* require a reason. A *Hold* creates a hold record automatically.
- **Seed dates** are written relative to 2026-11-18 and shifted to the viewer's current date, so the 30-day stats still work for anyone who opens the page later.
- **Pareto** is drawn on one 0–100% axis: bars show each category's share, with counts labeled on the bars, and the line shows the cumulative %. That avoids a dual-axis chart.
- **Trending** adds a Ppk readout (5+ lots) to the product trend chart. Drift signals are rule-based: an out-of-spec latest result, three lots moving in one direction inside the last 20% of the spec band, in-house vs outside-lab difference beyond tolerance, repeat positives, and supplier holds/rejects.

---

## 1. Purpose

One connected tool that covers the whole QA Technician II job: environmental monitoring, finished product evaluation and release, incoming materials inspection, data trending, product holds and deviation/CAPA investigation, and audit-ready documentation.

The value is the **connections between modules**. A failed test creates a hold, a hold opens an investigation, an investigation closes only when the data proves the fix worked, and all of it rolls up into trending and an audit packet.

## 2. Job-description mapping

| Responsibility | Suite module |
|---|---|
| Support the environmental monitoring program, data collection and review | Module 1 — Environmental Monitoring |
| Finished product evaluations: sensory, pH, Brix, other analytical measures | Module 2 — Product Evaluation & Release |
| Disposition and timely release of finished products meeting spec | Module 2 — release gate |
| Inspection/testing of incoming raw materials, ingredients, packaging | Module 3 — Incoming & COA Control |
| Compile, review, analyze test data; identify trends; prepare trend reports | Trending Center + Audit Packet |
| Assist in management of product holds; investigation of deviations/non-conformances | Module 4 — Holds, Deviations & CAPA |
| Compliance with HACCP, GMPs, FSMA, BRC, Organic programs; internal audits | Compliance Checklist |
| Maintain accurate, organized records | Unified records, global search, CSV export |
| Program and/or site assessments | Compliance Checklist |

## 3. Modules

- **Home Dashboard:** counts at a glance, a unified trend strip, and recent activity across modules.
- **Module 1 — Environmental Monitoring:** swab records, site list by zone, repeat-positive flagging, corrective actions per investigation, 30-day stats. A Zone 1 or repeat positive opens a Module 4 case in one tap.
- **Module 2 — Finished Product Evaluation & Release:** lot records auto-checked against per-product spec limits. The release gate is enforced in code, a failing result forces *On Hold*, and there is a release history log.
- **Module 3 — Incoming Materials & COA Control:** receiving records, COA vs internal spec, an Accept / Hold / Reject decision with reason, and a supplier view.
- **Module 4 — Holds, Deviations & CAPA:** hold log with aging, and the case flow Deviation → Containment → RCA (5 Whys, fishbone, root-cause statement) → separate corrective and preventive actions → effectiveness check → closure, with the closure gate enforced in code.
- **Trending Center:** test results over time, in-house vs outside-lab comparison, a live Pareto chart, a selectable date range, and CSV export.
- **Audit Packet:** a one-page printable summary.
- **Compliance Checklist:** HACCP, GMP, FSMA, BRC and Organic assessment items with status, due dates and notes.

## 4. Added features

Cross-module case creation, unified trending, the audit packet generator, global search, per-module CSV export, and an offline download with data baked in.

## 5. Data & seed data

- All seed data is labeled **SAMPLE**.
- EM: 56 swabs across 12 sites (2026-10-02 → 2026-11-03), 87.1% pass over the last 30 days, and one open investigation (*Repeat Listeria positives — Fill Room Floor Drain*, Zone 2) with 3 corrective actions.
- CAPA: exactly 3 SAMPLE cases: a Zone 3 *Listeria* spp. positive (High, Effectiveness Check); cryoscope drift found by trending (Medium, Actions In Progress, one overdue action); and a supplier COA not matching spec (Medium, Investigating, product held at receiving).
- Product and incoming seeds cover every state: released, awaiting review, in testing, on hold, accepted, rejected, COA-mismatched, and awaiting COA.
- No invented employer facts. HACCP appears only as a compliance program name. Products, sites and suppliers are generic and fictional.

## 6. Technical plan

One self-contained `index.html` with no build step and no external requests. Data is stored in `localStorage`. Hosting is GitHub Pages on `main`. Layout is mobile-first.

## 7. Build phases

1. Core — dashboard and Modules 1, 2, 4 with both gates and seed data ✅
2. Connect — Module 3, cross-module case creation, global search, CSV export ✅
3. Prove — Trending Center, Audit Packet, Compliance Checklist, offline download ✅
4. Ship — merge to `main`, enable Pages, verify the live URL ⏳
