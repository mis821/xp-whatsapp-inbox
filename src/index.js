// Worker entry. The dashboard page and the Tampermonkey script are bundled as text
// (see [[rules]] in wrangler.toml).
import INBOX_HTML from './inbox.html';
import USER_SCRIPT from './wa-sync.user.js';
import CORE_SCRIPT from './wa-core.js';
import { makeWorker } from './app.js';

export default makeWorker(INBOX_HTML, USER_SCRIPT, CORE_SCRIPT);
