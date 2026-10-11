// End-to-end tests: real SQL (node:sqlite standing in for D1), fake WaSender.
// Run: node test/run.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeD1 } from './d1.mjs';
import { makeWorker, dayKey, parseKaam, shortParty, briefText, flagReasons, ownerOf, taskKey } from '../src/app.js';

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
const worker = makeWorker('<html>INBOX</html>', fs.readFileSync(ROOT + 'src/wa-sync.user.js', 'utf8'), fs.readFileSync(ROOT + 'src/wa-core.js', 'utf8'));
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
let tasks = await rpc('addWaTask', { kaam: '=SUM(1) +91 wale ko call', party: 'Maruti', type: 'Reply', due: dayKey(now - 2 * 86400000), team: 'Self' });
const t3 = tasks.find(t => t.party === 'Maruti');
assert.equal(t3.kaam, '=SUM(1) +91 wale ko call');
tasks = await rpc('updateWaTask', t3.id, { status: 'Done', note: 'ho gaya' });
assert.equal(tasks.find(t => t.id === t3.id).status, 'Done');
const before = tasks.length;
tasks = await rpc('addWaTask', { kaam: 'pehla', msgId: 'M1', chat: 'G1@g.us' });
tasks = await rpc('addWaTask', { kaam: 'doosra', msgId: 'M1', chat: 'G1@g.us' });
assert.equal(tasks.length, before + 2, 'two tasks from one message both saved');
await assert.rejects(rpc('addWaTask', { kaam: ' ' }), /empty|describe/);
await assert.rejects(rpc('addWaTask', { kaam: 'x', due: '12/10' }), /due date/);
tasks = await rpc('sendWaTaskToTeam', k1.id, 'G2@g.us', 'Payment — Jyoti kal', 'Accounts');
assert.match(tasks.find(t => t.id === k1.id).notified, /Internal Payment Request/);
await assert.rejects(rpc('sendWaTaskToTeam', k1.id, '1@s.whatsapp.net', 'x', 'Accounts'), /group/);
await assert.rejects(rpc('sendWaTaskToTeam', 'nope', 'G2@g.us', 'x', 'Accounts'), /not found/);
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

// WhatsApp Web script: served only when logged in, with the endpoint filled in; its rows are stored.
assert.match(await (await req('/wa-sync.user.js')).text(), /password/, 'script needs login');
const us = await (await req('/wa-sync.user.js', { headers: { cookie } })).text();
assert.ok(us.includes(setup.webhookUrl) && !us.includes('__ENDPOINT__'), 'endpoint baked in');
const coreUrl = new URL(setup.webhookUrl.replace('/webhook?', '/wa-core.js?'));
assert.equal((await req('/wa-core.js?token=nope')).status, 401, 'core needs the token');
assert.match(await (await req(coreUrl.pathname + coreUrl.search)).text(), /WPP\.loader \|\| WPP\.webpack/, 'core served with token');
const before2 = env.DB.raw.prepare('SELECT COUNT(*) c FROM messages').get().c;
const webRows = [];
for (let i = 0; i < 450; i++) webRows.push({ id: 'W' + i, t: now - i * 60000, chat: 'G' + (100 + (i % 30)) + '@g.us', chat_name: 'Web Group ' + (i % 30),
  from_me: 0, sender: '777@lid', sender_phone: '', sender_name: '', type: 'text', text: i === 5 ? '@' + ME_LID + ' dekhiye' : 'web msg ' + i,
  mentions: i === 5 ? ME_LID + '@lid' : '', reply_to: '' });
webRows.push({ id: 'Wpers', t: now - 1000, chat: '917777700000@s.whatsapp.net', from_me: 0, sender: '917777700000@s.whatsapp.net', sender_phone: '917777700000', type: 'text', text: 'hello from web' });
webRows.push({ id: 'Wstatus', t: now, chat: 'status@broadcast', type: 'text', text: 'x' });
r = await post({ event: 'xp.rows', data: { rows: webRows } });
assert.equal(r.status, 200);
await post({ event: 'xp.rows', data: { rows: webRows } });   // re-sent on the next page load: no duplicates
assert.equal(env.DB.raw.prepare('SELECT COUNT(*) c FROM messages').get().c - before2, 451, '450 group + 1 personal, rows capped at 500, status skipped');
d = await rpc('getWaInbox', 2);
assert.equal(by('Web Group 5').pending, 1, 'LID mention from WhatsApp Web is a tag');
assert.equal(by('Web Group 5').preview.who, 'Ramesh Jyoti', 'sender named from contacts');
assert.equal(env.DB.raw.prepare("SELECT name FROM chats WHERE jid = 'G105@g.us'").get().name, 'Web Group 5');
assert.ok((await rpc('getWaSetup')).webSync > 0);

