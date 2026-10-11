/**
 * XpertPack — WhatsApp Inbox for the office number (XP Purchase), on Cloudflare Workers + D1.
 *
 *   POST /webhook?token=…   WaSender delivers every message / call here → stored in D1
 *   GET  /                  the dashboard (password or fingerprint sign-in; locks itself, see Login)
 *   POST /api/rpc           everything the dashboard asks for
 *   cron                    group names, morning / evening WhatsApp summary, nightly clean-up
 *
 * WaSender has no "fetch old messages" endpoint, so a message the webhook misses is gone — the
 * webhook path does as little as it can and never waits on WaSender's API.
 *
 * Times are stored as epoch ms. "Today" is always India's day (IST, UTC+5:30); the Worker
 * itself runs in UTC.
 */

const API = 'https://www.wasenderapi.com/api';
const IST = 19800000;
const DAY = 86400000;

export const KEEP_DAYS = 30;          // messages older than this are deleted nightly
const MAX_DAYS = 7;                   // longest window the Inbox loads
const MSGS_PER_CHAT = 60;             // newest N of an opened chat go to the browser
const TEXT_MAX = 700;                 // characters per message sent to the browser
const DONE_SHOWN_DAYS = 7;            // finished tasks stay visible this long
const SESSION_DAYS = 30;

const KEYWORDS = ['payment', 'pay', 'paisa', 'urgent', 'jaldi', 'asap', 'po', 'bill', 'invoice',
  'dispatch', 'material', 'maal', 'rate', 'delivery', 'pending', 'kab', 'cheque', 'neft', 'rtgs',
  'ledger', 'outstanding', 'advance', 'short', 'reject', 'damage', 'quality', 'vehicle', 'gaadi'];
const TASK_TYPES = ['Payment', 'Material', 'Follow-up', 'Reply', 'Other'];
const TEAMS = ['Self', 'Accounts', 'Store', 'Purchase', 'Production', 'Quality', 'Dispatch'];
const KAAM_RE = /^\s*#(kaam|task|todo)\b/i;

// What makes a message "zaroori". Checked on the text as sent (before @digits are turned into names).
const NEERAJ_RE = /neeraj|niraj|नीरज/i;
// A payment being asked about: the word in its usual spellings and typos, money-transfer terms,
// and the Hindi words. Deliberately not "amount", "due" or "invoice" alone — those turn up in
// every dispatch and quality message too.
const PAYMENT_RE = /\b(payments?|paymnt|paymt|pymt|pymnt|pmt|paiment|payement|pay|paise|paisa|outstanding|advance|neft|rtgs|imps|cheque|chq|ledger)\b|भुगतान|पेमेंट|पैसे/i;

// The company's task system sends daily "'X' was due on 10 Oct. When will you close it?" reminders
// with a link to the task. Those go to the Task List tab, not Zaroori.
const TASKSYS_RE = /tools\.xpertpack\.in\/tasks|\bwas due on\b[\s\S]*\bclose it\b/i;

// The company's owners — every message from them gets its own tab. Matched on the last 10 digits.
export const OWNERS = [
  { name: 'Anant Sir', phones: ['8447731703'] },
  { name: 'Hitesh Sir', phones: ['8447731702'] },
  { name: 'Raj Kumar Sir', phones: ['8383828836', '8447731707'] }
];
export function ownerOf(phone) {
  const d = String(phone || '').replace(/\D/g, '').slice(-10);
  if (d.length < 10) return '';
  for (const o of OWNERS) if (o.phones.indexOf(d) !== -1) return o.name;
  return '';
}

// Reasons a message is kept for the dashboard ([] = it is not). Only other people's messages.
//   tasksys  a task-system reminder (Task List tab — and nothing else, even though it names Neeraj)
//   owner    sent by one of the owners (Owners tab)
//   tag / neeraj / payment   the Zaroori tab
// Automatic vehicle/GPS updates ("HR 47 G 9376 is still at Sona BLW — 4h 13m so far … maps link").
// Never shown anywhere on the dashboard, whoever's number sends them.
const GPS_RE = /\bis still at\b[\s\S]*\bso far\b|\btrip id in the gate app\b|maps\.google\.[a-z.]+\/\?q=-?\d|\bGPS\b/i;
export function isNoise(r) {
  return GPS_RE.test(r.text || '') || /\bGPS\b/i.test(r.chat_name || '');
}

export function flagReasons(r) {
  if (r.from_me || isNoise(r)) return [];
  if (TASKSYS_RE.test(r.text || '')) return ['tasksys'];
  const out = [];
  if (ownerOf(r.sender_phone)) out.push('owner');
  if (r.is_group && r.tag) out.push('tag');
  if (NEERAJ_RE.test(r.text || '')) out.push('neeraj');
  if (PAYMENT_RE.test(r.text || '')) out.push('payment');
  return out;
}

// ===================================================================
// Small helpers
// ===================================================================
export function dayKey(ms) { return new Date(ms + IST).toISOString().slice(0, 10); }
export function parseDay(key) { return Date.parse(key + 'T00:00:00Z') - IST; }
export function dayStart(ms) { return parseDay(dayKey(ms)); }

// "91987…:12@s.whatsapp.net" → "91987…@s.whatsapp.net" (drops the linked-device suffix)
export function bare(jid) {
  if (!jid) return '';
  const s = String(jid), at = s.indexOf('@');
  return at < 0 ? s : s.slice(0, at).split(':')[0] + s.slice(at);
}
function digits(jid) {
  if (!jid) return '';
  const s = String(jid);
  if (/@lid$/.test(s)) return '';            // a LID is not a phone number, whatever it looks like
  return s.split('@')[0].split(':')[0].replace(/\D/g, '');
}
function prettyJid(jid) {
  const s = String(jid || '');
  return /@s\.whatsapp\.net$/.test(s) ? '+' + s.split('@')[0] : 'Unknown …' + s.split('@')[0].slice(-4);
}
function randomHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}
function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
// Supplier groups are named "XPP | …" (and the odd XXP / "XPP l" / "XPP-"); everything else
// starts as Internal and can be relabelled from the dashboard.
export function autoCategory(name, isGroup) {
  if (!isGroup) return 'Personal';
  return /^\s*(XPP|XXP)\b/i.test(name || '') ? 'Supplier' : 'Internal';
}
// "XPP | Jyoti Timbers | Orders & Bills" → "Jyoti Timbers | Orders & Bills"
export function shortParty(name) {
  const s = String(name || '');
  return s.replace(/^\s*(?:XPP|XXP|XP)\s*(?:\||[lI\-](?=\s))?\s*/i, '').trim() || s;
}

// ===================================================================
// Settings (D1) and WaSender
// ===================================================================
async function getSetting(env, k) {
  const r = await env.DB.prepare('SELECT v FROM settings WHERE k = ?').bind(k).first();
  return r ? r.v : null;
}
async function setSetting(env, k, v) {
  await env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind(k, String(v)).run();
}
// A random value generated once and kept — the webhook token and the cookie-signing key.
async function secretSetting(env, k) {
  let v = await getSetting(env, k);
  if (v) return v;
  await env.DB.prepare('INSERT OR IGNORE INTO settings (k, v) VALUES (?, ?)').bind(k, randomHex(24)).run();
  return getSetting(env, k);
}

export async function wa(env, method, path, payload) {
  if (!env.WASENDER_API_KEY) throw new Error('WASENDER_API_KEY is not set on the Worker.');
  const headers = { Authorization: 'Bearer ' + env.WASENDER_API_KEY };
  if (payload) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch (e) { body = {}; }
  if (!res.ok || body.success === false) {
    throw new Error('WaSender ' + res.status + ': ' + (body.message || text.slice(0, 200)));
  }
  return body.data !== undefined ? body.data : body;
}

// {pn, lid, name} of the office number, fetched once.
async function getMe(env) {
  const raw = await getSetting(env, 'me');
  if (raw) return JSON.parse(raw);
  const d = await wa(env, 'GET', '/user') || {};
  const me = { pn: bare(d.id), lid: bare(d.lid), name: d.name || '' };
  if (me.pn || me.lid) await setSetting(env, 'me', JSON.stringify(me));
  return me;
}
function meIdsOf(me) {
  const ids = [me && me.pn, me && me.lid].filter(Boolean);
  return { ids, nums: ids.map(j => j.split('@')[0]) };
}

// ===================================================================
// Webhook: payload → rows
// ===================================================================
const KIND_BY_KEY = {
  conversation: 'text', extendedTextMessage: 'text', imageMessage: 'image', videoMessage: 'video',
  audioMessage: 'audio', documentMessage: 'document', stickerMessage: 'sticker',
  locationMessage: 'location', liveLocationMessage: 'location', contactMessage: 'contact',
  contactsArrayMessage: 'contact', pollCreationMessage: 'poll', pollCreationMessageV2: 'poll',
  pollCreationMessageV3: 'poll', buttonsResponseMessage: 'text', listResponseMessage: 'text',
  templateButtonReplyMessage: 'text'
};
// Reactions, edits, deletes and key-exchange stubs arrive as messages too; none is something a
// person said, and counting them would inflate every "new messages" badge.
const SKIP_KEYS = ['reactionMessage', 'protocolMessage', 'pollUpdateMessage',
  'senderKeyDistributionMessage', 'messageContextInfo', 'keepInChatMessage'];
const CALL_STATUS = { offer: 'received', ringing: 'received', timeout: 'missed', reject: 'declined', accept: 'answered' };

function unwrap(msg) {
  for (let depth = 0; depth < 4; depth++) {
    const inner = (msg.ephemeralMessage || msg.viewOnceMessage || msg.viewOnceMessageV2 ||
      msg.viewOnceMessageV2Extension || msg.documentWithCaptionMessage || msg.editedMessage || {}).message;
    if (!inner) break;
    msg = inner;
  }
  return msg;
}
function contentKind(content) {
  const keys = Object.keys(content);
  for (const k of keys) {
    if (KIND_BY_KEY[k]) {
      let type = KIND_BY_KEY[k];
      if (type === 'audio' && content[k] && content[k].ptt) type = 'voice';
      return { type, node: typeof content[k] === 'object' ? content[k] : null };
    }
  }
  for (const k of keys) if (SKIP_KEYS.indexOf(k) === -1) return { type: k.replace(/Message$/, '') };
  return { skip: true };
}
// messageTimestamp turns up as a number, a numeric string, or a protobuf Long {low, high}.
function msgTime(ts, fallback) {
  if (ts === undefined || ts === null || ts === '') return fallback;
  const n = typeof ts === 'object' ? Number(ts.low) + Number(ts.high || 0) * 4294967296 : Number(ts);
  if (!n || isNaN(n)) return fallback;
  return n < 1e12 ? n * 1000 : n;
}

