// Worker entry. The dashboard page is bundled as text (see [[rules]] in wrangler.toml).
import INBOX_HTML from './inbox.html';
import { makeWorker } from './app.js';

export default makeWorker(INBOX_HTML);