// Zaroori: tag in a group, "Neeraj" anywhere, payment asked — stays until ticked, whatever happens on WhatsApp.
assert.deepEqual(flagReasons({ is_group: 1, tag: 1, text: 'Neeraj ji payment kab?' }), ['tag', 'neeraj', 'payment']);
assert.deepEqual(flagReasons({ is_group: 0, tag: 1, text: 'hello' }), [], 'a 1:1 hello is not zaroori');
assert.deepEqual(flagReasons({ is_group: 1, tag: 0, text: 'pymt kara do sir' }), ['payment']);
assert.deepEqual(flagReasons({ is_group: 1, tag: 0, text: 'नीरज जी का भुगतान' }), ['neeraj', 'payment']);
assert.deepEqual(flagReasons({ is_group: 1, tag: 0, text: 'dispatch ho gaya, payment terms as per PO', from_me: 1 }), [], 'own messages never');
assert.deepEqual(flagReasons({ is_group: 1, tag: 0, text: 'gaadi gate pe hai' }), []);
// Messages stored before the list existed are checked once on the next load.
env.DB.raw.prepare("INSERT INTO messages (id, received_at, t, event, chat, is_group, from_me, text, tag) VALUES ('OLD1', ?, ?, 'x', 'G1@g.us', 1, 0, 'Neeraj ji ka payment', 0)").run(now, now - 90000);
env.DB.raw.prepare("DELETE FROM settings WHERE k = 'flags_version'").run();
d = await rpc('getWaInbox', 2);
assert.deepEqual(d.flags.find(f => f.id === 'OLD1').reasons, ['neeraj', 'payment'], 'backfilled');
await post({ event: 'xp.rows', data: { rows: [
  { id: 'Z1', t: now - 50000, chat: 'G1@g.us', sender: '777@lid', text: 'Sir 3 bill ka payment pending hai' },
  { id: 'Z2', t: now - 40000, chat: 'G3@g.us', sender: '555@lid', text: 'Neeraj sir se baat ho gayi' },
  { id: 'Z3', t: now - 30000, chat: 'G3@g.us', sender: '555@lid', text: 'material aa gaya' },
  { id: 'Z4', t: now - 20000, chat: 'G3@g.us', from_me: 1, text: 'ok thik hai payment kal' }] } });
d = await rpc('getWaInbox', 2);
const zf = id => d.flags.find(f => f.id === id);
assert.deepEqual(zf('Z1').reasons, ['payment']);
assert.deepEqual(zf('Z2').reasons, ['neeraj']);
assert.ok(!zf('Z3') && !zf('Z4'), 'plain and own messages are not flagged');
assert.ok(zf('M1') && zf('M1').reasons.indexOf('tag') !== -1, 'earlier group tag is on the list');
assert.equal(zf('Z2').done, 0, 'replying on WhatsApp (Z4) does not clear it');
await rpc('markWaFlags', ['Z1', 'Z2'], true);
d = await rpc('getWaInbox', 2);
assert.ok(zf('Z1').done > 0, 'ticked today stays visible as done');
await rpc('markWaFlags', ['Z2'], false);
d = await rpc('getWaInbox', 2);
assert.equal(zf('Z2').done, 0, 'undo');
// redelivery does not reopen a ticked item
await post({ event: 'xp.rows', data: { rows: [{ id: 'Z1', t: now - 50000, chat: 'G1@g.us', sender: '777@lid', text: 'Sir 3 bill ka payment pending hai' }] } });
d = await rpc('getWaInbox', 2);
assert.ok(zf('Z1').done > 0, 'redelivery keeps it done');
assert.match(briefText(d, 'evening'), /Priority pending/);
// nightly prune keeps old messages that are still open on the list
env.DB.raw.prepare("UPDATE messages SET received_at = ? WHERE id IN ('Z2', 'Z3')").run(now - 40 * 86400000);
await worker.scheduled({ cron: '0 21 * * *' }, env, ctx);
assert.ok(env.DB.raw.prepare("SELECT 1 FROM messages WHERE id = 'Z2'").get(), 'open flag kept');
assert.ok(!env.DB.raw.prepare("SELECT 1 FROM messages WHERE id = 'Z3'").get(), 'plain old message pruned');

