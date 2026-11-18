/* Applies schema.sql. Usage: TURSO_URL=libsql://... TURSO_AUTH_TOKEN=... node scripts/migrate.mjs
   (or with no env, migrates the local dev database file:./dev.db). */
import { readFile } from 'node:fs/promises';
import { createClient } from '@libsql/client';

export async function migrate(db) {
  const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  // Split on semicolons that end a statement, keeping trigger bodies (BEGIN ... END;) intact.
  const stmts = []; let buf = '';
  for (const line of sql.split('\n')) {
    if (/^\s*--/.test(line)) continue;
    buf += line + '\n';
    const t = buf.trim();
    if (/;\s*$/.test(t) && (!/\bBEGIN\b/i.test(t) || /\bEND;\s*$/i.test(t))) { stmts.push(t); buf = ''; }
  }
  await db.batch(stmts, 'write');
  return stmts.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createClient({ url: process.env.TURSO_URL || 'file:./dev.db', authToken: process.env.TURSO_AUTH_TOKEN });
  console.log(`Applied ${await migrate(db)} schema statements to ${process.env.TURSO_URL || 'file:./dev.db'}`);
}
