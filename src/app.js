/**
 * XpertPack — WhatsApp Inbox for the office number (XP Purchase), on Cloudflare Workers + D1.
 *
 *   POST /webhook?token=…   WaSender delivers every message / call here → stored in D1
 *   GET  /                  the dashboard (password login, 30-day cookie)
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
const TEAMS = ['Khud', 'Accounts', 'Store', 'Purchase', 'Production', 'Quality', 'Dispatch'];
const KAAM_RE = /^\s*#(kaam|task|todo)\b/i;

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
const CALL_STATUS = { offer: 'aaya', ringing: 'aaya', timeout: 'missed', reject: 'kaata', accept: 'uthaya' };

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
      text: (c.isVideo ? 'Video call ' : 'Call ') + (CALL_STATUS[c.status] || 'aaya'), mentions: '', reply_to: ''
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
  const data = JSON.stringify(rows.map(r => { const o = {}; MSG_COLS.forEach(c => { o[c] = r[c] === undefined ? null : r[c]; }); return o; }));

  // One row per chat seen in this batch (the "Message yourself" chat is notes, not a conversation).
  const chats = {};
  for (const r of rows) {
    if (me.ids.indexOf(bare(r.chat)) !== -1) continue;
    const c = chats[r.chat] || (chats[r.chat] = { jid: r.chat, name: '', kind: r.is_group ? 'group' : 'personal' });
    if (r.is_group && r.chat_name) c.name = r.chat_name;
    if (!r.is_group && !c.name) c.name = r.chat_name || (!r.from_me ? r.sender_name : '') || '';
  }

  await env.DB.batch([
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
    : type === 'Payment' ? 'Accounts' : 'Khud';
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
async function getInbox(env, daysArg) {
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
    chats, callsToday, tasks: await tasksOut(env), groups,
    teamGroups: JSON.parse((await getSetting(env, 'team_groups')) || '{}'),
    keywords: KEYWORDS, types: TASK_TYPES, teams: TEAMS
  };
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
         TEAMS.indexOf(t.team) !== -1 ? t.team : 'Khud', t.chat || null,
         t.kaamMsgId || null, t.msgId || null,
         String(t.message || '').slice(0, 2000), String(t.note || '').slice(0, 1000)).run();
}

async function addTask(env, t) {
  t = t || {};
  if (!String(t.kaam || '').trim()) throw new Error('Kaam khaali hai — kya karna hai likhiye.');
  if (t.due && !DUE_RE.test(String(t.due))) throw new Error('Due date samajh nahi aayi.');
  await insertTask(env, Object.assign({}, t, { source: t.msgId ? 'Message' : 'Dashboard' }));
  return tasksOut(env);
}

async function updateTask(env, id, patch) {
  patch = patch || {};
  const cur = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(String(id)).first();
  if (!cur) throw new Error('Task nahi mila — page refresh karke dekhiye.');
  const sets = [], vals = [];
  if (patch.status !== undefined) {
    const st = ['Open', 'Done', 'Cancelled'].indexOf(patch.status) !== -1 ? patch.status : 'Open';
    sets.push('status = ?', 'done_at = ?'); vals.push(st, st === 'Done' ? Date.now() : null);
  }
  if (patch.due !== undefined) {
    if (patch.due && !DUE_RE.test(String(patch.due))) throw new Error('Due date samajh nahi aayi.');
    sets.push('due = ?'); vals.push(patch.due || null);
  }
  if (patch.kaam !== undefined) {
    if (!String(patch.kaam).trim()) throw new Error('Kaam khaali nahi ho sakta.');
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
  if (!/@g\.us$/.test(groupJid)) throw new Error('Group chuniye.');
  if (!text) throw new Error('Message khaali hai.');
  const g = await env.DB.prepare('SELECT name FROM chats WHERE jid = ?').bind(groupJid).first();
  if (!g) throw new Error('Ye group list mein nahi hai — Setup mein "Group names refresh" dabaiye.');
  const task = await env.DB.prepare('SELECT id FROM tasks WHERE id = ?').bind(String(id)).first();
  if (!task) throw new Error('Task nahi mila — page refresh karke dekhiye.');
  await wa(env, 'POST', '/send-message', { to: groupJid, text });
  const stamp = new Date(Date.now() + IST).toISOString().replace(/^\d{4}-(\d\d)-(\d\d)T(\d\d:\d\d).*/, '$2-$1 $3') + ' → ' + (g.name || 'group');
  await env.DB.prepare('UPDATE tasks SET notified = ? WHERE id = ?').bind(stamp, String(id)).run();
  if (TEAMS.indexOf(team) !== -1 && team !== 'Khud') {
    const map = JSON.parse((await getSetting(env, 'team_groups')) || '{}');
    map[team] = groupJid;
    await setSetting(env, 'team_groups', JSON.stringify(map));
  }
  return tasksOut(env);
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
      if (nm) [bare(c.id), bare(c.lid)].filter(Boolean).forEach(j => list.push({ jid: j, name: String(nm).slice(0, 100) }));
    });
    for (let i = 0; i < list.length; i += 1000) {
      await env.DB.prepare(
        "INSERT INTO contacts (jid, name) SELECT json_extract(value, '$.jid'), json_extract(value, '$.name') FROM json_each(?) " +
        'WHERE true ON CONFLICT(jid) DO UPDATE SET name = excluded.name').bind(JSON.stringify(list.slice(i, i + 1000))).run();
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
export function briefText(d, kind) {
  const today = dayKey(d.now), tomorrow = dayKey(d.now + DAY);
  const open = d.tasks.filter(t => t.status === 'Open');
  const overdue = open.filter(t => t.due && t.due < today);
  const dueToday = open.filter(t => !t.due || t.due === today);
  const dueTomorrow = open.filter(t => t.due === tomorrow);
  const doneToday = d.tasks.filter(t => t.status === 'Done' && t.doneAt && dayKey(t.doneAt) === today);
  const pend = d.chats.filter(c => c.pending > 0).sort((a, b) => b.lastPending.t - a.lastPending.t);
  const unseen = d.chats.filter(c => !c.muted && c.unseen > 0).sort((a, b) => b.unseen - a.unseen);
  const unseenMsgs = unseen.reduce((s, c) => s + c.unseen, 0);
  const dm = key => key ? key.slice(8, 10) + '-' + key.slice(5, 7) : '';
  const taskLine = t => '• ' + (t.party ? '*' + t.party + '* — ' : '') + t.kaam.slice(0, 120) +
    (t.team && t.team !== 'Khud' ? ' [' + t.team + ']' : '') + (t.due && t.due < today ? ' (due ' + dm(t.due) + ')' : '');
  const pendLine = c => {
    const p = c.lastPending;
    return '• *' + c.name + '* — ' + (p.who ? p.who + ': ' : '') + (p.call ? '📞 call' : '"' + p.text.slice(0, 80) + '"') +
      (c.pending > 1 ? ' (+' + (c.pending - 1) + ')' : '');
  };
  const section = (title, items, fn, cap) => {
    if (!items.length) return [];
    const out = ['', title + ' (' + items.length + ')'];
    items.slice(0, cap).forEach(x => out.push(fn(x)));
    if (items.length > cap) out.push('…aur ' + (items.length - cap));
    return out;
  };
  let L = [];
  if (kind === 'morning') {
    L.push('☀️ *Good morning — aaj ke kaam* (' + dm(today) + ')');
    L = L.concat(section('⏰ *Overdue*', overdue, taskLine, 10), section('📌 *Aaj*', dueToday, taskLine, 15),
      section('🔔 *Reply baaki*', pend, pendLine, 10));
    if (!overdue.length && !dueToday.length && !pend.length) L.push('', 'Sab clear hai ✅');
  } else {
    L.push('🌆 *Aaj ka hisaab* — ' + dm(today));
    L.push('✅ Aaj poore hue: ' + doneToday.length + '   📝 Khule kaam: ' + open.length);
    L = L.concat(section('⏰ *Overdue*', overdue, taskLine, 10), section('📌 *Aaj ke baaki*', dueToday, taskLine, 10),
      section('🗓️ *Kal ke liye*', dueTomorrow, taskLine, 10), section('🔔 *Tag / direct — reply baaki*', pend, pendLine, 10));
    if (unseenMsgs) {
      L.push('', '💬 Bina dekhe: ' + unseenMsgs + ' messages, ' + unseen.length + ' chats');
      L.push(unseen.slice(0, 6).map(c => c.name + ' (' + c.unseen + ')').join(', '));
    }
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
  getWaChat: (env, a) => getChat(env, a[0], a[1]),
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
  syncWaNames: (env) => syncNames(env, true)
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
async function isAuthed(req, env) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)xpwa=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEq(sig, await hmac(env, 'session:' + exp));
}
async function login(req, env) {
  const fails = JSON.parse((await getSetting(env, 'login_fails')) || '{"n":0,"t":0}');
  if (fails.n >= 10 && Date.now() - fails.t < 15 * 60000) return loginPage('Bahut galat koshish — 15 minute baad try kijiye.', 429);
  const form = await req.formData();
  const pw = String(form.get('password') || '');
  if (!env.DASHBOARD_PASSWORD || !safeEq(pw, env.DASHBOARD_PASSWORD)) {
    const n = Date.now() - fails.t < 15 * 60000 ? fails.n + 1 : 1;
    await setSetting(env, 'login_fails', JSON.stringify({ n, t: Date.now() }));
    await new Promise(r => setTimeout(r, 800));
    return loginPage('Password galat hai.', 401);
  }
  await setSetting(env, 'login_fails', JSON.stringify({ n: 0, t: 0 }));
  const exp = Date.now() + SESSION_DAYS * DAY;
  const cookie = 'xpwa=' + encodeURIComponent(exp + '.' + await hmac(env, 'session:' + exp)) +
    '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + SESSION_DAYS * 86400;
  return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': cookie } });
}

const SEC_HEADERS = { 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function loginPage(err, status) {
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>WhatsApp Inbox</title><style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f4f5f7;margin:0;' +
    'display:flex;min-height:100vh;align-items:center;justify-content:center;color:#1a1a1a}form{background:#fff;border:1px solid #e3e5e9;' +
    'border-radius:14px;padding:24px;width:min(340px,calc(100vw - 32px))}h1{font-size:18px;margin:0 0 14px}input{width:100%;padding:10px;' +
    'border:1px solid #d0d3d9;border-radius:8px;font-size:15px;box-sizing:border-box}button{margin-top:12px;width:100%;padding:10px;' +
    'border:0;border-radius:8px;background:#1e3a8a;color:#fff;font-weight:700;font-size:15px}.e{color:#dc2626;font-size:13px;margin-top:10px}' +
    '@media (prefers-color-scheme:dark){body{background:#111214;color:#e8e8ea}form{background:#1b1c1f;border-color:#2d2f34}input{background:#111214;color:#e8e8ea;border-color:#2d2f34}}' +
    '</style></head><body><form method="post" action="/login"><h1>📥 WhatsApp Inbox</h1>' +
    '<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">' +
    '<button type="submit">Kholo</button>' + (err ? '<div class="e">' + err + '</div>' : '') + '</form></body></html>';
  return new Response(html, { status: status || 200, headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, SEC_HEADERS) });
}

function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, SEC_HEADERS) });
}