// Task-system reminders → Task List only; owners → Owners tab.
const REM = "Neeraj, 'Debit note to Shakti Gum' was due on 10 Oct. When will you close it? If the date has moved, change it here: https://tools.xpertpack.in/tasks/t/k0tIhWwvjSbeNvSP";
assert.deepEqual(flagReasons({ is_group: 0, tag: 1, text: REM, sender_phone: '918447731703' }), ['tasksys'], 'reminder is a task, not Neeraj/owner');
assert.equal(taskKey(REM), 'k0tIhWwvjSbeNvSP');
assert.equal(ownerOf('+91 84477 31702'), 'Hitesh Sir');
assert.equal(ownerOf('918447731707'), 'Raj Kumar Sir');
assert.equal(ownerOf('919999900000'), '');
assert.deepEqual(flagReasons({ is_group: 1, tag: 0, text: 'kal meeting hai', sender_phone: '918383828836' }), ['owner']);
// an owner in a LID group: phone found through the contact list
env.DB.raw.prepare("INSERT INTO contacts (jid, name, pn) VALUES ('999@lid', 'Anant Sir', '918447731703')").run();
await post({ event: 'xp.rows', data: { rows: [
  { id: 'O1', t: now - 5000, chat: 'G3@g.us', sender: '999@lid', text: 'Store ka stock check karo' },
  { id: 'R1', t: now - 90000, chat: '918447731703@s.whatsapp.net', sender: '918447731703@s.whatsapp.net', sender_phone: '918447731703', text: REM },
  { id: 'R2', t: now - 4000, chat: '918447731703@s.whatsapp.net', sender: '918447731703@s.whatsapp.net', sender_phone: '918447731703', text: REM }] } });
d = await rpc('getWaInbox', 2);
assert.deepEqual(zf('O1').reasons, ['owner']); assert.equal(zf('O1').owner, 'Anant Sir');
assert.deepEqual(zf('R1').reasons, ['tasksys']); assert.deepEqual(zf('R2').reasons, ['tasksys']);
assert.match(briefText(d, 'evening'), /Open tasks: 1/);
// rules changed after messages were stored: the version bump re-checks them (old flags get new reasons)
env.DB.raw.prepare("UPDATE flags SET reasons = 'neeraj' WHERE msg_id = 'R1'").run();
env.DB.raw.prepare("DELETE FROM settings WHERE k = 'flags_version'").run();
d = await rpc('getWaInbox', 2);
assert.deepEqual(zf('R1').reasons, ['tasksys'], 're-checked');

// GPS / vehicle updates never show, whoever sends them.
const GPS = '🔁 *HR 47 G 9376* is still at *Sona BLW* — *4h 13m* so far (arrived Sun 11 Oct 09:17). no trip ID in the gate app Still there. https://maps.google.com/?q=28.36630,76.93720';
assert.deepEqual(flagReasons({ is_group: 1, text: GPS, sender_phone: '918447731703' }), [], 'GPS from an owner is still noise');
assert.deepEqual(flagReasons({ is_group: 1, text: 'Neeraj payment', chat_name: 'X - GPS Data' }), [], 'nothing from a GPS group');
env.DB.raw.prepare("INSERT INTO chats (jid, name, kind) VALUES ('GPS@g.us', 'X - GPS Data', 'group')").run();
await post({ event: 'xp.rows', data: { rows: [{ id: 'GPS1', t: now - 3000, chat: 'GPS@g.us', sender: '918447731703@s.whatsapp.net', sender_phone: '918447731703', text: GPS }] } });
d = await rpc('getWaInbox', 2);
assert.ok(!zf('GPS1'), 'GPS not flagged');
// an old flag from before the rule is dropped by the re-check
env.DB.raw.prepare("INSERT INTO flags (msg_id, chat, t, reasons) VALUES ('GPS1', 'GPS@g.us', ?, 'owner')").run(now - 3000);
env.DB.raw.prepare("DELETE FROM settings WHERE k = 'flags_version'").run();
d = await rpc('getWaInbox', 2);
assert.ok(!zf('GPS1'), 'stale GPS flag dropped');

