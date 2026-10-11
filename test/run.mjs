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
assert.match(briefText(d, 'evening'), /Zaroori baaki/);
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
assert.match(briefText(d, 'evening'), /Task List: 1 task baaki/);
// rules changed after messages were stored: the version bump re-checks them (old flags get new reasons)
env.DB.raw.prepare("UPDATE flags SET reasons = 'neeraj' WHERE msg_id = 'R1'").run();
env.DB.raw.prepare("DELETE FROM settings WHERE k = 'flags_version'").run();
d = await rpc('getWaInbox', 2);
assert.deepEqual(zf('R1').reasons, ['tasksys'], 're-checked');

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