// ===================================================================
// Entry points
// ===================================================================
export function makeWorker(inboxHtml, userScript) {
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
        if (p === '/favicon.ico') return new Response(null, { status: 204 });
        if (p === '/login' && req.method === 'POST') return login(req, env);
        if (p === '/logout') {
          return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': 'xpwa=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' } });
        }
        const authed = await isAuthed(req, env);
        if (p === '/api/rpc' && req.method === 'POST') {
          if (!authed) return json({ error: 'login' }, 401);
          // Same-origin only: a page elsewhere cannot drive the inbox with the user's cookie.
          const origin = req.headers.get('origin');
          if (origin && origin !== url.origin) return json({ error: 'bad origin' }, 403);
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
          if (!authed) return loginPage('');
          const token = await secretSetting(env, 'webhook_token');
          return new Response(String(userScript || '').replace('__ENDPOINT__', url.origin + '/webhook?token=' + token),
            { headers: Object.assign({ 'Content-Type': 'text/javascript; charset=utf-8' }, SEC_HEADERS) });
        }
        if (p === '/' && req.method === 'GET') {
          if (!authed) return loginPage('');
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
        await env.DB.prepare('DELETE FROM messages WHERE received_at < ?').bind(Date.now() - KEEP_DAYS * DAY).run();
        await syncNames(env, true);
      } else if (cron === '0 */6 * * *') {
        await syncNames(env, false);
      }
    }
  };
}