// WaSender's docs show data.messages as an object in some events and an array in others.
export function rowsFrom(body, now) {
  const ev = String((body && body.event) || '');
  const data = (body && body.data) || {};
  const fallback = body && body.timestamp ? Number(body.timestamp) * 1000 : now;
  // From the Tampermonkey script on WhatsApp Web (see userscript.js): rows already flat.
  if (ev === 'xp.rows') {
    const list = Array.isArray(data.rows) ? data.rows.slice(0, 500) : [];
    return list.filter(r => r && r.id && r.chat && !/@(broadcast|newsletter)$/.test(String(r.chat))).map(r => ({
      id: String(r.id).slice(0, 120), received_at: now, t: Number(r.t) || now, event: 'wa-web',
      chat: String(r.chat), chat_name: String(r.chat_name || '').slice(0, 200),
      is_group: /@g\.us$/.test(String(r.chat)) ? 1 : 0, from_me: r.from_me ? 1 : 0,
      sender: String(r.sender || ''), sender_phone: String(r.sender_phone || '').replace(/\D/g, ''),
      sender_name: String(r.sender_name || '').slice(0, 100), type: String(r.type || 'text').slice(0, 20),
      text: String(r.text || '').slice(0, 3000), mentions: String(r.mentions || '').slice(0, 2000),
      reply_to: String(r.reply_to || '')
    }));
  }
  if (ev === 'call') {
    let calls = data.call || data.calls || [];
    if (!Array.isArray(calls)) calls = [calls];
    return calls.filter(c => c && c.from).map(c => ({
      id: 'call:' + (c.id || c.from + ':' + now), received_at: now,
      t: c.date ? (Date.parse(c.date) || now) : now, event: 'call', chat: String(c.from),
      is_group: c.isGroup ? 1 : 0, from_me: 0, sender: String(c.from),
      sender_phone: c.callerPn ? digits(c.callerPn) : digits(c.from), sender_name: '',
      type: c.isVideo ? 'video call' : 'call',
      text: (c.isVideo ? 'Video call ' : 'Call ') + (CALL_STATUS[c.status] || 'received'), mentions: '', reply_to: ''
    }));
  }
  let list = data.messages;
  if (!list) return [];
  if (!Array.isArray(list)) list = [list];
  const out = [];
  for (const m of list) {
    if (!m || !m.key || !m.key.id) continue;
    const key = m.key, chat = String(key.remoteJid || '');
    if (!chat || /@(broadcast|newsletter)$/.test(chat)) continue;   // status, channels, broadcast lists
    const kind = contentKind(unwrap(m.message || {}));
    if (kind.skip) continue;
    const isGroup = /@g\.us$/.test(chat), fromMe = !!key.fromMe;
    const node = kind.node || {}, ctx = node.contextInfo || {};
    const content = unwrap(m.message || {});
    const text = m.messageBody || content.conversation || node.text || node.caption || node.fileName || node.title || '';
    out.push({
      id: String(key.id), received_at: now, t: msgTime(m.messageTimestamp, fallback), event: ev, chat,
      is_group: isGroup ? 1 : 0, from_me: fromMe ? 1 : 0,
      sender: isGroup ? (key.participant || key.participantLid || key.participantPn || '')
                      : (fromMe ? '' : (key.senderLid || key.senderPn || chat)),
      sender_phone: isGroup ? (key.cleanedParticipantPn || digits(key.participantPn))
                            : (fromMe ? '' : (key.cleanedSenderPn || digits(key.senderPn) || digits(chat))),
      sender_name: m.pushName || m.verifiedBizName || '',
      type: kind.type, text: String(text).slice(0, 3000),
      mentions: (ctx.mentionedJid || []).join(','), reply_to: ctx.participant || ''
    });
  }
  return out;
}

// Tagged: an @mention of the office number (by phone or by LID), or a reply quoting one of its
// messages. In a 1:1 chat every incoming message counts.
export function isTag(r, me) {
  if (r.from_me) return false;
  if (!r.is_group) return true;
  const { ids, nums } = me;
  if (String(r.mentions || '').split(',').some(j => j && ids.indexOf(bare(j.trim())) !== -1)) return true;
  if (r.reply_to && ids.indexOf(bare(r.reply_to)) !== -1) return true;
  return nums.some(n => n && String(r.text || '').indexOf('@' + n) !== -1);
}

const MSG_COLS = ['id', 'received_at', 't', 'event', 'chat', 'is_group', 'from_me', 'sender', 'sender_phone',
  'sender_name', 'type', 'text', 'mentions', 'reply_to', 'tag'];

// A batch of any size is stored in a handful of queries: the rows travel as ONE JSON parameter and
// SQLite's json_each unpacks them. Workers Free allows 50 D1 queries per request and 100 bound
// parameters per query, so a statement per message would cap a WhatsApp Web backfill at a few
// dozen messages.
export async function ingest(env, rows, waitUntil) {
  let me = { ids: [], nums: [] };
  try { me = meIdsOf(await getMe(env)); } catch (e) { /* storing the message matters more than tagging it */ }
  for (const r of rows) r.tag = isTag(r, me) ? 1 : 0;
  // A LID sender is not a phone number; the contact list knows which phone it belongs to.
  const lids = [...new Set(rows.filter(r => !r.from_me && !r.sender_phone && /@lid$/.test(r.sender || '')).map(r => bare(r.sender)))];
  if (lids.length) {
    const pns = {};
    (await env.DB.prepare('SELECT jid, pn FROM contacts WHERE pn IS NOT NULL AND jid IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(lids)).all()).results.forEach(c => { pns[c.jid] = c.pn; });
    rows.forEach(r => { if (!r.sender_phone && pns[bare(r.sender)]) r.sender_phone = pns[bare(r.sender)]; });
  }
  const data = JSON.stringify(rows.map(r => { const o = {}; MSG_COLS.forEach(c => { o[c] = r[c] === undefined ? null : r[c]; }); return o; }));

  // One row per chat seen in this batch (the "Message yourself" chat is notes, not a conversation).
  const chats = {};
  for (const r of rows) {
    if (me.ids.indexOf(bare(r.chat)) !== -1) continue;
    const c = chats[r.chat] || (chats[r.chat] = { jid: r.chat, name: '', kind: r.is_group ? 'group' : 'personal' });
    if (r.is_group && r.chat_name) c.name = r.chat_name;
    if (!r.is_group && !c.name) c.name = r.chat_name || (!r.from_me ? r.sender_name : '') || '';
  }

  const flags = [];
  const knownNames = {};
  (await env.DB.prepare('SELECT jid, name FROM chats WHERE jid IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify([...new Set(rows.map(r => r.chat))])).all()).results.forEach(c => { knownNames[c.jid] = c.name || ''; });
  for (const r of rows) {
    const why = flagReasons(Object.assign({}, r, { chat_name: r.chat_name || knownNames[r.chat] || '' }));
    if (why.length) flags.push({ msg_id: r.id, chat: r.chat, t: r.t, reasons: why.join(' ') });
  }

  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO flags (msg_id, chat, t, reasons) SELECT json_extract(value, '$.msg_id'), " +
      "json_extract(value, '$.chat'), json_extract(value, '$.t'), json_extract(value, '$.reasons') FROM json_each(?)"
    ).bind(JSON.stringify(flags)),
    env.DB.prepare('INSERT OR IGNORE INTO messages (' + MSG_COLS.join(', ') + ') SELECT ' +
      MSG_COLS.map(c => "json_extract(value, '$." + c + "')").join(', ') + ' FROM json_each(?)').bind(data),
    // Senders the payload left nameless get their name from the contact list.
    env.DB.prepare(
      "UPDATE messages SET sender_name = (SELECT name FROM contacts WHERE contacts.jid = messages.sender " +
      "OR contacts.jid = messages.sender_phone || '@s.whatsapp.net' LIMIT 1) " +
      "WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?)) AND from_me = 0 AND IFNULL(sender_name, '') = ''"
    ).bind(data),
    env.DB.prepare(
      "INSERT INTO chats (jid, name, kind) SELECT json_extract(value, '$.jid'), COALESCE(NULLIF(json_extract(value, '$.name'), ''), " +
      "(SELECT name FROM contacts WHERE contacts.jid = json_extract(value, '$.jid'))), " +
      "json_extract(value, '$.kind') FROM json_each(?) WHERE true ON CONFLICT(jid) DO UPDATE SET " +
      "name = CASE WHEN excluded.kind = 'group' THEN COALESCE(excluded.name, chats.name) ELSE COALESCE(chats.name, excluded.name) END"
    ).bind(JSON.stringify(Object.values(chats)))
  ]);

  // "#kaam …" from the office number → a task, once per message.
  for (const r of rows) {
    if (!r.from_me || !KAAM_RE.test(r.text || '')) continue;
    const self = me.ids.indexOf(bare(r.chat)) !== -1;
    const p = parseKaam(r.text, r.t);
    let party = p.party;
    if (!self && !party) {
      const c = await env.DB.prepare('SELECT name FROM chats WHERE jid = ?').bind(r.chat).first();
      party = c && c.name ? (r.is_group ? shortParty(c.name) : c.name) : '';
    }
    await insertTask(env, {
      created: r.t, source: 'WhatsApp #kaam', type: p.type, party, kaam: p.kaam, due: p.due, team: p.team,
      chat: self ? '' : r.chat, kaamMsgId: r.id, message: r.text
    });
  }

  // A group with no name yet: ask WaSender in the background, off the request's clock.
  const unnamed = Object.values(chats).filter(c => c.kind === 'group' && !c.name).map(c => c.jid).slice(0, 10);
  if (unnamed.length && waitUntil && env.WASENDER_API_KEY) {
    waitUntil((async () => {
      for (const jid of unnamed) {
        const c = await env.DB.prepare('SELECT name FROM chats WHERE jid = ?').bind(jid).first();
        if (c && c.name) continue;
        try {
          const meta = await wa(env, 'GET', '/groups/' + encodeURIComponent(jid) + '/metadata');
          const name = meta && (meta.subject || meta.name);
          if (name) await env.DB.prepare('UPDATE chats SET name = ? WHERE jid = ?').bind(name, jid).run();
        } catch (e) { /* the 6-hourly name sync will catch it */ }
      }
    })());
  }
}

export function parseKaam(text, atMs) {
  let body = String(text).replace(KAAM_RE, '').replace(/^[\s:\-–]+/, '').trim();
  let party = '';
  const cut = body.search(/:| - | – /);
  // A party name is short and has no digits — "payment 10:30 tak" is a time, not a supplier.
  if (cut > 0 && cut <= 40 && !/\d/.test(body.slice(0, cut))) {
    party = body.slice(0, cut).trim();
    body = body.slice(cut).replace(/^[\s:\-–]+/, '').trim() || body;
  }
  const low = ' ' + body.toLowerCase() + ' ';
  const base = dayStart(atMs || Date.now());
  let due = base;
  if (/\b(parso|parson|day after)\b/.test(low)) due = base + 2 * DAY;
  else if (/\b(kal|kl|tomorrow|tmrw)\b/.test(low)) due = base + DAY;
  const dm = low.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
  if (dm && +dm[1] >= 1 && +dm[1] <= 31 && +dm[2] >= 1 && +dm[2] <= 12) {
    const pad = n => ('0' + n).slice(-2);
    let y = dm[3] ? Number(dm[3].length === 2 ? '20' + dm[3] : dm[3]) : Number(dayKey(base).slice(0, 4));
    let at = parseDay(y + '-' + pad(dm[2]) + '-' + pad(dm[1]));
    // "5/1" written in December means next January, not eleven months ago.
    if (!dm[3] && at < base - 60 * DAY) at = parseDay((y + 1) + '-' + pad(dm[2]) + '-' + pad(dm[1]));
    if (!isNaN(at)) due = at;
  }
  const type = /\b(payment|pay|paisa|paise|neft|rtgs|cheque|bill|advance|outstanding)\b/.test(low) ? 'Payment'
    : /\b(material|maal|dispatch|delivery|gaadi|vehicle|stock|sample)\b/.test(low) ? 'Material'
    : /\b(reply|jawab|call back|callback|batana)\b/.test(low) ? 'Reply' : 'Follow-up';
  const team = /\baccounts?\b/.test(low) ? 'Accounts' : /\bstore\b/.test(low) ? 'Store'
    : type === 'Payment' ? 'Accounts' : 'Self';
  return { kaam: body || String(text), party, due: dayKey(due), type, team };
}

// ===================================================================
// Inbox
// ===================================================================
// WhatsApp writes a mention as raw digits — a phone number or a LID. Show a name instead.
function niceMentions(text, names, nums) {
  return String(text || '').replace(/@(\d{6,})/g, (all, d) => {
    if (nums.indexOf(d) !== -1) return '@Aap';
    const nm = names[d + '@lid'] || names[d + '@s.whatsapp.net'];
    return nm ? '@' + nm : all;
  });
}

// Raw digits in @mentions that need a contact lookup.
async function mentionNames(env, rows, nums) {
  const wanted = new Set();
  for (const m of rows) {
    (String(m.text || '').match(/@(\d{6,})/g) || []).forEach(x => {
      const d = x.slice(1);
      if (nums.indexOf(d) === -1) { wanted.add(d + '@lid'); wanted.add(d + '@s.whatsapp.net'); }
    });
  }
  const names = {}, list = [...wanted].slice(0, 400);
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    const r = await env.DB.prepare('SELECT jid, name FROM contacts WHERE jid IN (' + part.map(() => '?').join(',') + ')').bind(...part).all();
    r.results.forEach(x => { names[x.jid] = x.name; });
  }
  return names;
}

