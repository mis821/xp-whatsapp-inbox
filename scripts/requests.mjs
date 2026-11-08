// Reads and updates the dashboard's 🤖 Claude requests in D1. Run by the "Claude requests" workflow.
//   ACTION=list                            → open requests (new / asked / working), as JSON
//   ACTION=update ID=… STATUS=… REPLY=…    → set a request's status and Claude's note
//   ACTION=sessions SESSIONS='[{"id","title","updated"}]' → the conversations offered on the dashboard
//   ACTION=groups                          → every WhatsApp group name, as JSON (read only)
//   ACTION=rename GROUP=… NAME=…           → rename one WhatsApp group (exact current name) through WaSender
//   ACTION=addmember GROUP='["name",…]' PHONE=… [PAUSE=seconds] → add one number to each listed group (exact names) through WaSender
//   ACTION=checkmember GROUP='["name",…]' PHONE=… → whether that number is in each listed group now (read only)
//   ACTION=admins GROUP='["name",…]'      → whether the office number is an admin of each listed group (read only)
//   ACTION=status                          → WaSender's own view of the WhatsApp session (read only)
//   ACTION=greet [ID=run]                  → festival wishes already received that GREETINGS would answer;
//                                            with ID=run, queue those replies in the outbox (WhatsApp Web sends them)
//   ACTION=send GROUP='["name",…]' | PHONE=… TEXT=… [NAME=image URL] [PAUSE=seconds or seconds/batch/break]
//                                          → send one message (or image + caption) to each listed group, or to one number;
//                                            with a batch, up to 300 groups in one run (send runs queue one after another)
import { execFileSync } from 'node:child_process';
import { GREETINGS, greetingFor } from '../src/app.js';

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

