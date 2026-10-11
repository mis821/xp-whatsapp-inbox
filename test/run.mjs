// End-to-end tests: real SQL (node:sqlite standing in for D1), fake WaSender.
// Run: node test/run.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeD1 } from './d1.mjs';
import { makeWorker, dayKey, parseKaam, shortParty, briefText } from '../src/app.js';

const ROOT = new URL('..', import.meta.url).pathname;
const ME_PN = '919999900000', ME_LID = '123450000000001';
const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  const path = String(url).replace('https://www.wasenderapi.com/api', '');
  const body = (d, status = 200) => new Response(JSON.stringify(d), { status });
  if (path === '/user') return body({ success: true, data: { id: ME_PN + ':12@s.whatsapp.net', lid: ME_LID + ':12@lid', name: 'XP Purchase' } });
  if (path === '/status') return body({ status: 'connected' });
  if (path === '/groups') return body({ success: true, data: [
    { id: 'G1@g.us', name: 'XPP | Jyoti Timbers | Orders & Bills' }, { id: 'G2@g.us', name: 'Internal Payment Request' },
    { id: 'G3@g.us', name: 'XP Store Ops' }, { id: 'G4@g.us', name: 'Vendor payment' }] });
  if (path.startsWith('/groups/') && path.endsWith('/metadata')) return body({ success: true, data: { subject: 'Fetched Group Name' } });
  if (path === '/contacts') return body({ success: true, data: [
    { id: '918888800000@s.whatsapp.net', lid: '777@lid', notify: 'Ramesh Jyoti' },
    { id: '917777700000@s.whatsapp.net', lid: null, notify: 'Mahesh Bhagwati' }] });
  if (path === '/send-message') { sent.push(JSON.parse(opts.body)); return body({ success: true, data: { msgId: 1 } }); }
  return body({ message: 'nope' }, 404);
};

const env = { DB: makeD1(ROOT + 'migrations'), WASENDER_API_KEY: 'k', DASHBOARD_PASSWORD: 'secret-pass' };
const worker = makeWorker('<html>INBOX</html>');
const pending = [];
const ctx = { waitUntil: p => pending.push(p) };
const req = (path, init = {}) => worker.fetch(new Request('https://wa.example.workers.dev' + path, init), env, ctx);
const now = Date.now(), sec = Math.floor(now / 1000);

// ---------- login ----------
let r = await req('/');
assert.match(await r.text(), /type="password"/, 'login page when logged out');
r = await req('/api/rpc', { method: 'POST', body: JSON.stringify({ fn: 'getWaInbox', args: [2] }) });
assert.equal(r.status, 401, 'rpc needs login');
r = await req('/login', { method: 'POST', body: new URLSearchParams({ password: 'wrong' }) });
assert.equal(r.status, 401);
r = await req('/login', { method: 'POST', body: new URLSearchParams({ password: 'secret-pass' }) });
assert.equal(r.status, 303);
const cookie = r.headers.get('set-cookie').split(';')[0];
assert.ok(cookie.startsWith('xpwa='));
r = await req('/', { headers: { cookie } });
assert.equal(await r.text(), '<html>INBOX</html>');
assert.equal((await req('/', { headers: { cookie: 'xpwa=9999999999999.deadbeef' } })).status, 200);
assert.match(await (await req('/', { headers: { cookie: 'xpwa=9999999999999.deadbeef' } })).text(), /password/, 'forged cookie refused');

const rpc = async (fn, ...args) => {
  const res = await req('/api/rpc', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'https://wa.example.workers.dev' }, body: JSON.stringify({ fn, args }) });
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j.data;
};
assert.equal((await req('/api/rpc', { method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: '{}' })).status, 403, 'cross-origin refused');

// ---------- webhook ----------
const setup = await rpc('getWaSetup');
const hook = new URL(setup.webhookUrl).pathname + new URL(setup.webhookUrl).search;
assert.equal((await req('/webhook?token=nope', { method: 'POST', body: '{}' })).status, 401);
let n = 0;
const post = body => req(hook, { method: 'POST', body: JSON.stringify(body) });
const m = (chat, opts) => ({ event: 'messages.upsert', timestamp: sec, data: { messages: Object.assign({ key: Object.assign({ id: 'M' + (++n), fromMe: false, remoteJid: chat }, opts.key || {}) }, opts.msg) } });