// One message as the browser sees it. `st` carries the chat's seen / tag / reply marks.
function msgOut(m, st, names, nums, isGroup) {
  const meMsg = !!m.from_me;
  const text = niceMentions(m.text, names, nums);
  return {
    id: m.id, t: m.t, me: meMsg, type: m.type || '', call: m.type === 'call' || m.type === 'video call',
    who: meMsg ? 'Aap' : (m.sender_name || (m.sender_phone ? '+' + m.sender_phone : prettyJid(bare(m.sender)))),
    text: text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) + '…' : text,
    tag: !!m.tag && isGroup,
    unseen: !meMsg && m.t > st.seen,
    pending: !!m.tag && m.t > st.lastOut && m.t > st.tags
  };
}

function windowStart(days) {
  days = Math.max(1, Math.min(MAX_DAYS, Number(days) || 2));
  return { days, since: dayStart(Date.now()) - (days - 1) * DAY };
}
async function selfFilter(env) {
  const me = await getMe(env).catch(() => ({ pn: '', lid: '', name: '' }));
  const { ids, nums } = meIdsOf(me);
  const list = ids.length ? ids : ['-'];
  return { me, nums, list, sql: 'chat NOT IN (' + list.map(() => '?').join(',') + ')' };
}

// The Inbox list: per-chat counts plus ONE preview line each. A chat's messages are fetched only
// when it is opened (getChat) — on a busy day the full set would be megabytes on a phone.
// Messages stored before the Zaroori list existed (or before a rule changed) get checked once.
// FLAGS_VERSION goes up whenever flagReasons changes, so old messages are re-checked against it.
const FLAGS_VERSION = '3';
async function backfillFlags(env) {
  if ((await getSetting(env, 'flags_version')) === FLAGS_VERSION) return;
  let me = { ids: [], nums: [] };
  try { me = meIdsOf(await getMe(env)); } catch (e) { /* tags already stored on each row */ }
  // Owners are recognised by phone; give LID senders theirs from the contact list (fetched now if
  // this is the first time the list carries phones).
  const havePn = await env.DB.prepare('SELECT 1 AS x FROM contacts WHERE pn IS NOT NULL LIMIT 1').first();
  if (!havePn && env.WASENDER_API_KEY) { try { await syncNames(env, true); } catch (e) { /* owners by phone only */ } }
  await env.DB.prepare(
    "UPDATE messages SET sender_phone = (SELECT pn FROM contacts WHERE contacts.jid = messages.sender) " +
    "WHERE IFNULL(sender_phone, '') = '' AND sender LIKE '%@lid' AND EXISTS (SELECT 1 FROM contacts WHERE contacts.jid = messages.sender AND pn IS NOT NULL)"
  ).run();
  const rows = (await env.DB.prepare(
    'SELECT m.id, m.chat, m.t, m.is_group, m.from_me, m.tag, m.text, m.sender_phone, c.name AS chat_name FROM messages m ' +
    'LEFT JOIN chats c ON c.jid = m.chat WHERE m.from_me = 0 AND m.received_at >= ?'
  ).bind(Date.now() - KEEP_DAYS * DAY).all()).results;
  const flags = [], drop = [];
  for (const r of rows) {
    if (me.ids.indexOf(bare(r.chat)) !== -1) continue;
    const why = flagReasons(r);
    if (why.length) flags.push({ msg_id: r.id, chat: r.chat, t: r.t, reasons: why.join(' ') });
    else drop.push(r.id);
  }
  // A rule that now says "not this one" takes it off the list (unless it was already ticked).
  for (let i = 0; i < drop.length; i += 2000) {
    await env.DB.prepare('DELETE FROM flags WHERE done_at IS NULL AND msg_id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(drop.slice(i, i + 2000))).run();
  }
  for (let i = 0; i < flags.length; i += 2000) {
    await env.DB.prepare(
      "INSERT INTO flags (msg_id, chat, t, reasons) SELECT json_extract(value, '$.msg_id'), " +
      "json_extract(value, '$.chat'), json_extract(value, '$.t'), json_extract(value, '$.reasons') FROM json_each(?) " +
      'WHERE true ON CONFLICT(msg_id) DO UPDATE SET reasons = excluded.reasons'
    ).bind(JSON.stringify(flags.slice(i, i + 2000))).run();
  }
  await setSetting(env, 'flags_version', FLAGS_VERSION);
}

async function getInbox(env, daysArg) {
  await backfillFlags(env);
  const { days, since } = windowStart(daysArg);
  const now = Date.now(), today = dayStart(now);
  const sf = await selfFilter(env);

  // Per-chat counts in one pass. "Replied" = the office number wrote in the chat later — replying
  // means you opened it and saw what was above, so that also counts as seen.
  const agg = await env.DB.prepare(
    'WITH w AS (SELECT * FROM messages WHERE t >= ? AND ' + sf.sql + '), ' +
    'lo AS (SELECT chat, MAX(t) AS last_out FROM w WHERE from_me = 1 GROUP BY chat) ' +
    'SELECT w.chat, COUNT(*) AS total, MAX(w.t) AS last_t, IFNULL(lo.last_out, 0) AS last_out, ' +
    'MAX(CASE WHEN w.from_me = 0 THEN w.t ELSE 0 END) AS last_in, ' +
    'SUM(CASE WHEN w.from_me = 0 AND w.t >= ? THEN 1 ELSE 0 END) AS today_in, ' +
    'SUM(CASE WHEN w.from_me = 0 AND w.t > MAX(IFNULL(c.seen_upto, 0), IFNULL(lo.last_out, 0)) THEN 1 ELSE 0 END) AS unseen, ' +
    'SUM(CASE WHEN w.tag = 1 AND w.t > IFNULL(lo.last_out, 0) AND w.t > IFNULL(c.tags_upto, 0) THEN 1 ELSE 0 END) AS pending, ' +
    "SUM(CASE WHEN w.type IN ('call', 'video call') THEN 1 ELSE 0 END) AS calls, " +
    'c.name, c.category, c.muted, c.seen_upto, c.tags_upto ' +
    'FROM w LEFT JOIN chats c ON c.jid = w.chat LEFT JOIN lo ON lo.chat = w.chat GROUP BY w.chat'
  ).bind(since, ...sf.list, today).all();

  const cols = 'id, t, chat, from_me, sender, sender_phone, sender_name, type, text, tag';
  const previews = await env.DB.prepare(
    'SELECT ' + cols + ' FROM (SELECT m.*, ROW_NUMBER() OVER (PARTITION BY chat ORDER BY t DESC) AS rn FROM messages m ' +
    'WHERE t >= ? AND ' + sf.sql + ') WHERE rn = 1').bind(since, ...sf.list).all();
  // Tags and calls are few; fetch them whole so the pinned list and the call log are exact.
  const tagged = await env.DB.prepare(
    'SELECT ' + cols + " FROM messages WHERE t >= ? AND (tag = 1 OR (type IN ('call', 'video call') AND t >= ?)) AND " + sf.sql + ' ORDER BY t'
  ).bind(since, today, ...sf.list).all();

  const names = await mentionNames(env, previews.results.concat(tagged.results), sf.nums);
  const byChat = {}, st = {};
  const chats = agg.results.map(a => {
    const isGroup = /@g\.us$/.test(a.chat);
    const name = a.name || (isGroup ? 'Group …' + a.chat.split('@')[0].slice(-6) : prettyJid(a.chat));
    st[a.chat] = { seen: Math.max(a.seen_upto || 0, a.last_out || 0), lastOut: a.last_out || 0, tags: a.tags_upto || 0, isGroup };
    return (byChat[a.chat] = {
      jid: a.chat, name, kind: isGroup ? 'group' : 'personal', cat: a.category || autoCategory(name, isGroup),
      muted: !!a.muted, unseen: a.unseen || 0, pending: a.pending || 0, calls: a.calls || 0, todayIn: a.today_in || 0,
      total: a.total, lastT: a.last_t, lastIn: a.last_in || 0, lastOut: a.last_out || 0, preview: null, lastPending: null
    });
  });
  for (const m of previews.results) {
    const c = byChat[m.chat];
    if (c) c.preview = msgOut(m, st[m.chat], names, sf.nums, st[m.chat].isGroup);
  }
  const callsToday = [];
  for (const m of tagged.results) {
    const c = byChat[m.chat];
    if (!c) continue;
    const o = msgOut(m, st[m.chat], names, sf.nums, st[m.chat].isGroup);
    if (o.pending) c.lastPending = { id: o.id, t: o.t, who: o.who, text: o.text.slice(0, 300), call: o.call };
    if (o.call && o.t >= today) callsToday.push({ jid: m.chat, id: o.id, t: o.t });
  }
  chats.sort((a, b) => b.lastT - a.lastT);

  const groups = (await env.DB.prepare("SELECT jid, name, category FROM chats WHERE kind = 'group' AND name IS NOT NULL").all())
    .results.map(g => ({ jid: g.jid, name: g.name, cat: g.category || autoCategory(g.name, true) }));
  groups.sort((a, b) => (a.cat === 'Internal' ? 0 : 1) - (b.cat === 'Internal' ? 0 : 1) || a.name.localeCompare(b.name));

  const last = await env.DB.prepare('SELECT MAX(received_at) AS r FROM messages').first();
  return {
    now, since, days, me: { name: sf.me.name }, lastArrival: (last && last.r) || 0, captured: 0,
    chats, callsToday, flags: await flagsOut(env, sf.nums, today), tasks: await tasksOut(env), groups,
    outbox: await outboxOut(env), webLive: await webLive(env),
    teamGroups: JSON.parse((await getSetting(env, 'team_groups')) || '{}'),
    keywords: KEYWORDS, types: TASK_TYPES, teams: TEAMS, owners: OWNERS.map(o => o.name)
  };
}

// Every open Zaroori item, whatever its age (up to the 30 days messages are kept), plus what was
// ticked off today so a mistaken tick can be undone.
async function flagsOut(env, nums, today) {
  const r = await env.DB.prepare(
    'SELECT f.msg_id, f.chat, f.t, f.reasons, f.done_at, m.from_me, m.sender, m.sender_phone, m.sender_name, m.type, m.text, ' +
    'c.name AS chat_name FROM flags f JOIN messages m ON m.id = f.msg_id LEFT JOIN chats c ON c.jid = f.chat ' +
    'WHERE f.done_at IS NULL OR f.done_at >= ? ORDER BY f.t DESC LIMIT 3000').bind(today).all();
  const names = await mentionNames(env, r.results, nums);
  return r.results.map(f => {
    const isGroup = /@g\.us$/.test(f.chat);
    const text = niceMentions(f.text, names, nums);
    return {
      id: f.msg_id, jid: f.chat, chat: f.chat_name || (isGroup ? 'Group …' + f.chat.split('@')[0].slice(-6) : prettyJid(f.chat)),
      group: isGroup, t: f.t, reasons: String(f.reasons).split(' ').filter(Boolean), done: f.done_at || 0,
      who: f.sender_name || (f.sender_phone ? '+' + f.sender_phone : prettyJid(bare(f.sender))),
      owner: ownerOf(f.sender_phone),
      type: f.type || '', text: text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) + '…' : text
    };
  });
}

async function markFlags(env, ids, done) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!list.length) return true;
  await env.DB.prepare('UPDATE flags SET done_at = ? WHERE msg_id IN (SELECT value FROM json_each(?))')
    .bind(done ? Date.now() : null, JSON.stringify(list)).run();
  return true;
}

