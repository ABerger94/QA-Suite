# 21 CFR Part 11 — what the software does, and what it doesn't

Part 11 compliance is a property of a **validated system plus your procedures**, not of code alone. This page maps the technical controls built into QA Lab Suite's server mode to the regulation, and lists what your organization still has to provide. Demo mode (no server) has none of these controls and must not be used for GMP records.

## Technical controls built in

| Requirement | How the suite meets it |
|---|---|
| **11.10(d)** Limit system access to authorized individuals | Named accounts with per-person sign-in. Sessions end after 60 minutes idle and 12 hours in total (configurable). An account locks for 15 minutes after 5 failed password attempts. Deactivating an account signs it out everywhere. |
| **11.10(e)** Secure, computer-generated, time-stamped audit trail; changes must not obscure previous information | Every create, update, delete, signature, sign-in, failed sign-in, password change and user change writes a row to `audit_log`, with the server's UTC time, the user, the record version, the **full before and after values**, and the reason for change. The database refuses UPDATE and DELETE on the audit trail (triggers). Each row also carries a SHA-256 chained to the previous row, so an edit made outside the app is detected by **Verify audit-trail integrity**. Deletes are soft: the record and its history stay retrievable. |
| **11.10(f)** Enforce permitted sequencing of steps | Gates are enforced on the server: a lot can't be released until the record-review e-signature exists, every required test is in spec and no hold is open. A CAPA can't close without completed actions and a Pass effectiveness check. A load can't be accepted with a missing or out-of-spec COA. Out-of-spec lots are forced on hold. |
| **11.10(g)** Authority checks | Roles: viewer < tech < manager < admin, checked on every request. For example, only managers can release, close a CAPA, disposition a hold, or edit specs. |
| **11.10(h)** Device / source checks | Every request needs a valid, unexpired session token tied to one user. Browsers can only call the API from the sites listed in `ALLOWED_ORIGINS`. Non-browser clients still need a valid token. |
| **11.10(k)** Controls over system documentation | Code, schema and this documentation are version-controlled in Git. |
| **11.50** Signature manifestation: printed name, date/time, meaning | Each signature stores and displays the signer's printed name, email, server timestamp and the meaning ("Reviewed — …", "Released — …", "Approved — …"). These appear on the record, in its history, in the release history and in the audit packet. |
| **11.70** Signature/record linking | Signatures sit in a separate, permanent table (the database refuses changes or deletes). Each one is tied to the record ID, the exact record version and a SHA-256 of the signed content. Changing a lot's results after review **voids** the review signature, and a new one is required before release. Records can't be signed if they changed since the signer opened them. |
| **11.100(a)** Unique to one individual; never reused or reassigned | Each email is unique. Accounts are deactivated, never deleted, so a signature always stays attributable to one person. |
| **11.200(a)** Two distinct identification components | Every signature requires the user ID (signed-in session) **and** the password, re-entered at the moment of signing, even within the same session. |
| **11.300** Controls for identification codes / passwords | Passwords are stored as salted PBKDF2-SHA256 (100,000 iterations) and have a minimum length of 10 characters. Temporary passwords set by an admin must be changed at first sign-in. Lockout after repeated failures is logged in the audit trail. |
| Two-person review (good practice) | The person who e-signs a lot's record review can't also e-sign its release (switch off with `ALLOW_SELF_RELEASE`). |
| Reason for change | Changing a released, closed or dispositioned record, or deleting anything, requires a reason. The reason is stored with the change. |

## What your organization still has to do

- **Validate the system** for its intended use: requirements, risk assessment, and IQ/OQ/PQ or a CSA-style approach. Keep the executed protocols. The automated tests in `api/test/` and the browser tests are a starting point, not a validation package.
- **Send the e-signature certification letter to FDA** (11.100(c)): a one-time letter from the company stating that its electronic signatures are the legally binding equivalent of handwritten signatures.
- **Write SOPs**: system use, account administration (who approves new accounts and roles), periodic access review, password policy, audit-trail review, backup and restore, incident handling, and change control for code updates.
- **Train users**, document the training, and have each user acknowledge that they are accountable for actions taken under their signature (11.10(i), 11.10(j)).
- **Retain records and keep them retrievable** for your required period. Configure Turso backups and point-in-time recovery, and test a restore.
- **Review audit trails periodically** as part of record review, and run **Verify audit-trail integrity** on a schedule.
- **Control changes** to `index.html`, `api/`, `wrangler.toml` and the database schema through your change-control process. Deploys happen through `wrangler deploy` and Git, so both leave history.
- **Vendor assessment** for Cloudflare, Turso and GitHub as hosting and service suppliers.

## Known limitations

- Password-based sign-in only. Adding SSO or MFA (for example Cloudflare Access in front of the Worker) is a straightforward next step if your site requires it.
- Offline use is **read-only**. Records and signatures need a connection, by design, so nothing is ever signed against a stale copy.
- SAMPLE records loaded for demonstration carry typed reviewer and releaser names, not e-signatures. They are flagged as such everywhere they appear. Remove them before real use.