// contacts first so ingest can name senders
await rpc('syncWaNames');
await post(m('G1@g.us', { key: { participant: '777@lid', cleanedParticipantPn: '918888800000' }, msg: { messageTimestamp: sec - 3 * 3600, messageBody: '@' + ME_LID + ' sir payment kab hoga?', message: { extendedTextMessage: { text: 'x', contextInfo: { mentionedJid: [ME_LID + '@lid'] } } } } }));
await post({ event: 'messages.received', data: { messages: { key: { id: 'M1', remoteJid: 'G1@g.us' }, messageBody: 'dup', message: { conversation: 'dup' } } } });
await post(m('G3@g.us', { key: { participant: '555@lid' }, msg: { pushName: 'Store Guy', messageTimestamp: String(sec - 7200), messageBody: 'material aa gaya', message: { conversation: 'material aa gaya' } } }));
await post(m('G3@g.us', { key: { fromMe: true }, msg: { messageTimestamp: sec - 1200, messageBody: 'ok', message: { conversation: 'ok' } } }));
await post(m('917777700000@s.whatsapp.net', { key: { cleanedSenderPn: '917777700000' }, msg: { messageTimestamp: sec - 3600, messageBody: 'Sir dispatch kal hoga', message: { conversation: 'Sir dispatch kal hoga' } } }));
await post(m('917777700000@s.whatsapp.net', { msg: { message: { reactionMessage: { text: '👍' } } } }));
await post(m('status@broadcast', { msg: { message: { conversation: 'status' } } }));
await post(m('G2@g.us', { key: { participant: '918888800000@s.whatsapp.net' }, msg: { messageTimestamp: sec - 1800, message: { ephemeralMessage: { message: { imageMessage: { caption: 'bill attached', contextInfo: { participant: ME_PN + '@s.whatsapp.net' } } } } } } }));
await post(m('G9@g.us', { key: { participant: '1@lid' }, msg: { messageTimestamp: sec - 100, messageBody: 'new group', message: { conversation: 'new group' } } }));
await post({ event: 'messages.upsert', data: { messages: { key: { id: 'K1', fromMe: true, remoteJid: ME_LID + '@lid' }, messageTimestamp: sec - 600, messageBody: '#kaam Jyoti Timbers: payment kal ho jayega', message: { conversation: '#kaam Jyoti Timbers: payment kal ho jayega' } } } });
await post({ event: 'messages.upsert', data: { messages: { key: { id: 'K2', fromMe: true, remoteJid: 'G4@g.us' }, messageTimestamp: sec - 500, messageBody: '#task material 15/10 tak bhejna', message: { conversation: '#task material 15/10 tak bhejna' } } } });
await post({ event: 'messages.upsert', data: { messages: { key: { id: 'K1', fromMe: true, remoteJid: ME_LID + '@lid' }, messageBody: '#kaam Jyoti Timbers: payment kal ho jayega', message: { conversation: 'x' } } } });
await post({ event: 'call', data: { call: { id: 'C1', from: '917777700000@s.whatsapp.net', date: new Date(now - 300000).toISOString(), status: 'offer' } } });
await post({ event: 'call', data: { call: [{ id: 'C1', from: '917777700000@s.whatsapp.net', status: 'timeout' }] } });
await post(m('G2@g.us', { key: { participant: 'x@lid' }, msg: { messageTimestamp: sec - 5 * 86400, messageBody: 'old', message: { conversation: 'old' } } }));
await Promise.all(pending);

const count = env.DB.raw.prepare('SELECT COUNT(*) c FROM messages').get().c;
console.log('messages stored:', count);
assert.equal(count, 10, 'dups, reactions, status skipped');

let d = await rpc('getWaInbox', 2);
const show = d => d.chats.map(c => `${c.name} [${c.cat}] unseen=${c.unseen} pending=${c.pending} calls=${c.calls} total=${c.total} lp=${c.lastPending ? c.lastPending.who + ':' + c.lastPending.text.slice(0, 22) : '-'}`).join('\n');
console.log(show(d));
const by = s => d.chats.find(c => c.name.indexOf(s) !== -1);
assert.equal(by('Jyoti').pending, 1, 'LID mention');
const jy = await rpc('getWaChat', by('Jyoti').jid, 2);
assert.equal(jy.msgs[0].who, 'Ramesh Jyoti', 'sender named from contacts');
assert.match(jy.msgs[0].text, /^@Aap /, 'mention shown as @Aap');
assert.equal(jy.msgs[0].pending, true);
assert.match(by('Jyoti').preview.text, /^@Aap /);
assert.equal(d.callsToday.length, 1);
assert.deepEqual(await rpc('searchWa', 'dispatch', 2), ['917777700000@s.whatsapp.net']);
assert.deepEqual(await rpc('searchWa', '100%', 2), []);
assert.equal(by('Store').unseen, 0, 'reply clears unseen');
assert.equal(by('Payment Request').pending, 1, 'reply-to-me tag');
assert.equal(by('Mahesh').calls, 1, 'call deduped');
assert.equal(by('Mahesh').pending, 2);
assert.equal(by('Fetched Group').total, 1, 'unknown group named via metadata');
assert.ok(!d.chats.some(c => c.jid.startsWith(ME_LID)), 'self chat hidden');
assert.equal(by('Payment Request').total, 1, 'old rows outside window');
assert.equal(d.tasks.length, 2, '#kaam captured once each');
const k1 = d.tasks.find(t => t.msgId === 'K1'), k2 = d.tasks.find(t => t.msgId === 'K2');
assert.deepEqual([k1.party, k1.type, k1.team, k1.due], ['Jyoti Timbers', 'Payment', 'Accounts', dayKey(now + 86400000)]);
assert.deepEqual([k2.party, k2.type], ['Vendor payment', 'Material']);
assert.ok(k2.due.endsWith('-10-15'));

