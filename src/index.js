// Worker entry. The dashboard page and the Tampermonkey script are bundled as text,
// public images under src/media as data (see [[rules]] in wrangler.toml).
import INBOX_HTML from './inbox.html';
import USER_SCRIPT from './wa-sync.user.js';
import CORE_SCRIPT from './wa-core.js';
import DIWALI_2026 from './media/diwali-2026.jpg';
import { makeWorker } from './app.js';

// Public images that WhatsApp (through WaSender) fetches when the office number sends them.
const MEDIA = { '/media/diwali-2026.jpg': DIWALI_2026 };

const app = makeWorker(INBOX_HTML, USER_SCRIPT, CORE_SCRIPT);
export default {
  ...app,
  async fetch(req, env, ctx) {
    const img = MEDIA[new URL(req.url).pathname];
    if (img && (req.method === 'GET' || req.method === 'HEAD')) {
      return new Response(req.method === 'HEAD' ? null : img, {
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' },
      });
    }
    return app.fetch(req, env, ctx);
  },
};
