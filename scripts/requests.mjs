// Reads and updates the dashboard's 🤖 Claude requests in D1. Run by the "Claude requests" workflow.
//   ACTION=list                            → open requests (new / asked / working), as JSON
//   ACTION=update ID=… STATUS=… REPLY=…    → set a request's status and Claude's note
//   ACTION=sessions SESSIONS='[{"id","title","updated"}]' → the conversations offered on the dashboard
//   ACTION=groups                          → every WhatsApp group name, as JSON (read only)
//   ACTION=rename GROUP=… NAME=…           → rename one WhatsApp group (exact current name) through WaSender
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
    .map(x => ({ id: x.id, title: String(x.title).slice(0, 80), updated: Date.parse(x.updated || '') || 0 })).slice(0, 60);
  if (!list.length) throw new Error('No conversations given');
  d1(`INSERT INTO settings (k, v) VALUES ('claude_sessions', ${sql(JSON.stringify(list))}) ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
  console.log('sessions', list.length);
} else if (ACTION === 'groups') {
  const rows = d1("SELECT name FROM chats WHERE kind = 'group' AND name IS NOT NULL ORDER BY name COLLATE NOCASE");
  console.log('GROUPS_JSON ' + JSON.stringify(rows.map(r => r.name)));
} else if (ACTION === 'rename') {
  const from = (process.env.GROUP || '').trim(), to = (process.env.NAME || '').trim();
  if (!from || !to) throw new Error('GROUP (current name) and NAME (new name) are both required');
  if (to.length > 100) throw new Error('A WhatsApp group name can be at most 100 characters');
  const hits = d1(`SELECT jid, name FROM chats WHERE kind = 'group' AND TRIM(name) = ${sql(from)}`);
  if (hits.length !== 1) throw new Error(`Expected exactly one group named "${from}", found ${hits.length}`);
  const { jid } = hits[0];
  if (!process.env.WASENDER_API_KEY) throw new Error('WASENDER_API_KEY is not set');
  const res = await fetch('https://www.wasenderapi.com/api/groups/' + encodeURIComponent(jid) + '/settings', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + process.env.WASENDER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: to }),
  });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch (e) { body = {}; }
  if (!res.ok || body.success === false) throw new Error('WaSender ' + res.status + ': ' + (body.message || text.slice(0, 300)));
  d1(`UPDATE chats SET name = ${sql(to)} WHERE jid = ${sql(jid)}`);
  console.log('RENAMED ' + JSON.stringify({ jid, from, to }));
} else {
  throw new Error('ACTION must be list, update, sessions, groups or rename');
}
