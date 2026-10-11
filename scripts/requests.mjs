// Reads and updates the dashboard's 🤖 Claude requests in D1. Run by the "Claude requests" workflow.
//   ACTION=list                            → open requests (new / asked / working), as JSON
//   ACTION=update ID=… STATUS=… REPLY=…    → set a request's status and Claude's note
//   ACTION=sessions SESSIONS='[{"id","title"}]' → the conversations offered on the dashboard
import { execFileSync } from 'node:child_process';

const STATUSES = ['asked', 'working', 'done', 'failed'];
const sql = s => "'" + String(s).replace(/'/g, "''") + "'";
function d1(command) {
  const out = execFileSync('wrangler', ['d1', 'execute', 'xp_wa_inbox', '--remote', '--json', '--command', command], { encoding: 'utf8' });
  const j = JSON.parse(out.slice(out.indexOf('[')));
  return (Array.isArray(j) ? j[0] : j).results || [];
}

const { ACTION, ID = '', STATUS = '', REPLY = '' } = process.env;
if (ACTION === 'list') {
  const rows = d1("SELECT id, datetime(created/1000, 'unixepoch', '+330 minutes') AS created_ist, status, session, session_title, text, reply " +
    "FROM requests WHERE status IN ('new', 'asked', 'working') ORDER BY created");
  console.log('REQUESTS_JSON ' + JSON.stringify(rows));
} else if (ACTION === 'update') {
  if (!/^[a-f0-9]{4,16}$/.test(ID)) throw new Error('Bad request id: ' + ID);
  if (!STATUSES.includes(STATUS)) throw new Error('Status must be one of ' + STATUSES.join(', '));
  if (REPLY.length > 8000) throw new Error('Reply too long');
  d1(`UPDATE requests SET status = ${sql(STATUS)}, reply = ${REPLY ? sql(REPLY) : 'reply'}, updated = ${Date.now()} WHERE id = ${sql(ID)}`);
  console.log('updated', ID, STATUS);
} else if (ACTION === 'sessions') {
  const list = JSON.parse(process.env.SESSIONS || '[]')
    .filter(x => x && /^session_[A-Za-z0-9]{10,60}$/.test(x.id) && x.title)
    .map(x => ({ id: x.id, title: String(x.title).slice(0, 80) })).slice(0, 60);
  if (!list.length) throw new Error('No conversations given');
  d1(`INSERT INTO settings (k, v) VALUES ('claude_sessions', ${sql(JSON.stringify(list))}) ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
  console.log('sessions', list.length);
} else {
  throw new Error('ACTION must be list, update or sessions');
}