// Replies: queued on the dashboard, claimed + sent by WhatsApp Web, or sent by WaSender as fallback.
const ob = new URL(setup.webhookUrl.replace('/webhook?', '/wa-outbox?'));
const obUrl = ob.pathname + ob.search;
assert.equal((await req('/wa-outbox?token=nope')).status, 401);
d = await rpc('getWaInbox', 2);
assert.equal(d.webLive, false, 'no WhatsApp Web yet');
await assert.rejects(rpc('queueWaReply', { chat: 'G1@g.us', quote: 'M1', text: '  ' }), /empty|describe/);
await assert.rejects(rpc('queueWaReply', { chat: 'nope@g.us', text: 'x' }), /not in the list/);
const q1 = await rpc('queueWaReply', { chat: 'G1@g.us', quote: 'M1', text: 'Ji sir, kal tak', flagId: 'M1', markDone: true });
let claim = await (await req(obUrl)).json();
assert.deepEqual(claim.items.map(i => [i.id, i.chat, i.quote, i.text]), [[q1.id, 'G1@g.us', 'M1', 'Ji sir, kal tak']]);
assert.equal((await (await req(obUrl)).json()).items.length, 0, 'claimed once only');
d = await rpc('getWaInbox', 2);
assert.equal(d.webLive, true, 'polling counts as live');
await req(obUrl, { method: 'POST', body: JSON.stringify({ id: q1.id, ok: true }) });
d = await rpc('getWaInbox', 2);
assert.equal(d.outbox.find(o => o.id === q1.id).status, 'sent');
assert.ok(zf('M1').done > 0, 'flag ticked after the reply went');
// a WhatsApp Web failure, then the WaSender fallback (personal chat: sent to the number)
const q2 = await rpc('queueWaReply', { chat: '917777700000@s.whatsapp.net', quote: 'M4', text: 'Ji' });
claim = await (await req(obUrl)).json();
await req(obUrl, { method: 'POST', body: JSON.stringify({ id: q2.id, ok: false, error: 'chat not found' }) });
const sentBefore = sent.length;
await rpc('sendWaReplyNow', q2.id);
assert.deepEqual(sent[sentBefore], { to: '+917777700000', text: 'Ji' });
d = await rpc('getWaInbox', 2);
assert.equal(d.outbox.find(o => o.id === q2.id).via, 'wasender');
// a claim nobody answers turns into a failure after 2 minutes
const q3 = await rpc('queueWaReply', { chat: 'G1@g.us', text: 'x' });
await req(obUrl);
env.DB.raw.prepare('UPDATE outbox SET claimed_at = ? WHERE id = ?').run(now - 5 * 60000, q3.id);
await req(obUrl);
d = await rpc('getWaInbox', 2);
assert.equal(d.outbox.find(o => o.id === q3.id).status, 'failed');

// Detail panel: the message in full plus the conversation around it.
const cx = await rpc('getWaContext', 'Z2');
assert.equal(cx.msg.text, 'Neeraj sir se baat ho gayi');
assert.ok(cx.around.some(m => m.focus && m.id === 'Z2') && cx.around.length > 1);
await assert.rejects(rpc('getWaContext', 'nope'), /not found/);

