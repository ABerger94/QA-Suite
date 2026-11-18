# Deploying the shared server (Turso + Cloudflare Workers)

The page (`index.html`) stays on GitHub Pages. Data, sign-in, e-signatures and the audit trail live in a small API on **Cloudflare Workers**, backed by a **Turso** (libSQL/SQLite) database. Both have free tiers that comfortably cover a single site's QA team.

```
phone / laptop ──HTTPS──▶ GitHub Pages (index.html)
       │
       └──HTTPS + sign-in token──▶ Cloudflare Worker (api/) ──▶ Turso database
```

The browser never sees the database credentials. The Worker holds them as secrets and re-checks every gate and permission on each request.

You'll need Node 18+ and free accounts at turso.tech and cloudflare.com. Allow about 20 minutes.

## 1. Create the database (Turso)

```bash
# install the CLI: https://docs.turso.tech/cli/installation
turso auth login
turso db create qa-lab-suite
turso db show qa-lab-suite --url          # → libsql://qa-lab-suite-<you>.turso.io
turso db tokens create qa-lab-suite       # → a long token; treat it like a password
```

Create the tables:

```bash
cd api
npm install
TURSO_URL="libsql://qa-lab-suite-<you>.turso.io" TURSO_AUTH_TOKEN="<token>" npm run migrate
```

## 2. Deploy the API (Cloudflare Workers)

```bash
npx wrangler login
npx wrangler secret put TURSO_URL          # paste the libsql:// URL
npx wrangler secret put TURSO_AUTH_TOKEN   # paste the token
npx wrangler secret put SETUP_TOKEN        # any long random string; you'll type it once to create the first admin
npx wrangler deploy                        # → https://qa-lab-suite-api.<your-subdomain>.workers.dev
```

Check `wrangler.toml` before deploying:

- `ALLOWED_ORIGINS` — must include `https://aberger94.github.io`. It already does.
- `SESSION_IDLE_MINUTES` / `SESSION_MAX_HOURS` — when users are automatically signed out (defaults: 60 minutes idle, 12 hours maximum).
- `ALLOW_SELF_RELEASE` — leave as `"false"` to keep the two-person rule: whoever e-signs a lot's review can't also e-sign its release.

Smoke test: `curl https://qa-lab-suite-api.<your-subdomain>.workers.dev/health` should return `{"ok":true,...}`.

## 3. Point the page at the API

In `index.html`, set the meta tag near the top:

```html
<meta name="qa-api" content="https://qa-lab-suite-api.<your-subdomain>.workers.dev">
```

Commit and push to `main`. GitHub Pages now opens to the sign-in screen. The demo is still available at `https://aberger94.github.io/QA-Suite/?demo` (sample data, saved only in that browser).

If you'd rather leave the public page as the demo, keep the meta tag empty. On each of your own devices, use **Data → Connect to a shared server…** and paste the API URL instead.

## 4. First sign-in

1. Open the site. The **First-time setup** screen asks for the `SETUP_TOKEN`, your full name, your email and a password. This creates the only administrator, and setup can't be run again afterwards.
2. Go to **Users** → **+ Add user** for each person. Pick a role and give them the temporary password privately. They'll be made to choose their own password at first sign-in.
3. Optional: **Data → Load SAMPLE data** to try everything out. Remove it later with **Remove sample records**. The removal is soft and stays in the audit trail.
4. Sign in on your phone with the same account. Both devices now share the same records. Each refreshes when you switch tabs, every 45 seconds, and when the app comes back to the foreground.

## Roles

| Role | Can |
|---|---|
| viewer | Read everything, including the audit trail |
| tech | Enter and edit QA records; e-sign lot record reviews |
| manager | All of the above, plus: e-sign lot release and CAPA closure, disposition holds, edit specs and sites, delete records (with a reason), change released or closed records (with a reason) |
| admin | All of the above, plus: manage users and verify audit-trail integrity |

## Local development

```bash
cd api
npm install
npm run dev        # http://localhost:8787 — serves index.html + the API against ./dev.db; setup token "dev-setup-token"
npm test           # API test suite (gates, permissions, signatures, audit trail, lockout)
npm run check-rules  # confirms index.html and api/src/rules.js carry identical gate rules
```

The gate rules (release, review, accept, closure) live in `api/src/rules.js`. A byte-identical copy sits inside `index.html` between `RULES:BEGIN` and `RULES:END`. If you change one, copy it to the other; `npm run check-rules` fails until they match.

## Backups

Turso keeps point-in-time restore history (how far back depends on your plan). For an independent copy, signed-in users can use **Data → Export a copy of all data (JSON)**. Admins can also run `turso db shell qa-lab-suite .dump > backup.sql` on a schedule.