// The messages of one chat, newest MSGS_PER_CHAT within the window, oldest first.
async function getChat(env, jid, daysArg) {
  const { since } = windowStart(daysArg);
  const sf = await selfFilter(env);
  jid = String(jid);
  const c = await env.DB.prepare('SELECT seen_upto, tags_upto FROM chats WHERE jid = ?').bind(jid).first() || {};
  const lo = await env.DB.prepare('SELECT MAX(t) AS t, COUNT(*) AS n FROM messages WHERE chat = ? AND t >= ? AND from_me = 1').bind(jid, since).first();
  const all = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat = ? AND t >= ?').bind(jid, since).first();
  const rows = (await env.DB.prepare(
    'SELECT id, t, chat, from_me, sender, sender_phone, sender_name, type, text, tag FROM messages ' +
    'WHERE chat = ? AND t >= ? ORDER BY t DESC LIMIT ?').bind(jid, since, MSGS_PER_CHAT).all()).results.reverse();
  const lastOut = (lo && lo.t) || 0;
  const s = { seen: Math.max(c.seen_upto || 0, lastOut), lastOut, tags: c.tags_upto || 0 };
  const names = await mentionNames(env, rows, sf.nums);
  const isGroup = /@g\.us$/.test(jid);
  return { jid, more: Math.max(0, ((all && all.n) || 0) - rows.length), msgs: rows.map(m => msgOut(m, s, names, sf.nums, isGroup)) };
}

// One message in full, with the conversation around it — the detail panel next to the cards.
async function getContext(env, msgId) {
  const sf = await selfFilter(env);
  const m = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(String(msgId)).first();
  if (!m) throw new Error('Message not found (it may be older than 30 days).');
  const cols = 'id, t, chat, from_me, sender, sender_phone, sender_name, type, text, tag';
  const before = (await env.DB.prepare('SELECT ' + cols + ' FROM messages WHERE chat = ? AND t < ? ORDER BY t DESC LIMIT 12')
    .bind(m.chat, m.t).all()).results.reverse();
  const after = (await env.DB.prepare('SELECT ' + cols + ' FROM messages WHERE chat = ? AND t > ? ORDER BY t LIMIT 8')
    .bind(m.chat, m.t).all()).results;
  const rows = before.concat([m], after);
  const names = await mentionNames(env, rows, sf.nums);
  const st = { seen: Infinity, lastOut: 0, tags: 0 };
  const isGroup = /@g\.us$/.test(m.chat);
  const full = r => Object.assign(msgOut(Object.assign({}, r, { tag: 0 }), st, names, sf.nums, isGroup),
    { text: niceMentions(r.text, names, sf.nums), owner: r.from_me ? '' : ownerOf(r.sender_phone), me: !!r.from_me });
  const chat = await env.DB.prepare('SELECT name FROM chats WHERE jid = ?').bind(m.chat).first();
  return { id: m.id, jid: m.chat, chat: (chat && chat.name) || prettyJid(m.chat), group: isGroup, msg: full(m),
           around: rows.map(r => Object.assign(full(r), { focus: r.id === m.id })) };
}

// Chats in the window with a message containing q — for the search box.
async function searchChats(env, q, daysArg) {
  q = String(q || '').trim();
  if (q.length < 2) return [];
  const { since } = windowStart(daysArg);
  const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
  const r = await env.DB.prepare(
    "SELECT DISTINCT chat FROM messages WHERE t >= ? AND (text LIKE ? ESCAPE '\\' OR sender_name LIKE ? ESCAPE '\\') LIMIT 300"
  ).bind(since, like, like).all();
  return r.results.map(x => x.chat);
}

// items: [{jid, t}] — each chat seen up to t.
async function markSeen(env, items) {
  const list = (items || []).filter(it => it && it.jid).map(it => ({
    jid: String(it.jid), kind: /@g\.us$/.test(it.jid) ? 'group' : 'personal', t: Number(it.t) || Date.now() }));
  if (!list.length) return true;
  await env.DB.prepare(
    "INSERT INTO chats (jid, kind, seen_upto) SELECT json_extract(value, '$.jid'), json_extract(value, '$.kind'), " +
    "json_extract(value, '$.t') FROM json_each(?) WHERE true ON CONFLICT(jid) DO UPDATE SET seen_upto = MAX(chats.seen_upto, excluded.seen_upto)"
  ).bind(JSON.stringify(list)).run();
  return true;
}
async function clearTags(env, jid, t) {
  const at = Number(t) || Date.now();
  await env.DB.prepare(
    "INSERT INTO chats (jid, kind, seen_upto, tags_upto) VALUES (?, ?, ?, ?) ON CONFLICT(jid) DO UPDATE SET " +
    'seen_upto = MAX(chats.seen_upto, excluded.seen_upto), tags_upto = MAX(chats.tags_upto, excluded.tags_upto)'
  ).bind(String(jid), /@g\.us$/.test(jid) ? 'group' : 'personal', at, at).run();
  return true;
}
async function setMuted(env, jid, muted) {
  await env.DB.prepare("INSERT INTO chats (jid, kind, muted) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET muted = excluded.muted")
    .bind(String(jid), /@g\.us$/.test(jid) ? 'group' : 'personal', muted ? 1 : 0).run();
  return true;
}
async function setCategory(env, jid, category) {
  const cat = String(category || '').trim().slice(0, 30) || null;
  await env.DB.prepare("INSERT INTO chats (jid, kind, category) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET category = excluded.category")
    .bind(String(jid), /@g\.us$/.test(jid) ? 'group' : 'personal', cat).run();
  return true;
}

// ===================================================================
// Tasks
// ===================================================================
function taskOut(r) {
  return {
    id: r.id, created: r.created, source: r.source || '', type: r.type || '', party: r.party || '',
    kaam: r.kaam || '', due: r.due || '', team: r.team || '', status: r.status || 'Open', doneAt: r.done_at || 0,
    chat: r.chat || '', msgId: r.msg_id || r.src_msg || '', message: r.message || '', notified: r.notified || '', note: r.note || ''
  };
}
async function tasksOut(env) {
  const r = await env.DB.prepare(
    "SELECT * FROM tasks WHERE status = 'Open' OR (status = 'Done' AND done_at >= ?) ORDER BY due, created"
  ).bind(Date.now() - DONE_SHOWN_DAYS * DAY).all();
  return r.results.map(taskOut);
}
function newId() {
  return 'K' + dayKey(Date.now()).slice(2).replace(/-/g, '') + '-' + randomHex(3).toUpperCase();
}
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function insertTask(env, t) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO tasks (id, created, source, type, party, kaam, due, team, status, chat, msg_id, src_msg, message, note) ' +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?)"
  ).bind(newId(), t.created || Date.now(), t.source || 'Dashboard',
         TASK_TYPES.indexOf(t.type) !== -1 ? t.type : 'Other', String(t.party || '').trim().slice(0, 200),
         String(t.kaam).trim().slice(0, 2000), t.due || dayKey(Date.now()),
         TEAMS.indexOf(t.team) !== -1 ? t.team : 'Self', t.chat || null,
         t.kaamMsgId || null, t.msgId || null,
         String(t.message || '').slice(0, 2000), String(t.note || '').slice(0, 1000)).run();
}

async function addTask(env, t) {
  t = t || {};
  if (!String(t.kaam || '').trim()) throw new Error('Please describe the work.');
  if (t.due && !DUE_RE.test(String(t.due))) throw new Error('The due date is not valid.');
  await insertTask(env, Object.assign({}, t, { source: t.msgId ? 'Message' : 'Dashboard' }));
  return tasksOut(env);
}

async function updateTask(env, id, patch) {
  patch = patch || {};
  const cur = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(String(id)).first();
  if (!cur) throw new Error('Item not found — please refresh the page.');
  const sets = [], vals = [];
  if (patch.status !== undefined) {
    const st = ['Open', 'Done', 'Cancelled'].indexOf(patch.status) !== -1 ? patch.status : 'Open';
    sets.push('status = ?', 'done_at = ?'); vals.push(st, st === 'Done' ? Date.now() : null);
  }
  if (patch.due !== undefined) {
    if (patch.due && !DUE_RE.test(String(patch.due))) throw new Error('The due date is not valid.');
    sets.push('due = ?'); vals.push(patch.due || null);
  }
  if (patch.kaam !== undefined) {
    if (!String(patch.kaam).trim()) throw new Error('The description cannot be empty.');
    sets.push('kaam = ?'); vals.push(String(patch.kaam).trim().slice(0, 2000));
  }
  if (patch.party !== undefined) { sets.push('party = ?'); vals.push(String(patch.party).trim().slice(0, 200)); }
  if (patch.type !== undefined && TASK_TYPES.indexOf(patch.type) !== -1) { sets.push('type = ?'); vals.push(patch.type); }
  if (patch.team !== undefined && TEAMS.indexOf(patch.team) !== -1) { sets.push('team = ?'); vals.push(patch.team); }
  if (patch.note !== undefined) { sets.push('note = ?'); vals.push(String(patch.note).slice(0, 1000)); }
  if (sets.length) await env.DB.prepare('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?').bind(...vals, String(id)).run();
  return tasksOut(env);
}

// Sends a task to a team's group from the office number. Only groups the inbox knows are accepted
// — this is not a general "send anywhere".
async function sendToTeam(env, id, groupJid, text, team) {
  groupJid = String(groupJid || ''); text = String(text || '').trim();
  if (!/@g\.us$/.test(groupJid)) throw new Error('Please choose a group.');
  if (!text) throw new Error('The message is empty.');
  const g = await env.DB.prepare('SELECT name FROM chats WHERE jid = ?').bind(groupJid).first();
  if (!g) throw new Error('This group is not in the list — use "Refresh group names" in Setup.');
  const task = await env.DB.prepare('SELECT id FROM tasks WHERE id = ?').bind(String(id)).first();
  if (!task) throw new Error('Item not found — please refresh the page.');
  await wa(env, 'POST', '/send-message', { to: groupJid, text });
  const stamp = new Date(Date.now() + IST).toISOString().replace(/^\d{4}-(\d\d)-(\d\d)T(\d\d:\d\d).*/, '$2-$1 $3') + ' → ' + (g.name || 'group');
  await env.DB.prepare('UPDATE tasks SET notified = ? WHERE id = ?').bind(stamp, String(id)).run();
  if (TEAMS.indexOf(team) !== -1 && team !== 'Self') {
    const map = JSON.parse((await getSetting(env, 'team_groups')) || '{}');
    map[team] = groupJid;
    await setSetting(env, 'team_groups', JSON.stringify(map));
  }
  return tasksOut(env);
}

// ===================================================================
// Replies from the dashboard
// ===================================================================
const WEB_LIVE_MS = 90000;     // WhatsApp Web counts as open if it asked for replies this recently

async function webLive(env) {
  return Date.now() - (Number(await getSetting(env, 'web_seen')) || 0) < WEB_LIVE_MS;
}