// Report + export
const rp = await rpc('getWaReport', dayKey(now).slice(0, 7));
assert.ok(rp.totals.zIn > 0 && rp.totals.tIn === 1, 'zaroori counted, task reminders counted once per task: ' + JSON.stringify(rp.totals));
assert.ok(rp.totals.zDone > 0 && rp.speed.handled > 0);
assert.ok(rp.totals.replies >= 2 && rp.openNow.task === 1);
const csv = await (await req('/export/items.csv', { headers: { cookie } })).text();
assert.ok(csv.replace(/^\ufeff/, '').startsWith('Received,List,Why') && /Task List/.test(csv) && /Priority/.test(csv));
assert.ok(/"'=SUM/.test(await (await req('/export/worklist.csv', { headers: { cookie } })).text()), 'formula-looking text defused for Excel');
assert.match(await (await req('/export/items.csv')).text(), /password/, 'export needs login');
// nightly clean-up keeps every listed message, ticked or not
env.DB.raw.prepare("UPDATE messages SET received_at = ? WHERE id = 'Z1'").run(now - 60 * 86400000);
await worker.scheduled({ cron: '0 21 * * *' }, env, ctx);
assert.ok(env.DB.raw.prepare("SELECT 1 FROM messages WHERE id = 'Z1'").get(), 'ticked item kept for the record');

// ---------- lock and fingerprint sign-in ----------
const ORIGIN = 'https://wa.example.workers.dev';
const sid = c => decodeURIComponent(c.split('=')[1]).split('.')[0];
const loginCookie = async () => (await req('/login', { method: 'POST', body: new URLSearchParams({ password: 'secret-pass' }) })).headers.get('set-cookie').split(';')[0];
const rpcAs = async (c, fn, args = [], extra = {}) => (await req('/api/rpc', { method: 'POST', headers: Object.assign({ cookie: c, origin: ORIGIN }, extra), body: JSON.stringify({ fn, args }) }));
// idle: the auto-refresh alone does not keep a session open; real use does
let c2 = await loginCookie();
assert.equal((await rpc('getWaSecurity')).lockMin, 15, 'auto-lock defaults to 15 minutes');
env.DB.raw.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(Date.now() - 10 * 60000, sid(c2));
assert.equal((await rpcAs(c2, 'touchWa')).status, 200);
assert.ok(env.DB.raw.prepare('SELECT last_active FROM sessions WHERE id = ?').get(sid(c2)).last_active < Date.now() - 9 * 60000, 'background call does not count as use');
await rpcAs(c2, 'touchWa', [], { 'x-xp-active': '1' });
assert.ok(env.DB.raw.prepare('SELECT last_active FROM sessions WHERE id = ?').get(sid(c2)).last_active > Date.now() - 5000, 'real use keeps it open');
env.DB.raw.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(Date.now() - 21 * 60000, sid(c2));
assert.equal((await rpcAs(c2, 'touchWa')).status, 401, 'idle past the lock time + grace → signed out on the server');
assert.match(await (await req('/?locked=1', { headers: { cookie: c2 } })).text(), /Dashboard locked/);
await rpc('setWaLockMinutes', 60);
assert.equal((await rpc('getWaSecurity')).lockMin, 60);
assert.equal(await rpc('setWaLockMinutes', 7), 15, 'only the offered lock times are accepted');
// lock (what the page sends on Windows+L): the session is gone, a reload shows the sign-in page
c2 = await loginCookie();
assert.equal((await req('/logout', { method: 'POST', headers: { cookie: c2, origin: 'null' } })).status, 204);
assert.equal((await rpcAs(c2, 'touchWa')).status, 401, 'locked session refused');
assert.match(await (await req('/', { headers: { cookie: c2 } })).text(), /type="password"/);
assert.doesNotMatch(await (await req('/')).text(), /Sign in with fingerprint/, 'no fingerprint button before one is added');
assert.match((await (await req('/auth/passkey/options', { method: 'POST' })).json()).error, /No fingerprint/);

// a pretend Windows Hello: real keys, the same bytes a browser would send
const enc = new TextEncoder();
const authData = async (count, flags = 0x05) => {
  const a = new Uint8Array(37);
  a.set(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('wa.example.workers.dev'))));
  a[32] = flags; new DataView(a.buffer).setUint32(33, count);
  return a;
};
const toDer = raw => {
  const int = v => { let i = 0; while (i < v.length - 1 && v[i] === 0) i++; v = v.slice(i); if (v[0] & 0x80) v = Uint8Array.of(0, ...v); return [0x02, v.length, ...v]; };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return Uint8Array.of(0x30, body.length, ...body);
};
const { b64u } = await import('../src/app.js');
async function device(alg) {
  const kp = alg === -7 ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    : await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' }, true, ['sign', 'verify']);
  return { alg, kp, id: b64u(crypto.getRandomValues(new Uint8Array(32))), count: 0, spki: b64u(await crypto.subtle.exportKey('spki', kp.publicKey)) };
}
const cdj = (type, challenge, origin = ORIGIN) => enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
async function register(dev, password = 'secret-pass', opts = {}) {
  const o = await rpc('passkeyRegOptions', password);
  assert.equal(o.rpId, 'wa.example.workers.dev');
  return rpc('passkeyRegister', { password, name: 'Office laptop', id: dev.id, publicKey: dev.spki, alg: dev.alg,
    clientDataJSON: b64u(cdj('webauthn.create', opts.challenge || o.challenge, opts.origin)), authenticatorData: b64u(await authData(0, opts.flags)) });
}
async function signIn(dev, opts = {}) {
  const o = await (await req('/auth/passkey/options', { method: 'POST' })).json();
  const cd = cdj('webauthn.get', opts.challenge || o.challenge, opts.origin);
  const ad = await authData(opts.count != null ? opts.count : ++dev.count, opts.flags);
  const msg = new Uint8Array([...ad, ...new Uint8Array(await crypto.subtle.digest('SHA-256', cd))]);
  let sig = new Uint8Array(await crypto.subtle.sign(dev.alg === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' }, (opts.signer || dev).kp.privateKey, msg));
  if (dev.alg === -7) sig = toDer(sig);
  const body = { id: dev.id, clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig) };
  const res = await req('/auth/passkey/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { res, j: await res.json(), body, o };
}
const ec = await device(-7), rsa = await device(-257);
await assert.rejects(rpc('passkeyRegOptions', 'wrong'), /Incorrect password/, 'adding a fingerprint needs the password');
await assert.rejects(register(ec, 'secret-pass', { origin: 'https://evil.example' }), /did not come from the dashboard/);
await assert.rejects(register(ec, 'secret-pass', { flags: 0x01 }), /did not verify/, 'fingerprint must actually be checked');
await assert.rejects(register(ec, 'secret-pass', { challenge: 'made-up' }), /expired/);
assert.equal(await register(ec), true);
assert.equal(await register(rsa), true);
assert.equal((await rpc('getWaSecurity')).passkeys.length, 2);
assert.match(await (await req('/?locked=1')).text(), /Sign in with fingerprint[\s\S]*navigator\.credentials\.get/, 'lock screen offers the fingerprint');
let si = await signIn(ec);
assert.equal(si.res.status, 200, JSON.stringify(si.j));
assert.deepEqual(si.o.ids.sort(), [ec.id, rsa.id].sort());
const c3 = si.res.headers.get('set-cookie').split(';')[0];
assert.equal((await rpcAs(c3, 'touchWa')).status, 200, 'fingerprint sign-in gives a working session');
assert.equal(env.DB.raw.prepare('SELECT via FROM sessions WHERE id = ?').get(sid(c3)).via, 'fingerprint');
assert.equal((await signIn(rsa)).res.status, 200, 'RS256 (TPM) keys work too');
// replay of the same signed answer, a wrong key, a wrong site, an old counter
const replay = await req('/auth/passkey/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(si.body) });
assert.equal(replay.status, 401, 'a challenge works once');
assert.equal((await signIn(ec, { signer: rsa.alg === ec.alg ? rsa : await device(-7) })).res.status, 401, 'signature from another key refused');
assert.match((await signIn(ec, { origin: 'https://evil.example' })).j.error, /did not come from the dashboard/);
assert.match((await signIn(ec, { count: 1 })).j.error, /counter/);
assert.match((await signIn(ec, { flags: 0x01 })).j.error, /did not verify/);
env.DB.raw.prepare("UPDATE settings SET v = '{\"n\":0,\"t\":0}' WHERE k = 'login_fails'").run();
assert.equal((await signIn(ec)).res.status, 200, 'still works after the refused attempts');
await rpc('removePasskey', rsa.id);
assert.equal((await signIn(rsa)).res.status, 401, 'removed fingerprint no longer signs in');
env.DB.raw.prepare("UPDATE settings SET v = '{\"n\":0,\"t\":0}' WHERE k = 'login_fails'").run();
await rpc('setWaLockMinutes', 15);

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