// WaSender answers this when the WhatsApp session is logged out; every later call would fail the same way.
const offline = e => /not connected/i.test(e.message);

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
  const names = [...new Set(JSON.parse(process.env.GROUP || '[]').map(n => String(n).trim()).filter(Boolean))];
  const phone = (process.env.PHONE || '').replace(/\D/g, '');
  if (!names.length || names.length > 60) throw new Error('GROUP must be a JSON list of 1 to 60 group names');
  if (!/^\d{10,15}$/.test(phone)) throw new Error('PHONE must be a number with country code, e.g. 919876543210');
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const results = [];
  for (const name of names) {
    // Two groups can share a name (the same supplier twice); add to each of them.
    const hits = d1(`SELECT jid FROM chats WHERE kind = 'group' AND TRIM(name) = ${sql(name)}`);
    if (!hits.length) { results.push({ name, ok: false, note: 'no group with this name' }); continue; }
    for (const { jid } of hits) {
      const path = '/groups/' + encodeURIComponent(jid) + '/participants/add';
      let r;
      for (let attempt = 0; attempt < 3 && !r; attempt++) {
        try {
          const data = await wa('POST', path, { participants: [phone] });
          const status = String((Array.isArray(data) && data[0] && data[0].status) || '');
          r = { name, jid, ok: status === '200' || status === '', note: status };
        } catch (e) {
          if (/ 429:/.test(e.message) && attempt < 2) { await pause(30000); continue; }
          if (offline(e)) { console.log('ADDMEMBER_JSON ' + JSON.stringify(results)); throw new Error('Stopped at "' + name + '": ' + e.message); }
          r = { name, jid, ok: false, note: e.message.slice(0, 200) };
        }
      }
      results.push(r);
      // Go slowly: many adds in a row can get the number flagged by WhatsApp. PAUSE (seconds) can slow it further.
      await pause(Math.min(Math.max(Number(process.env.PAUSE) || 8, 8), 120) * 1000);
    }
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
      const alt = (process.env.NAME || '').trim(); // optional second id to match, e.g. the person's @lid
      const me = people.find(p => { const t = JSON.stringify(p); return t.includes(phone) || (alt && t.includes(alt)); });
      results.push({ name, jid: hits[0].jid, subject: meta && meta.subject, members: people.length, inGroup: !!me, entry: me || null });
    } catch (e) {
      results.push({ name, jid: hits[0].jid, error: e.message });
    }
    await new Promise(r => setTimeout(r, 6000));
  }
  console.log('CHECKMEMBER_JSON ' + JSON.stringify(results));
} else if (ACTION === 'send') {
  const names = [...new Set(JSON.parse(process.env.GROUP || '[]').map(n => String(n).trim()).filter(Boolean))];
  const text = (process.env.TEXT || '').trim();
  const phone = (process.env.PHONE || '').replace(/\D/g, '');   // or one person, for a test
  // PAUSE = seconds between groups, or "seconds/batch/break": a longer break (seconds) after every `batch` groups.
  const [gap, batch, brk] = String(process.env.PAUSE || '').split('/').map(Number);
  const wait = Math.min(Math.max(gap || 20, 10), 120) * 1000, every = batch > 0 ? batch : 0, rest = Math.min(Math.max(brk || 0, 60), 900) * 1000;
  const most = every ? 300 : 20;
  if (phone ? !/^\d{10,15}$/.test(phone) : (!names.length || names.length > most)) throw new Error('GROUP must be a JSON list of 1 to ' + most + ' group names, or PHONE one number with country code');
  const image = (process.env.NAME || '').trim();   // optional: public https URL of an image; TEXT becomes its caption
  if (image && !/^https:\/\/\S+$/.test(image)) throw new Error('NAME (image URL) must be a public https address');
  if ((!text && !image) || text.length > 4000) throw new Error('TEXT must be 1 to 4000 characters (it may be empty only when an image is sent)');
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const results = [];
  const targets = phone ? [{ name: '+' + phone, hits: [{ jid: '+' + phone }] }]
    : names.map(name => ({ name, hits: d1(`SELECT jid FROM chats WHERE kind = 'group' AND TRIM(name) = ${sql(name)}`) }));
  for (const { name, hits } of targets) {
    if (!hits.length) { results.push({ name, ok: false, note: 'no group with this name' }); continue; }
    for (const { jid } of hits) {
      try {
        await wa('POST', '/send-message', image ? (text ? { to: jid, text, imageUrl: image } : { to: jid, imageUrl: image }) : { to: jid, text });
        results.push({ name, jid, ok: true });
        console.log('SENT ' + name);
      } catch (e) {
        if (offline(e)) { console.log('SEND_JSON ' + JSON.stringify(results)); throw new Error('Stopped at "' + name + '": ' + e.message); }
        results.push({ name, jid, ok: false, note: e.message.slice(0, 200) });
        console.log('FAILED ' + name + ': ' + e.message.slice(0, 200));
      }
      await pause(every && results.length % every === 0 ? rest : wait);
    }
  }
  console.log('SEND_JSON ' + JSON.stringify(results));
} else if (ACTION === 'greet') {
  const from = Math.min(...GREETINGS.map(g => g.from)), until = Math.max(...GREETINGS.map(g => g.until));
  const rows = d1(`SELECT id, t, chat, is_group, from_me, sender_phone, sender_name, text FROM messages WHERE is_group = 0 AND from_me = 0 AND t >= ${from} AND t < ${until} AND IFNULL(text, '') <> '' ORDER BY t`);
  const seen = new Set(), todo = [];
  for (const r of rows) {
    const g = greetingFor(r);
    if (!g) continue;
    const person = r.sender_phone || String(r.chat).split('@')[0];
    const id = 'G:' + g.key + ':' + person;
    if (seen.has(id)) continue;
    seen.add(id);
    if (d1(`SELECT 1 AS x FROM outbox WHERE id = ${sql(id)}`).length) continue;
    const mine = d1(`SELECT text FROM messages WHERE chat = ${sql(r.chat)} AND from_me = 1 AND t >= ${r.t} ORDER BY t LIMIT 50`);
    if (mine.some(m => g.re.test(String(m.text || '')))) continue;
    todo.push({ id, chat: r.chat, quote: r.id, reply: g.reply, name: r.sender_name || '', phone: r.sender_phone || '', said: String(r.text).slice(0, 80) });
  }
  if (ID === 'run') {
    const now = Date.now();
    for (const o of todo) d1(`INSERT OR IGNORE INTO outbox (id, created, chat, quote, text) VALUES (${sql(o.id)}, ${now}, ${sql(o.chat)}, ${sql(o.quote)}, ${sql(o.reply)})`);
  }
  console.log('GREET_JSON ' + JSON.stringify({ queued: ID === 'run', items: todo }));
} else if (ACTION === 'status') {
  let out;
  try { out = await wa('GET', '/status'); } catch (e) { out = { error: e.message }; }
  console.log('STATUS_JSON ' + JSON.stringify(out));
} else if (ACTION === 'admins') {
  const names = [...new Set(JSON.parse(process.env.GROUP || '[]').map(n => String(n).trim()).filter(Boolean))];
  if (!names.length || names.length > 300) throw new Error('GROUP must be a JSON list of 1 to 300 group names');
  const u = await wa('GET', '/user') || {};
  const mine = [u.id, u.lid].filter(Boolean).map(x => String(x).split('@')[0].split(':')[0]);
  if (!mine.length) throw new Error('WaSender did not return the office number');
  const results = [];
  for (const name of names) {
    const hits = d1(`SELECT jid FROM chats WHERE kind = 'group' AND TRIM(name) = ${sql(name)}`);
    if (!hits.length) { results.push({ name, error: 'no group with this name' }); continue; }
    for (const { jid } of hits) {
      try {
        const meta = await wa('GET', '/groups/' + encodeURIComponent(jid) + '/metadata');
        const people = (meta && meta.participants) || [];
        const me = people.find(p => { const t = JSON.stringify(p); return mine.some(m => t.includes(m)); });
        results.push({ name, jid, subject: meta && meta.subject, member: !!me, role: (me && me.admin) || null });
      } catch (e) {
        if (offline(e)) { console.log('ADMINS_JSON ' + JSON.stringify(results)); throw new Error('Stopped at "' + name + '": ' + e.message); }
        results.push({ name, jid, error: e.message.slice(0, 200) });
      }
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  console.log('ADMINS_JSON ' + JSON.stringify(results));
} else {
  throw new Error('ACTION must be list, update, sessions, groups, rename, addmember, checkmember, admins, status, send or greet');
}