async function queueReply(env, o) {
  o = o || {};
  const chat = String(o.chat || ''), text = String(o.text || '').trim();
  if (!text) throw new Error('The reply is empty.');
  if (text.length > 4000) throw new Error('The reply is too long.');
  const known = await env.DB.prepare('SELECT 1 AS x FROM chats WHERE jid = ?').bind(chat).first();
  if (!known) throw new Error('This chat is not in the list — please refresh the page.');
  const id = 'R' + Date.now().toString(36) + randomHex(3);
  await env.DB.prepare('INSERT INTO outbox (id, created, chat, quote, text, flag_id, mark_done) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, Date.now(), chat, o.quote ? String(o.quote) : null, text, o.flagId ? String(o.flagId) : null, o.markDone ? 1 : 0).run();
  return { id, webLive: await webLive(env) };
}

// The fallback: straight through WaSender, no quote (WaSender can only quote what it sent itself).
async function sendReplyNow(env, id) {
  const o = await env.DB.prepare('SELECT * FROM outbox WHERE id = ?').bind(String(id)).first();
  if (!o) throw new Error('Reply not found.');
  if (o.status === 'sent') return true;
  if (o.status === 'sending' && Date.now() - (o.claimed_at || 0) < 120000) throw new Error('WhatsApp Web is sending it right now — please wait a moment.');
  let to = o.chat;
  if (/@s\.whatsapp\.net$/.test(to)) to = '+' + to.split('@')[0];
  else if (/@lid$/.test(to)) throw new Error('The phone number for this chat is unknown — please send it from WhatsApp Web.');
  await wa(env, 'POST', '/send-message', { to, text: o.text });
  await finishReply(env, o, true, 'wasender', '');
  return true;
}

async function finishReply(env, o, ok, via, error) {
  await env.DB.prepare('UPDATE outbox SET status = ?, via = ?, sent_at = ?, error = ? WHERE id = ?')
    .bind(ok ? 'sent' : 'failed', via || null, ok ? Date.now() : null, ok ? null : String(error || 'fail').slice(0, 300), o.id).run();
  if (ok && o.mark_done && o.flag_id) await markFlags(env, [o.flag_id], true);
}

// WhatsApp Web's side: hand out what is waiting (claimed so two tabs cannot both send it), and
// take back the result. Also its heartbeat, so the dashboard can say whether the tab is open.
async function outboxClaim(env) {
  const now = Date.now();
  if (now - (Number(await getSetting(env, 'web_seen')) || 0) > 60000) await setSetting(env, 'web_seen', now);
  await env.DB.prepare("UPDATE outbox SET status = 'failed', error = 'WhatsApp Web did not respond' WHERE status = 'sending' AND claimed_at < ?")
    .bind(now - 120000).run();
  const r = await env.DB.prepare(
    "UPDATE outbox SET status = 'sending', claimed_at = ? WHERE id IN (SELECT id FROM outbox WHERE status = 'pending' AND created > ? " +
    'ORDER BY created LIMIT 5) RETURNING id, chat, quote, text').bind(now, now - DAY).all();
  return r.results || [];
}
async function outboxAck(env, body) {
  const o = await env.DB.prepare('SELECT * FROM outbox WHERE id = ?').bind(String((body && body.id) || '')).first();
  if (!o) return false;
  await finishReply(env, o, !!body.ok, 'web', body.error);
  return true;
}

async function outboxOut(env) {
  const r = await env.DB.prepare(
    'SELECT id, created, chat, quote, text, status, via, sent_at, error FROM outbox WHERE created > ? ORDER BY created DESC LIMIT 300'
  ).bind(Date.now() - 2 * DAY).all();
  return r.results.map(o => ({ id: o.id, created: o.created, chat: o.chat, quote: o.quote || '', text: o.text,
    status: o.status, via: o.via || '', sentAt: o.sent_at || 0, error: o.error || '' }));
}

// ===================================================================
// Deleted on WhatsApp → deleted here
// ===================================================================
// WhatsApp Web reports three kinds of deletion:
//   msgs  — a message deleted for everyone (live, or seen as "This message was deleted" on reload);
//   snaps — "what WhatsApp still has": for one chat, every message id between two times. Anything
//           stored here in that window that WhatsApp no longer has was deleted ("delete for me");
//   chats — a whole chat deleted.
// Removed messages leave every tab, the report and the export. A copy goes to `trash` for 30 days.
const SNAP_MAX_LOSS = 25;   // a single chat "losing" more than this at once is more likely a loading gap than deletions

// The chats the dashboard holds, for WhatsApp Web to compare against its own list. `web` = the chat
// id came from WhatsApp Web itself (only those are checked for whole-chat deletion, because
// WaSender can name the same person differently); `flagFrom` = it has listed items, so WhatsApp
// Web checks further back in it.
async function waCheck(env) {
  const since = Date.now() - KEEP_DAYS * DAY;
  const rows = (await env.DB.prepare(
    "SELECT m.chat, MAX(m.event = 'wa-web') AS web, MIN(CASE WHEN f.msg_id IS NOT NULL AND m.t > ? THEN m.t END) AS flagFrom " +
    'FROM messages m LEFT JOIN flags f ON f.msg_id = m.id ' +
    "WHERE COALESCE(m.type, '') NOT IN ('call', 'video call') GROUP BY m.chat").bind(since).all()).results;
  return { chats: rows.map(r => ({ chat: r.chat, web: r.web ? 1 : 0, flagFrom: r.flagFrom || 0 })) };
}

async function waDeletes(env, b) {
  b = b || {};
  const out = { revoked: 0, deleted: 0, chats: 0, skipped: 0 };
  const revoked = (Array.isArray(b.msgs) ? b.msgs : []).map(m => String((m && m.id) || '')).filter(Boolean).slice(0, 500);
  if (revoked.length) out.revoked = await purge(env, revoked, 'revoked');

  const snaps = (Array.isArray(b.snaps) ? b.snaps : []).slice(0, 60)
    .filter(s => s && s.chat && Array.isArray(s.ids) && s.ids.length && Number(s.after) > 0 && Number(s.upto) > Number(s.after))
    .map(s => ({ chat: String(s.chat), after: Number(s.after), upto: Number(s.upto), ids: s.ids.map(String) }));
  if (snaps.length) {
    const lost = (await env.DB.prepare(
      'SELECT m.id, m.chat FROM json_each(?) s JOIN messages m ON m.chat = json_extract(s.value, \'$.chat\') ' +
      "AND m.t > json_extract(s.value, '$.after') AND m.t <= json_extract(s.value, '$.upto') " +
      "WHERE m.id NOT IN (SELECT value FROM json_each(json_extract(s.value, '$.ids'))) " +
      "AND COALESCE(m.event, '') <> 'call' AND COALESCE(m.type, '') NOT IN ('call', 'video call')")
      .bind(JSON.stringify(snaps)).all()).results;
    const perChat = {};
    lost.forEach(r => { (perChat[r.chat] = perChat[r.chat] || []).push(r.id); });
    let ids = [];
    Object.keys(perChat).forEach(c => {
      if (perChat[c].length > SNAP_MAX_LOSS) out.skipped += perChat[c].length; else ids = ids.concat(perChat[c]);
    });
    if (ids.length) out.deleted = await purge(env, ids, 'deleted');
  }

  const chats = (Array.isArray(b.chats) ? b.chats : []).map(String).filter(Boolean).slice(0, 30);
  if (chats.length) {
    // Only chats WhatsApp Web itself has reported (see waCheck).
    const known = (await env.DB.prepare("SELECT DISTINCT chat FROM messages WHERE event = 'wa-web' AND chat IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(chats)).all()).results.map(r => r.chat);
    if (known.length) {
      const ids = (await env.DB.prepare('SELECT id FROM messages WHERE chat IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(known)).all()).results.map(r => r.id);
      await purge(env, ids, 'chat');
      const j = JSON.stringify(known);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM flags WHERE chat IN (SELECT value FROM json_each(?))').bind(j),
        env.DB.prepare('DELETE FROM chats WHERE jid IN (SELECT value FROM json_each(?))').bind(j)
      ]);
      out.chats = known.length;
    }
  }
  return out;
}

// Removes messages (and their list entries) everywhere, keeping a 30-day copy in `trash`.
async function purge(env, ids, why) {
  if (!ids.length) return 0;
  const j = JSON.stringify(ids), now = Date.now();
  const res = await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO trash (id, deleted_at, why, msg, flag) SELECT m.id, ?, ?, ' +
      "json_object('id', m.id, 'received_at', m.received_at, 't', m.t, 'event', m.event, 'chat', m.chat, 'is_group', m.is_group, " +
      "'from_me', m.from_me, 'sender', m.sender, 'sender_phone', m.sender_phone, 'sender_name', m.sender_name, 'type', m.type, " +
      "'text', m.text, 'mentions', m.mentions, 'reply_to', m.reply_to, 'tag', m.tag), " +
      "(SELECT json_object('chat', f.chat, 't', f.t, 'reasons', f.reasons, 'done_at', f.done_at) FROM flags f WHERE f.msg_id = m.id) " +
      'FROM messages m WHERE m.id IN (SELECT value FROM json_each(?))').bind(now, why, j),
    env.DB.prepare('DELETE FROM flags WHERE msg_id IN (SELECT value FROM json_each(?))').bind(j),
    env.DB.prepare('DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))').bind(j)
  ]);
  return (res[2] && res[2].meta && res[2].meta.changes) || (res[2] && res[2].changes) || 0;
}

// ===================================================================
// Requests for Claude (the 🤖 Claude tab)
// ===================================================================
// The dashboard only stores them. Every hour Claude reads new ones through the "Claude requests"
// GitHub workflow, asks for confirmation in the Claude conversation, and only then does the work;
// its progress and result are written back the same way.
export const CLAUDE_SESSION_URL = 'https://claude.ai/code/session_01633qPBih7qj2wrMfaYWGTn';
// The conversations a request can be sent to: [{id, title}], newest first. Refreshed by Claude.
async function claudeSessions(env) {
  let list = [];
  try { list = JSON.parse((await getSetting(env, 'claude_sessions')) || '[]'); } catch (e) { list = []; }
  const own = CLAUDE_SESSION_URL.split('/').pop();
  if (!list.some(x => x.id === own)) list.unshift({ id: own, title: 'WhatsApp Inbox (this dashboard)' });
  return list;
}
async function getRequests(env) {
  return { session: CLAUDE_SESSION_URL, sessions: await claudeSessions(env), items: (await env.DB.prepare(
    "SELECT id, created, text, status, reply, updated, session, session_title FROM requests WHERE status IN ('new', 'asked', 'working') OR created > ? " +
    'ORDER BY created DESC LIMIT 200').bind(Date.now() - 60 * DAY).all()).results };
}
async function addRequest(env, text, sessionId) {
  const sessions = await claudeSessions(env);
  const target = sessions.find(x => x.id === sessionId) || sessions.find(x => CLAUDE_SESSION_URL.endsWith(x.id));
  text = String(text || '').trim();
  if (!text) throw new Error('Please write what needs to be done.');
  if (text.length > 4000) throw new Error('Please keep a request under 4,000 characters.');
  const id = randomHex(4);
  await env.DB.prepare("INSERT INTO requests (id, created, text, status, session, session_title) VALUES (?, ?, ?, 'new', ?, ?)")
    .bind(id, Date.now(), text, target.id, target.title).run();
  return id;
}
async function cancelRequest(env, id) {
  const r = await env.DB.prepare("UPDATE requests SET status = 'cancelled', updated = ? WHERE id = ? AND status IN ('new', 'asked')")
    .bind(Date.now(), String(id || '')).run();
  if (!r.meta.changes) throw new Error('Claude has already started on this request, so it cannot be cancelled here.');
  return true;
}

// ===================================================================
// Report for the directors — what came in, what was handled, how fast
// ===================================================================
function kindOf(reasons) {
  const r = String(reasons).split(' ');
  if (r.indexOf('tasksys') !== -1) return 'task';
  if (r.indexOf('owner') !== -1) return 'owner';
  return 'zaroori';
}

