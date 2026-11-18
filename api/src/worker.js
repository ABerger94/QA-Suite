/* Cloudflare Workers entry point. Secrets: TURSO_URL, TURSO_AUTH_TOKEN, SETUP_TOKEN. */
import { createClient } from '@libsql/client/web';
import { handle } from './app.js';

export default {
  async fetch(request, env) {
    const db = createClient({ url: env.TURSO_URL, authToken: env.TURSO_AUTH_TOKEN });
    try { return await handle(request, env, db); } finally { db.close(); }
  },
};
