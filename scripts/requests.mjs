// Reads and updates the dashboard's 🤖 Claude requests in D1. Run by the "Claude requests" workflow.
//   ACTION=list                            → open requests (new / asked / working), as JSON
//   ACTION=update ID=… STATUS=… REPLY=…    → set a request's status and Claude's note
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
  const rows = d1("SELECT id, datetime(created/1000, 'unixepoch', '+330 minutes') AS created_ist, status, text, reply " +
    "FROM requests WHERE status IN ('new', 'asked', 'working') ORDER BY created");
  console.log('REQUESTS_JSON ' + JSON.stringify(rows));
} else if (ACTION === 'update') {
  if (!/^[a-f0-9]{4,16}$/.test(ID)) throw new Error('Bad request id: ' + ID);
  if (!STATUSES.includes(STATUS)) throw new Error('Status must be one of ' + STATUSES.join(', '));
  if (REPLY.length > 8000) throw new Error('Reply too long');
  d1(`UPDATE requests SET status = ${sql(STATUS)}, reply = ${REPLY ? sql(REPLY) : 'reply'}, updated = ${Date.now()} WHERE id = ${sql(ID)}`);
  console.log('updated', ID, STATUS);
} else {
  throw new Error('ACTION must be list or update');
}