// month: 'yyyy-mm' (IST). Day-by-day counts plus totals and response times.
async function getReport(env, month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) month = dayKey(Date.now()).slice(0, 7);
  const start = parseDay(month + '-01');
  const [y, m] = month.split('-').map(Number);
  const end = parseDay((m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0')) + '-01');
  const flags = (await env.DB.prepare(
    'SELECT f.msg_id, f.t, f.reasons, f.done_at, m.text FROM flags f LEFT JOIN messages m ON m.id = f.msg_id ' +
    'WHERE (f.t >= ? AND f.t < ?) OR (f.done_at >= ? AND f.done_at < ?)').bind(start, end, start, end).all()).results;
  const tasks = (await env.DB.prepare(
    "SELECT created, done_at, status, due FROM tasks WHERE status != 'Cancelled' AND ((created >= ? AND created < ?) OR (done_at >= ? AND done_at < ?))"
  ).bind(start, end, start, end).all()).results;
  const replies = (await env.DB.prepare("SELECT sent_at FROM outbox WHERE status = 'sent' AND sent_at >= ? AND sent_at < ?")
    .bind(start, end).all()).results;

  const days = {};
  const day = k => days[k] || (days[k] = { day: k, zIn: 0, zDone: 0, oIn: 0, oDone: 0, tIn: 0, tDone: 0, wIn: 0, wDone: 0, replies: 0 });
  const inRange = t => t >= start && t < end;
  const seenTask = {}, closeHours = [];
  // Task-system reminders repeat daily: count each task once, on the day its first reminder came.
  const firstReminder = {};
  flags.filter(f => kindOf(f.reasons) === 'task').forEach(f => {
    const k = taskKey(f.text) || f.msg_id;
    if (!firstReminder[k] || f.t < firstReminder[k].t) firstReminder[k] = f;
  });
  for (const f of flags) {
    const kind = kindOf(f.reasons);
    if (kind === 'task') {
      const k = taskKey(f.text) || f.msg_id;
      if (firstReminder[k] === f && inRange(f.t)) day(dayKey(f.t)).tIn++;
      if (f.done_at && inRange(f.done_at) && !seenTask[k]) { seenTask[k] = 1; day(dayKey(f.done_at)).tDone++; }
      continue;
    }
    const pre = kind === 'owner' ? 'o' : 'z';
    if (inRange(f.t)) day(dayKey(f.t))[pre + 'In']++;
    if (f.done_at && inRange(f.done_at)) {
      day(dayKey(f.done_at))[pre + 'Done']++;
      if (f.done_at >= f.t) closeHours.push((f.done_at - f.t) / 3600000);
    }
  }
  for (const t of tasks) {
    if (inRange(t.created)) day(dayKey(t.created)).wIn++;
    if (t.status === 'Done' && t.done_at && inRange(t.done_at)) day(dayKey(t.done_at)).wDone++;
  }
  for (const r of replies) day(dayKey(r.sent_at)).replies++;

  const list = Object.keys(days).sort().map(k => days[k]);
  const sum = key => list.reduce((a, d) => a + d[key], 0);
  closeHours.sort((a, b) => a - b);
  const median = closeHours.length ? closeHours[Math.floor(closeHours.length / 2)] : 0;
  const within = h => closeHours.filter(x => x <= h).length;

  // Open right now (not just this month): what is still waiting.
  const openNow = (await env.DB.prepare('SELECT reasons, text FROM flags f LEFT JOIN messages m ON m.id = f.msg_id WHERE f.done_at IS NULL').all()).results;
  const openTasks = new Set(openNow.filter(f => kindOf(f.reasons) === 'task').map(f => taskKey(f.text) || f.text));
  const wl = await env.DB.prepare("SELECT SUM(status = 'Open') AS open, SUM(status = 'Open' AND due < ?) AS overdue FROM tasks").bind(dayKey(Date.now())).first();
  return {
    month, days: list,
    totals: { zIn: sum('zIn'), zDone: sum('zDone'), oIn: sum('oIn'), oDone: sum('oDone'), tIn: sum('tIn'), tDone: sum('tDone'),
              wIn: sum('wIn'), wDone: sum('wDone'), replies: sum('replies') },
    speed: { handled: closeHours.length, medianHours: Math.round(median * 10) / 10, sameDay: within(24), within3Days: within(72) },
    openNow: { zaroori: openNow.filter(f => kindOf(f.reasons) === 'zaroori').length,
               owner: openNow.filter(f => kindOf(f.reasons) === 'owner').length, task: openTasks.size,
               workList: (wl && wl.open) || 0, workListOverdue: (wl && wl.overdue) || 0 }
  };
}

function csvCell(v) {
  const s = String(v === null || v === undefined ? '' : v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s;
}
function istTime(ms) { return ms ? new Date(ms + IST).toISOString().slice(0, 16).replace('T', ' ') : ''; }

// Everything that ever came onto a list, and the whole Work List — for Excel. BOM so Excel reads Hindi.
async function exportCsv(env, which) {
  let rows;
  if (which === 'worklist') {
    const r = (await env.DB.prepare('SELECT * FROM tasks ORDER BY created').all()).results;
    rows = [['Added', 'Source', 'Type', 'Party', 'Work', 'Due', 'Team', 'Status', 'Done at', 'Days taken', 'Sent to team', 'Note', 'From message']]
      .concat(r.map(t => [istTime(t.created), t.source, t.type, t.party, t.kaam, t.due, t.team, t.status, istTime(t.done_at),
        t.done_at ? Math.round((t.done_at - t.created) / 864e5 * 10) / 10 : '', t.notified, t.note, t.message]));
  } else {
    const r = (await env.DB.prepare(
      'SELECT f.msg_id, f.t, f.reasons, f.done_at, m.sender_name, m.sender_phone, m.text, c.name AS chat_name, f.chat ' +
      'FROM flags f LEFT JOIN messages m ON m.id = f.msg_id LEFT JOIN chats c ON c.jid = f.chat ORDER BY f.t').all()).results;
    const rep = {};
    (await env.DB.prepare("SELECT quote, sent_at, text FROM outbox WHERE status = 'sent'").all()).results
      .forEach(o => { if (o.quote) rep[o.quote] = o; });
    rows = [['Received', 'List', 'Why', 'Group / chat', 'From', 'Owner', 'Message', 'Task id', 'Marked done', 'Hours taken', 'Reply sent', 'Reply']]
      .concat(r.map(f => {
        const kind = kindOf(f.reasons);
        return [istTime(f.t), kind === 'task' ? 'Task List' : kind === 'owner' ? 'Owners' : 'Priority', f.reasons,
          f.chat_name || f.chat, f.sender_name || (f.sender_phone ? '+' + f.sender_phone : ''), ownerOf(f.sender_phone),
          f.text, kind === 'task' ? taskKey(f.text) : '', istTime(f.done_at),
          f.done_at && f.done_at >= f.t ? Math.round((f.done_at - f.t) / 36e5 * 10) / 10 : '',
          rep[f.msg_id] ? istTime(rep[f.msg_id].sent_at) : '', rep[f.msg_id] ? rep[f.msg_id].text : ''];
      }));
  }
  return '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

// ===================================================================
// Names sync (cron + button)
// ===================================================================
export async function syncNames(env, withContacts) {
  const groups = (await wa(env, 'GET', '/groups') || []).filter(g => g && g.id)
    .map(g => ({ jid: g.id, name: String(g.name || g.subject || '').trim() }));
  if (groups.length) {
    await env.DB.prepare(
      "INSERT INTO chats (jid, name, kind) SELECT json_extract(value, '$.jid'), NULLIF(json_extract(value, '$.name'), ''), 'group' " +
      "FROM json_each(?) WHERE true ON CONFLICT(jid) DO UPDATE SET name = COALESCE(excluded.name, chats.name)"
    ).bind(JSON.stringify(groups)).run();
  }
  if (withContacts) {
    const contacts = await wa(env, 'GET', '/contacts') || [];
    const list = [];
    contacts.forEach(c => {
      const nm = c && (c.name || c.verifiedName || c.notify);
      const pn = digits(c.id) || null;
      if (nm) [bare(c.id), bare(c.lid)].filter(Boolean).forEach(j => list.push({ jid: j, name: String(nm).slice(0, 100), pn }));
    });
    for (let i = 0; i < list.length; i += 1000) {
      await env.DB.prepare(
        "INSERT INTO contacts (jid, name, pn) SELECT json_extract(value, '$.jid'), json_extract(value, '$.name'), json_extract(value, '$.pn') " +
        'FROM json_each(?) WHERE true ON CONFLICT(jid) DO UPDATE SET name = excluded.name, pn = COALESCE(excluded.pn, contacts.pn)')
        .bind(JSON.stringify(list.slice(i, i + 1000))).run();
    }
    await env.DB.prepare(
      "UPDATE chats SET name = (SELECT name FROM contacts WHERE contacts.jid = chats.jid) " +
      "WHERE kind = 'personal' AND EXISTS (SELECT 1 FROM contacts WHERE contacts.jid = chats.jid)").run();
  }
  await setSetting(env, 'names_synced', Date.now());
  return groups.length;
}

// ===================================================================
// Morning / evening summary to the office number itself
// ===================================================================
// The task-system link's id: one reminder card per task, however many days it is repeated.
export function taskKey(text) {
  const m = String(text || '').match(/tools\.xpertpack\.in\/tasks\/t\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : '';
}

export function briefText(d, kind) {
  const today = dayKey(d.now), tomorrow = dayKey(d.now + DAY);
  const open = d.tasks.filter(t => t.status === 'Open');
  const overdue = open.filter(t => t.due && t.due < today);
  const dueToday = open.filter(t => !t.due || t.due === today);
  const dueTomorrow = open.filter(t => t.due === tomorrow);
  const doneToday = d.tasks.filter(t => t.status === 'Done' && t.doneAt && dayKey(t.doneAt) === today);
  const dm = key => key ? key.slice(8, 10) + '-' + key.slice(5, 7) : '';
  const taskLine = t => '• ' + (t.party ? '*' + t.party + '* — ' : '') + t.kaam.slice(0, 120) +
    (t.team && t.team !== 'Self' ? ' [' + t.team + ']' : '') + (t.due && t.due < today ? ' (due ' + dm(t.due) + ')' : '');
  const section = (title, items, fn, cap) => {
    if (!items.length) return [];
    const out = ['', title + ' (' + items.length + ')'];
    items.slice(0, cap).forEach(x => out.push(fn(x)));
    if (items.length > cap) out.push('…and ' + (items.length - cap) + ' more');
    return out;
  };
  const allOpen = (d.flags || []).filter(f => !f.done);
  const openFlags = allOpen.filter(f => f.reasons.indexOf('tasksys') === -1 && f.reasons.indexOf('owner') === -1 && f.reasons.length);
  const taskKeys = new Set(allOpen.filter(f => f.reasons.indexOf('tasksys') !== -1).map(f => taskKey(f.text) || f.id));
  const ownerOpen = allOpen.filter(f => f.reasons.indexOf('owner') !== -1);
  const fcount = k => openFlags.filter(f => f.reasons.indexOf(k) !== -1).length;
  const flagLine = f => '• *' + f.chat + '* — ' + f.who + ': "' + f.text.replace(/\s+/g, ' ').slice(0, 80) + '"';
  const zaroori = openFlags.length
    ? ['', '⭐ *Priority pending: ' + openFlags.length + '* (mentions ' + fcount('tag') + ' · Neeraj ' + fcount('neeraj') + ' · payment ' + fcount('payment') + ')']
        .concat(openFlags.slice(0, 12).map(flagLine), openFlags.length > 12 ? ['…and ' + (openFlags.length - 12) + ' more'] : [])
    : [];
  const extra = [];
  if (taskKeys.size) extra.push('📋 Open tasks: ' + taskKeys.size);
  if (ownerOpen.length) extra.push('👑 Owner messages pending: ' + ownerOpen.length);
  const extraLines = extra.length ? [''].concat(extra) : [];
  let L = [];
  if (kind === 'morning') {
    L.push('☀️ *Good morning — today\'s Work List* (' + dm(today) + ')');
    L = L.concat(extraLines, zaroori, section('⏰ *Overdue*', overdue, taskLine, 10), section('📌 *Due today*', dueToday, taskLine, 15));
    if (!overdue.length && !dueToday.length && !openFlags.length) L.push('', 'All clear ✅');
  } else {
    L.push('🌆 *Daily review* — ' + dm(today));
    L.push('✅ Completed today: ' + doneToday.length + '   📝 Work List open: ' + open.length);
    L = L.concat(extraLines, zaroori, section('⏰ *Overdue*', overdue, taskLine, 10), section('📌 *Still due today*', dueToday, taskLine, 10),
      section('🗓️ *Due tomorrow*', dueTomorrow, taskLine, 10));
  }
  return L.join('\n');
}

async function sendBrief(env, kind) {
  const d = await getInbox(env, kind === 'morning' ? 2 : 1);
  const me = await getMe(env);
  const num = String(me.pn || '').split('@')[0];
  if (!num) throw new Error('Office number not known yet.');
  await wa(env, 'POST', '/send-message', { to: '+' + num, text: briefText(d, kind) });
  return true;
}

// ===================================================================
// Setup panel
// ===================================================================
async function getSetup(env, origin) {
  const token = await secretSetting(env, 'webhook_token');
  let status = 'unknown';
  try { status = String((await wa(env, 'GET', '/status')).status || 'unknown'); } catch (e) { status = 'error: ' + e.message; }
  const counts = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM messages) AS msgs, (SELECT MAX(received_at) FROM messages) AS last, ' +
    "(SELECT COUNT(*) FROM chats WHERE kind = 'group') AS groups, (SELECT COUNT(*) FROM contacts) AS contacts").first();
  return {
    webhookUrl: origin + '/webhook?token=' + token, scriptUrl: origin + '/wa-sync.user.js', status,
    briefs: (await getSetting(env, 'briefs')) === 'on',
    webSync: (await env.DB.prepare("SELECT MAX(received_at) AS r FROM messages WHERE event = 'wa-web'").first()).r || 0,
    msgs: counts.msgs, lastArrival: counts.last || 0, groups: counts.groups, contacts: counts.contacts,
    namesSynced: Number(await getSetting(env, 'names_synced')) || 0
  };
}

// ===================================================================
// RPC — the dashboard's only door to the data
// ===================================================================
const RPC = {
  getWaInbox: (env, a) => getInbox(env, a[0]),
  markWaFlags: (env, a) => markFlags(env, a[0], a[1] !== false),
  queueWaReply: (env, a) => queueReply(env, a[0]),
  sendWaReplyNow: (env, a) => sendReplyNow(env, a[0]),
  getWaChat: (env, a) => getChat(env, a[0], a[1]),
  getWaContext: (env, a) => getContext(env, a[0]),
  getWaReport: (env, a) => getReport(env, a[0]),
  searchWa: (env, a) => searchChats(env, a[0], a[1]),
  markWaChatsSeen: (env, a) => markSeen(env, a[0]),
  clearWaChatTags: (env, a) => clearTags(env, a[0], a[1]),
  setWaChatMuted: (env, a) => setMuted(env, a[0], a[1]),
  setWaChatCategory: (env, a) => setCategory(env, a[0], a[1]),
  addWaTask: (env, a) => addTask(env, a[0]),
  updateWaTask: (env, a) => updateTask(env, a[0], a[1]),
  sendWaTaskToTeam: (env, a) => sendToTeam(env, a[0], a[1], a[2], a[3]),
  sendWaBriefNow: (env, a) => sendBrief(env, a[0] === 'morning' ? 'morning' : 'evening'),
  getWaSetup: (env, a, origin) => getSetup(env, origin),
  setWaBriefs: async (env, a) => { await setSetting(env, 'briefs', a[0] ? 'on' : 'off'); return true; },
  syncWaNames: (env) => syncNames(env, true),
  // Security: auto-lock time and fingerprint sign-in (see the Login section)
  getWaSecurity: (env) => getSecurity(env),
  setWaLockMinutes: async (env, a) => { await setSetting(env, 'lock_minutes', lockMinutes(a[0])); return lockMinutes(a[0]); },
  touchWa: () => true,
  getClaudeRequests: (env) => getRequests(env),
  addClaudeRequest: (env, a) => addRequest(env, a[0], a[1]),
  cancelClaudeRequest: (env, a) => cancelRequest(env, a[0]),
  passkeyRegOptions: (env, a, origin) => passkeyRegOptions(env, a[0], origin),
  passkeyRegister: (env, a, origin) => passkeyRegister(env, a[0], origin),
  removePasskey: async (env, a) => { await env.DB.prepare('DELETE FROM passkeys WHERE id = ?').bind(String(a[0] || '')).run(); return true; }
};

// ===================================================================
// Login
// ===================================================================
async function hmac(env, msg) {
  const secret = await secretSetting(env, 'session_secret');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

// Sessions. The cookie only names a row in `sessions`; the row is what makes it valid. Locking
// deletes the row, and a session nobody has used for the auto-lock time (plus a few minutes'
// grace for the browser's own timer) is refused here even if the browser never sent the lock.
export const LOCK_CHOICES = [5, 10, 15, 30, 60];
const LOCK_GRACE_MIN = 5;
function lockMinutes(v) { const n = Number(v); return LOCK_CHOICES.indexOf(n) !== -1 ? n : 15; }
function sessionCookie(value, maxAge) {
  return 'xpwa=' + value + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAge;
}
async function newSession(env, via) {
  const id = randomHex(18), now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (id, created, last_active, via) VALUES (?, ?, ?, ?)').bind(id, now, now, via).run();
  return sessionCookie(encodeURIComponent(id + '.' + await hmac(env, 'sess:' + id)), SESSION_DAYS * 86400);
}
async function getSession(req, env) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)xpwa=([^;]+)/);
  if (!m) return null;
  const [id, sig] = decodeURIComponent(m[1]).split('.');
  if (!id || !sig || !safeEq(sig, await hmac(env, 'sess:' + id))) return null;
  const s = await env.DB.prepare("SELECT id, created, last_active, (SELECT v FROM settings WHERE k = 'lock_minutes') AS lm " +
    'FROM sessions WHERE id = ?').bind(id).first();
  if (!s) return null;
  const now = Date.now();
  if (now - s.created > SESSION_DAYS * DAY || now - s.last_active > (lockMinutes(s.lm) + LOCK_GRACE_MIN) * 60000) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  return s;
}
// The dashboard says when someone is really using it (mouse, keyboard, or Windows reporting the
// user active) — the three-minute auto-refresh on its own does not keep a session open.
async function touchSession(env, s) {
  const now = Date.now();
  if (now - s.last_active > 30000) await env.DB.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').bind(now, s.id).run();
}
async function endSession(req, env) {
  const s = await getSession(req, env);
  if (s) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(s.id).run();
}