// seen / clear / mute / category
await rpc('markWaChatsSeen', [{ jid: by('Jyoti').jid, t: by('Jyoti').lastT }]);
await rpc('clearWaChatTags', by('Mahesh').jid, by('Mahesh').lastT);
await rpc('setWaChatMuted', 'G3@g.us', true);
await rpc('setWaChatCategory', 'G4@g.us', 'Customer');
d = await rpc('getWaInbox', 2);
assert.equal(by('Jyoti').unseen, 0); assert.equal(by('Jyoti').pending, 1, 'seen keeps tag');
assert.equal(by('Mahesh').pending, 0); assert.equal(by('Store').muted, true);
assert.equal(by('Vendor').cat, 'Customer');

// tasks
let tasks = await rpc('addWaTask', { kaam: '=SUM(1) +91 wale ko call', party: 'Maruti', type: 'Reply', due: dayKey(now - 2 * 86400000), team: 'Khud' });
const t3 = tasks.find(t => t.party === 'Maruti');
assert.equal(t3.kaam, '=SUM(1) +91 wale ko call');
tasks = await rpc('updateWaTask', t3.id, { status: 'Done', note: 'ho gaya' });
assert.equal(tasks.find(t => t.id === t3.id).status, 'Done');
const before = tasks.length;
tasks = await rpc('addWaTask', { kaam: 'pehla', msgId: 'M1', chat: 'G1@g.us' });
tasks = await rpc('addWaTask', { kaam: 'doosra', msgId: 'M1', chat: 'G1@g.us' });
assert.equal(tasks.length, before + 2, 'two tasks from one message both saved');
await assert.rejects(rpc('addWaTask', { kaam: ' ' }), /khaali/);
await assert.rejects(rpc('addWaTask', { kaam: 'x', due: '12/10' }), /Due/);
tasks = await rpc('sendWaTaskToTeam', k1.id, 'G2@g.us', 'Payment — Jyoti kal', 'Accounts');
assert.match(tasks.find(t => t.id === k1.id).notified, /Internal Payment Request/);
await assert.rejects(rpc('sendWaTaskToTeam', k1.id, '1@s.whatsapp.net', 'x', 'Accounts'), /Group/);
await assert.rejects(rpc('sendWaTaskToTeam', 'nope', 'G2@g.us', 'x', 'Accounts'), /Task/);
assert.equal(sent.length, 1);
d = await rpc('getWaInbox', 2);
assert.equal(d.teamGroups.Accounts, 'G2@g.us');
await assert.rejects(rpc('nope'), /unknown/);

// briefs + cron
await rpc('sendWaBriefNow', 'evening');
assert.equal(sent[1].to, '+' + ME_PN);
console.log('\n--- evening brief ---\n' + sent[1].text);
await worker.scheduled({ cron: '0 4 * * *' }, env, ctx);
assert.equal(sent.length, 2, 'briefs off by default');
await rpc('setWaBriefs', true);
await worker.scheduled({ cron: '0 4 * * *' }, env, ctx);
assert.equal(sent.length, 3); console.log('\n--- morning brief ---\n' + sent[2].text);
env.DB.raw.prepare('UPDATE messages SET received_at = ? WHERE id = ?').run(now - 40 * 86400000, 'M2');
await worker.scheduled({ cron: '0 21 * * *' }, env, ctx);
assert.equal(env.DB.raw.prepare('SELECT COUNT(*) c FROM messages').get().c, 9, 'nightly prune');

console.log('\nsetup:', JSON.stringify(await rpc('getWaSetup')).replace(/token=\w+/, 'token=…'));
console.log('parse:', JSON.stringify(parseKaam('#todo Maruti Paper - rate confirm parso', now)), shortParty('XPP l AK Industries'));

// speed: 30k messages over 260 chats, then one inbox load
const ins = env.DB.raw.prepare('INSERT INTO messages (id, received_at, t, event, chat, is_group, from_me, sender, sender_name, type, text, tag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
env.DB.raw.exec('BEGIN');
for (let i = 0; i < 30000; i++) ins.run('P' + i, now, now - (i % 2880) * 60000, 'x', 'B' + (i % 260) + '@g.us', 1, i % 50 === 0 ? 1 : 0, 's', 'Someone', 'text', 'load test message number ' + i, i % 97 === 0 ? 1 : 0);
env.DB.raw.exec('COMMIT');
let t0 = performance.now();
d = await rpc('getWaInbox', 2);
const ms = performance.now() - t0;
console.log(`\nload test: ${d.chats.length} chats, inbox ${JSON.stringify(d).length / 1024 | 0} KB in ${ms | 0} ms`);
t0 = performance.now();
const one = await rpc('getWaChat', 'B5@g.us', 2);
console.log(`open one chat: ${one.msgs.length} msgs (+${one.more} older), ${JSON.stringify(one).length / 1024 | 0} KB in ${(performance.now() - t0) | 0} ms`);
console.log('\nALL TESTS PASSED');
