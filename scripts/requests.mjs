// Reads and updates the dashboard's 🤖 Claude requests in D1. Run by the "Claude requests" workflow.
//   ACTION=list                            → open requests (new / asked / working), as JSON
//   ACTION=update ID=… STATUS=… REPLY=…    → set a request's status and Claude's note
//   ACTION=sessions SESSIONS='[{"id","title","updated"}]' → the conversations offered on the dashboard
//   ACTION=groups                          → every WhatsApp group name, as JSON (read only)
//   ACTION=rename GROUP=… NAME=…           → rename one WhatsApp group (exact current name) through WaSender
//   ACTION=addmember GROUP='["name",…]' PHONE=… → add one number to each listed group (exact names) through WaSender
//   ACTION=checkmember GROUP='["name",…]' PHONE=… → whether that number is in each listed group now (read only)
import { execFileSync } from 'node:child_process';

const STATUSES = ['asked', 'working', 'done', 'failed'];
const sql = s => "'" + String(s).replace(/'/g, "''") + "'";
function d1(command) {
  const out = execFileSync('wrangler', ['d1', 'execute', 'xp_wa_inbox', '--remote', '--json', '--command', command], { encoding: 'utf8' });
  const j = JSON.parse(out.slice(out.indexOf('[')));
  return (Array.isArray(j) ? j[0] : j).results || [];
}

async function wa(method, path, payload) {
  if (!process.env.WASENDER_API_KEY) throw new Error('WASENDER_API_KEY is not set');
  const res = await fetch('https://www.wasenderapi.com/api' + path, {
    method,
    headers: { Authorization: 'Bearer ' + process.env.WASENDER_API_KEY, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch (e) { body = {}; }
  if (!res.ok || body.success === false) throw new Error('WaSender ' + res.status + ': ' + (body.message || text.slice(0, 300)));
  return body.data !== undefined ? body.data : body;
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
  await wa('PUT', '/groups/' + encodeURIComponent(jid) + '/settings', { subject: to });
  d1(`UPDATE chats SET name = ${sql(to)} WHERE jid = ${sql(jid)}`);
  console.log('RENAMED ' + JSON.stringify({ jid, from, to }));
} else if (ACTION === 'addmember') {
  const names = JSON.parse(process.env.GROUP || '[]').map(n => String(n).trim()).filter(Boolean);
  const phone = (process.env.PHONE || '').replace(/\D/g, '');
  if (!names.length || names.length > 50) throw new Error('GROUP must be a JSON list of 1 to 50 group names');
  if (!/^\d{10,15}$/.test(phone)) throw new Error('PHONE must be a number with country code, e.g. 919876543210');
  const results = [];
  for (const name of names) {
    const hits = d1(`SELECT jid FROM chats WHERE kind = 'group' AND TRIM(name) = ${sql(name)}`);
    if (hits.length !== 1) { results.push({ name, ok: false, note: `found ${hits.length} groups with this name` }); continue; }
    try {
      const data = await wa('POST', '/groups/' + encodeURIComponent(hits[0].jid) + '/participants/add', { participants: [phone] });
      results.push({ name, ok: true, note: JSON.stringify(data).slice(0, 300) });
    } catch (e) {
      results.push({ name, ok: false, note: e.message });
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('ADDMEMBER_JSON ' + JSON.stringify(results));
} else if (ACTION === 'checkmember') {
  const names = JSON.parse(process.env.GROUP || '[]').map(n => String(n).trim()).filter(Boolean);
  const phone = (process.env.PHONE || '').replace(/\D/g, '');
  const results = [];
  for (const name of names) {
    const hits = d1(`SELECT jid FROM chats WHERE kind = 'group' AND TRIM(name) = ${sql(name)}`);
    if (hits.length !== 1) { results.push({ name, found: hits.length }); continue; }
    try {
      const meta = await wa('GET', '/groups/' + encodeURIComponent(hits[0].jid) + '/metadata');
      const people = (meta && meta.participants) || [];
      const me = people.find(p => JSON.stringify(p).includes(phone));
      results.push({ name, jid: hits[0].jid, subject: meta && meta.subject, members: people.length, inGroup: !!me, entry: me || null });
    } catch (e) {
      results.push({ name, jid: hits[0].jid, error: e.message });
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log('CHECKMEMBER_JSON ' + JSON.stringify(results));
} else {
  throw new Error('ACTION must be list, update, sessions, groups, rename, addmember or checkmember');
}