async function loginBlocked(env) {
  const fails = JSON.parse((await getSetting(env, 'login_fails')) || '{"n":0,"t":0}');
  return fails.n >= 10 && Date.now() - fails.t < 15 * 60000;
}
async function loginFailed(env) {
  const fails = JSON.parse((await getSetting(env, 'login_fails')) || '{"n":0,"t":0}');
  const n = Date.now() - fails.t < 15 * 60000 ? fails.n + 1 : 1;
  await setSetting(env, 'login_fails', JSON.stringify({ n, t: Date.now() }));
  await new Promise(r => setTimeout(r, 800));
}
const TOO_MANY = 'Too many failed attempts — please try again in 15 minutes.';

async function login(req, env) {
  if (await loginBlocked(env)) return loginPage(env, TOO_MANY, 429);
  const form = await req.formData();
  const pw = String(form.get('password') || '');
  if (!env.DASHBOARD_PASSWORD || !safeEq(pw, env.DASHBOARD_PASSWORD)) {
    await loginFailed(env);
    return loginPage(env, 'Incorrect password.', 401);
  }
  await setSetting(env, 'login_fails', JSON.stringify({ n: 0, t: 0 }));
  return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': await newSession(env, 'password') } });
}

// ===================================================================
// Fingerprint sign-in — WebAuthn passkeys on Windows Hello
// ===================================================================
// The laptop keeps the private key in its security chip and only uses it after Windows Hello has
// checked the fingerprint (or the Windows Hello PIN). The dashboard stores the public key and
// checks each sign-in's signature against it.
const PK_ALGS = {
  '-7': { imp: { name: 'ECDSA', namedCurve: 'P-256' }, ver: { name: 'ECDSA', hash: 'SHA-256' } },
  '-257': { imp: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, ver: { name: 'RSASSA-PKCS1-v1_5' } }
};
export function b64u(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }
// WebAuthn sends ECDSA signatures DER-encoded; WebCrypto wants r and s side by side.
export function derToRaw(der) {
  const bad = () => { throw new Error('Unreadable signature.'); };
  if (der[0] !== 0x30) bad();
  let i = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const out = new Uint8Array(64);
  for (let k = 0; k < 2; k++) {
    if (der[i] !== 0x02) bad();
    const len = der[i + 1];
    let v = der.subarray(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) bad();
    out.set(v, k * 32 + 32 - v.length);
  }
  return out;
}
async function newChallenge(env, kind) {
  const now = Date.now();
  await env.DB.prepare('DELETE FROM challenges WHERE exp < ?').bind(now).run();
  const live = await env.DB.prepare('SELECT COUNT(*) AS n FROM challenges').first();
  if (live.n > 50) throw new Error('Too many sign-in attempts — please wait two minutes.');
  const c = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT INTO challenges (c, kind, exp) VALUES (?, ?, ?)').bind(c, kind, now + 120000).run();
  return c;
}
// Checks what the browser signed: the right kind of request, from this dashboard, answering a
// challenge we issued (each one works once), and with the fingerprint actually verified.
async function checkCeremony(env, kind, clientDataB64, authDataB64, origin) {
  const clientData = unb64u(clientDataB64), authData = unb64u(authDataB64);
  let cd;
  try { cd = JSON.parse(new TextDecoder().decode(clientData)); } catch (e) { throw new Error('Unreadable sign-in data.'); }
  if (cd.type !== (kind === 'reg' ? 'webauthn.create' : 'webauthn.get')) throw new Error('Wrong kind of request.');
  if (cd.origin !== origin) throw new Error('This request did not come from the dashboard.');
  const used = await env.DB.prepare('DELETE FROM challenges WHERE c = ? AND kind = ? AND exp > ? RETURNING c')
    .bind(String(cd.challenge || ''), kind, Date.now()).first();
  if (!used) throw new Error('This request has expired — please try again.');
  if (authData.length < 37) throw new Error('Unreadable sign-in data.');
  const rpHash = await sha256(new TextEncoder().encode(new URL(origin).hostname));
  if (!rpHash.every((b, i) => b === authData[i])) throw new Error('This fingerprint belongs to a different website.');
  const flags = authData[32];
  if (!(flags & 1) || !(flags & 4)) throw new Error('Windows Hello did not verify the fingerprint.');
  return { clientData, authData, count: new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0) };
}

async function passkeyOptions(env, origin) {
  const ids = (await env.DB.prepare('SELECT id FROM passkeys').all()).results.map(r => r.id);
  if (!ids.length) throw new Error('No fingerprint has been set up yet — sign in with the password, then add it under Setup.');
  return { challenge: await newChallenge(env, 'login'), rpId: new URL(origin).hostname, ids };
}

async function passkeyLogin(req, env, origin) {
  if (await loginBlocked(env)) return json({ error: TOO_MANY }, 429);
  let b;
  try { b = await req.json(); } catch (e) { return json({ error: 'Unreadable sign-in data.' }, 400); }
  try {
    const pk = await env.DB.prepare('SELECT * FROM passkeys WHERE id = ?').bind(String(b.id || '')).first();
    if (!pk) throw new Error('This fingerprint is not registered for the dashboard.');
    const c = await checkCeremony(env, 'login', b.clientDataJSON, b.authenticatorData, origin);
    if (pk.sign_count && c.count <= pk.sign_count) throw new Error('This sign-in was refused (security counter mismatch).');
    const a = PK_ALGS[String(pk.alg)];
    const key = await crypto.subtle.importKey('spki', unb64u(pk.pk), a.imp, false, ['verify']);
    const data = new Uint8Array(c.authData.length + 32);
    data.set(c.authData);
    data.set(await sha256(c.clientData), c.authData.length);
    const sig = unb64u(b.signature);
    if (!(await crypto.subtle.verify(a.ver, key, pk.alg === -7 ? derToRaw(sig) : sig, data))) throw new Error('The fingerprint check failed.');
    await env.DB.prepare('UPDATE passkeys SET last_used = ?, sign_count = ? WHERE id = ?').bind(Date.now(), c.count, pk.id).run();
  } catch (e) {
    await loginFailed(env);
    return json({ error: e.message || String(e) }, 401);
  }
  await setSetting(env, 'login_fails', JSON.stringify({ n: 0, t: 0 }));
  return new Response(JSON.stringify({ ok: true }), { headers: Object.assign({ 'Content-Type': 'application/json',
    'Set-Cookie': await newSession(env, 'fingerprint') }, SEC_HEADERS) });
}

// Adding a fingerprint needs the dashboard password as well, so someone who finds the dashboard
// open cannot add their own way in.
function checkPassword(env, pw) {
  if (!env.DASHBOARD_PASSWORD || !safeEq(String(pw || ''), env.DASHBOARD_PASSWORD)) throw new Error('Incorrect password.');
}
async function passkeyRegOptions(env, pw, origin) {
  checkPassword(env, pw);
  const ids = (await env.DB.prepare('SELECT id FROM passkeys').all()).results.map(r => r.id);
  return { challenge: await newChallenge(env, 'reg'), rpId: new URL(origin).hostname, rpName: 'XP WhatsApp Inbox',
    userId: b64u(new TextEncoder().encode('xp-inbox-owner')), exclude: ids };
}
async function passkeyRegister(env, p, origin) {
  p = p || {};
  checkPassword(env, p.password);
  const c = await checkCeremony(env, 'reg', p.clientDataJSON, p.authenticatorData, origin);
  const a = PK_ALGS[String(Number(p.alg))];
  if (!a) throw new Error('This device uses a key type the dashboard does not support.');
  try { await crypto.subtle.importKey('spki', unb64u(p.publicKey), a.imp, false, ['verify']); } catch (e) { throw new Error('Unreadable public key.'); }
  const id = String(p.id || '');
  if (!/^[A-Za-z0-9_-]{16,1400}$/.test(id)) throw new Error('Unreadable credential id.');
  await env.DB.prepare('INSERT INTO passkeys (id, pk, alg, name, created, sign_count) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, String(p.publicKey), Number(p.alg), String(p.name || 'This laptop').slice(0, 60), Date.now(), c.count).run();
  return true;
}
async function getSecurity(env) {
  return {
    lockMin: lockMinutes(await getSetting(env, 'lock_minutes')), lockChoices: LOCK_CHOICES,
    passkeys: (await env.DB.prepare('SELECT id, name, created, last_used FROM passkeys ORDER BY created').all()).results
      .map(r => ({ id: r.id, name: r.name, created: r.created, lastUsed: r.last_used || 0 }))
  };
}

const SEC_HEADERS = { 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

// The sign-in page, also shown as the lock screen. With a fingerprint registered, the big button
// signs in through Windows Hello; the password stays underneath as the fallback.
async function loginPage(env, err, status, locked) {
  const hasPasskey = !!(await env.DB.prepare('SELECT 1 AS x FROM passkeys LIMIT 1').first());
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>WhatsApp Inbox</title><style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f5f7;margin:0;' +
    'display:flex;min-height:100vh;align-items:center;justify-content:center;color:#1a1a1a}main{background:#fff;border:1px solid #e3e5e9;' +
    'border-radius:14px;padding:24px;width:min(340px,calc(100vw - 32px))}h1{font-size:18px;margin:0 0 6px}.sub{font-size:13px;color:#6b7280;margin:0 0 14px}' +
    'input{width:100%;padding:10px;border:1px solid #d0d3d9;border-radius:8px;font-size:15px;box-sizing:border-box}button{margin-top:12px;width:100%;padding:10px;' +
    'border:0;border-radius:8px;background:#1e3a8a;color:#fff;font-weight:700;font-size:15px;cursor:pointer}button.fp{padding:14px;font-size:16px;margin:0}' +
    'button.alt{background:#fff;color:#1e3a8a;border:1px solid #d0d3d9}.or{text-align:center;font-size:12px;color:#6b7280;margin:14px 0 10px}' +
    '.e{color:#dc2626;font-size:13px;margin-top:10px}' +
    '@media (prefers-color-scheme:dark){body{background:#111214;color:#e8e8ea}main{background:#1b1c1f;border-color:#2d2f34}input{background:#111214;color:#e8e8ea;border-color:#2d2f34}' +
    'button.alt{background:#1b1c1f;color:#c7d2fe;border-color:#2d2f34}}</style></head><body><main>' +
    '<h1>' + (locked ? '🔒 Dashboard locked' : '📥 WhatsApp Inbox') + '</h1>' +
    '<p class="sub">' + (locked ? 'The dashboard was locked. Sign in again to continue.' : 'Sign in to continue.') + '</p>' +
    (hasPasskey ? '<button type="button" class="fp" id="fp" autofocus>👆 Sign in with fingerprint</button><div class="or">or use the password</div>' : '') +
    '<form method="post" action="/login"><input type="password" name="password" placeholder="Password" autocomplete="current-password"' +
    (hasPasskey ? '' : ' autofocus') + '><button type="submit"' + (hasPasskey ? ' class="alt"' : '') + '>Sign in</button></form>' +
    '<div class="e" id="err">' + (err || '') + '</div></main>' +
    (hasPasskey ? '<script>' + LOGIN_JS + '</script>' : '') + '</body></html>';
  return new Response(html, { status: status || 200, headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, SEC_HEADERS) });
}
const LOGIN_JS = `
function b64u(b){var s='',a=new Uint8Array(b);for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
function unb64u(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var b=atob(s),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a;}
var btn=document.getElementById('fp'),err=document.getElementById('err');
btn.addEventListener('click',async function(){
  err.textContent='';btn.disabled=true;
  try{
    if(!window.PublicKeyCredential)throw new Error('This browser does not support fingerprint sign-in. Please use the password.');
    var o=await (await fetch('/auth/passkey/options',{method:'POST'})).json();
    if(o.error)throw new Error(o.error);
    var cred=await navigator.credentials.get({publicKey:{challenge:unb64u(o.challenge),rpId:o.rpId,timeout:60000,userVerification:'required',
      allowCredentials:o.ids.map(function(id){return{type:'public-key',id:unb64u(id)};})}});
    var r=cred.response;
    var res=await fetch('/auth/passkey/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:b64u(cred.rawId),
      clientDataJSON:b64u(r.clientDataJSON),authenticatorData:b64u(r.authenticatorData),signature:b64u(r.signature)})});
    var j=await res.json();
    if(!j.ok)throw new Error(j.error||'Sign-in failed.');
    location.replace('/');
  }catch(e){
    err.textContent=e&&e.name==='NotAllowedError'?'Fingerprint sign-in was cancelled or timed out. Please try again.':(e&&e.message)||String(e);
    btn.disabled=false;
  }
});`;

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, SEC_HEADERS) });
}

// ===================================================================
// Entry points
// ===================================================================
export function makeWorker(inboxHtml, userScript, coreScript) {
  return {
    async fetch(req, env, ctx) {
      const url = new URL(req.url);
      const p = url.pathname;
      try {
        if (p === '/webhook' && req.method === 'POST') {
          const token = await secretSetting(env, 'webhook_token');
          const given = url.searchParams.get('token') || req.headers.get('x-webhook-signature') || '';
          if (!safeEq(given, token)) return new Response('forbidden', { status: 401 });
          let body;
          try { body = await req.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
          const rows = rowsFrom(body, Date.now());
          if (rows.length) await ingest(env, rows, ctx && ctx.waitUntil ? ctx.waitUntil.bind(ctx) : null);
          return new Response('ok');
        }
        if (p === '/health') return new Response('ok');
        // WhatsApp Web collects replies to send, and reports back. Same token as the webhook.
        if (p === '/wa-outbox') {
          const token = await secretSetting(env, 'webhook_token');
          if (!safeEq(url.searchParams.get('token') || '', token)) return new Response('forbidden', { status: 401 });
          if (req.method === 'GET') return json({ items: await outboxClaim(env) });
          if (req.method === 'POST') return json({ ok: await outboxAck(env, await req.json()) });
        }
        // WhatsApp Web reports what was deleted there, and asks which chats to compare. Same token.
        if (p === '/wa-check' || p === '/wa-deletes') {
          const token = await secretSetting(env, 'webhook_token');
          if (!safeEq(url.searchParams.get('token') || '', token)) return new Response('forbidden', { status: 401 });
          if (p === '/wa-check' && req.method === 'GET') return json(await waCheck(env));
          if (p === '/wa-deletes' && req.method === 'POST') {
            let body;
            try { body = await req.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
            return json(await waDeletes(env, body));
          }
        }
        // The in-page half of the WhatsApp Web script; the loader fetches it with the webhook token.
        if (p === '/wa-core.js' && req.method === 'GET') {
          const token = await secretSetting(env, 'webhook_token');
          if (!safeEq(url.searchParams.get('token') || '', token)) return new Response('forbidden', { status: 401 });
          return new Response(String(coreScript || ''), { headers: Object.assign({ 'Content-Type': 'text/javascript; charset=utf-8' }, SEC_HEADERS) });
        }
        if (p === '/favicon.ico') return new Response(null, { status: 204 });
        if (p === '/login' && req.method === 'POST') return login(req, env);
        // No origin check needed for fingerprint sign-in: the browser signs the page's origin into
        // the answer itself, and checkCeremony refuses any other.
        if (p === '/auth/passkey/options' && req.method === 'POST') {
          try { return json(await passkeyOptions(env, url.origin)); } catch (e) { return json({ error: e.message }, 200); }
        }
        if (p === '/auth/passkey/login' && req.method === 'POST') return passkeyLogin(req, env, url.origin);
        // Logout and lock both end the session on the server. GET (the Logout link) goes back to the
        // sign-in page; POST is what the dashboard sends when it locks itself.
        if (p === '/logout') {
          await endSession(req, env);
          const gone = sessionCookie('', 0);
          if (req.method === 'POST') return new Response(null, { status: 204, headers: { 'Set-Cookie': gone } });
          return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': gone } });
        }
        const session = await getSession(req, env);
        const authed = !!session;
        if (p === '/api/rpc' && req.method === 'POST') {
          if (!authed) return json({ error: 'login' }, 401);
          // Same-origin only: a page elsewhere cannot drive the inbox with the user's cookie.
          const origin = req.headers.get('origin');
          if (origin && origin !== url.origin) return json({ error: 'bad origin' }, 403);
          if (req.headers.get('x-xp-active') === '1') await touchSession(env, session);
          const { fn, args } = await req.json();
          if (!Object.prototype.hasOwnProperty.call(RPC, fn)) return json({ error: 'unknown call ' + fn }, 400);
          try {
            return json({ data: await RPC[fn](env, Array.isArray(args) ? args : [], url.origin) });
          } catch (e) {
            return json({ error: e.message || String(e) }, 200);
          }
        }
        // The Tampermonkey script, with this inbox's webhook URL (and so its token) baked in —
        // which is why it is only handed to a logged-in browser.
        if (p === '/wa-sync.user.js' && req.method === 'GET') {
          if (!authed) return loginPage(env, '');
          const token = await secretSetting(env, 'webhook_token');
          return new Response(String(userScript || '').replace('__ENDPOINT__', url.origin + '/webhook?token=' + token),
            { headers: Object.assign({ 'Content-Type': 'text/javascript; charset=utf-8' }, SEC_HEADERS) });
        }
        if ((p === '/export/items.csv' || p === '/export/worklist.csv') && req.method === 'GET') {
          if (!authed) return loginPage(env, '');
          const which = p.indexOf('worklist') !== -1 ? 'worklist' : 'items';
          return new Response(await exportCsv(env, which), { headers: Object.assign({
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="xp-' + which + '-' + dayKey(Date.now()) + '.csv"' }, SEC_HEADERS) });
        }
        if (p === '/' && req.method === 'GET') {
          if (!authed) return loginPage(env, '', 200, url.searchParams.has('locked'));
          await touchSession(env, session);
          return new Response(inboxHtml, { headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, SEC_HEADERS) });
        }
        return new Response('not found', { status: 404 });
      } catch (e) {
        return new Response('error: ' + (e && e.message), { status: 500 });
      }
    },

    // Crons are in UTC (see wrangler.toml): 04:00 = 9:30 IST, 13:30 = 19:00 IST, 21:00 = 2:30 IST.
    async scheduled(event, env, ctx) {
      const cron = event.cron;
      const briefsOn = (await getSetting(env, 'briefs')) === 'on';
      if (cron === '0 4 * * *' && briefsOn) await sendBrief(env, 'morning');
      else if (cron === '30 13 * * *' && briefsOn) await sendBrief(env, 'evening');
      else if (cron === '0 21 * * *') {
        const cut = Date.now() - KEEP_DAYS * DAY;
        // Only the everyday chatter goes. Every message that was ever on a list (Zaroori, Task List,
        // Owners) stays, with its flag, for good — that is the record the directors' report is built on.
        await env.DB.prepare('DELETE FROM messages WHERE received_at < ? AND id NOT IN (SELECT msg_id FROM flags)').bind(cut).run();
        await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE last_active < ?').bind(Date.now() - DAY),
          env.DB.prepare('DELETE FROM challenges WHERE exp < ?').bind(Date.now()),
          env.DB.prepare('DELETE FROM trash WHERE deleted_at < ?').bind(Date.now() - 30 * DAY)]);
        await syncNames(env, true);
      } else if (cron === '0 */6 * * *') {
        await syncNames(env, false);
      }
    }
  };
}
