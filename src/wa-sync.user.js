// ==UserScript==
// @name         XP WhatsApp Inbox — sync
// @namespace    xp-whatsapp-inbox
// @version      1.0.0
// @description  WhatsApp Web (office number) ke messages aur calls XP WhatsApp Inbox dashboard ko bhejta hai.
// @match        https://web.whatsapp.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addElement
// @connect      workers.dev
// @connect      github.com
// @connect      githubusercontent.com
// @connect      cdn.jsdelivr.net
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * How it works. WhatsApp Web already has every message on this screen. WA-JS (wppconnect, open
 * source) gives a script a way to ask WhatsApp Web for them: new messages as they arrive, and the
 * last two days' messages of every chat when the page opens. This script turns each one into a
 * flat row and posts it to the dashboard. It only READS — it never sends, deletes or marks anything.
 *
 * Two halves, because of where code may run:
 *   - pageMain() runs inside WhatsApp Web's own page (that is where WA-JS can reach WhatsApp's
 *     internals) and hands rows out as a DOM event;
 *   - the rest runs in Tampermonkey's sandbox, the only place allowed to POST to another site
 *     (WhatsApp Web's security policy blocks the page itself from doing that).
 *
 * The dashboard drops duplicates, so re-sending the same message on every page load is harmless.
 */
(function () {
  'use strict';

  var ENDPOINT = '__ENDPOINT__';
  var WAJS_URLS = [
    'https://github.com/wppconnect-team/wa-js/releases/latest/download/wppconnect-wa.js',
    'https://cdn.jsdelivr.net/npm/@wppconnect/wa-js/dist/wppconnect-wa.js'
  ];
  var BATCH = 200;

  var queue = [], sending = false, sent = 0, lastOk = 0, lastErr = '', stage = 'WA-JS load ho raha hai…';

  // ---------- small status badge, bottom-left ----------
  var badgeEl = null;
  function badge() {
    if (!badgeEl) {
      badgeEl = document.createElement('div');
      badgeEl.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;font:12px/1.3 Arial,sans-serif;' +
        'padding:5px 9px;border-radius:8px;color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.25);pointer-events:none;opacity:.92';
      document.body.appendChild(badgeEl);
    }
    var bad = !!lastErr;
    badgeEl.style.background = bad ? '#dc2626' : (lastOk ? '#16a34a' : '#475569');
    badgeEl.textContent = 'XP Inbox: ' + (bad ? '⚠ ' + lastErr : stage) +
      (sent ? ' · ' + sent + ' bheje' : '') + (queue.length ? ' · ' + queue.length + ' line mein' : '');
  }

  // ---------- sending ----------
  function flush() {
    if (sending || !queue.length) return;
    sending = true;
    var batch = queue.splice(0, BATCH);
    var retry = function (why) {
      sending = false;
      queue = batch.concat(queue);
      lastErr = why;
      badge();
      setTimeout(flush, 20000);
    };
    GM_xmlhttpRequest({
      method: 'POST', url: ENDPOINT, timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ event: 'xp.rows', data: { rows: batch } }),
      onload: function (r) {
        if (r.status !== 200) return retry(r.status === 401 ? 'token galat — script dobara install kijiye' : 'server ' + r.status);
        sending = false; sent += batch.length; lastOk = Date.now(); lastErr = '';
        badge();
        setTimeout(flush, 300);
      },
      onerror: function () { retry('internet / server nahi mila'); },
      ontimeout: function () { retry('server slow'); }
    });
  }

  document.addEventListener('xpwa-rows', function (e) {
    try { Array.prototype.push.apply(queue, JSON.parse(e.detail)); } catch (x) { return; }
    if (queue.length > 30000) queue.splice(0, queue.length - 30000);
    badge();
    flush();
  });
  document.addEventListener('xpwa-status', function (e) { stage = String(e.detail); badge(); });

  // ---------- load WA-JS into the page, then pageMain ----------
  function get(url) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET', url: url, timeout: 60000,
        onload: function (r) { r.status === 200 && r.responseText.length > 10000 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)); },
        onerror: function () { reject(new Error('network')); },
        ontimeout: function () { reject(new Error('timeout')); }
      });
    });
  }
  (async function () {
    badge();
    var code = null;
    for (var i = 0; i < WAJS_URLS.length && !code; i++) {
      try { code = await get(WAJS_URLS[i]); } catch (e) { /* try the next mirror */ }
    }
    if (!code) { lastErr = 'WA-JS download nahi hua'; badge(); return; }
    GM_addElement('script', { textContent: code });
    GM_addElement('script', { textContent: '(' + pageMain.toString() + ')();' });
  })();

  // ===================================================================
  // Runs INSIDE WhatsApp Web. No Tampermonkey functions here — only WPP and the DOM.
  // ===================================================================
  function pageMain() {
    var DAYS_BACK = 2;
    var PER_CHAT = 60;

    function emit(rows) { if (rows.length) document.dispatchEvent(new CustomEvent('xpwa-rows', { detail: JSON.stringify(rows) })); }
    function status(s) { document.dispatchEvent(new CustomEvent('xpwa-status', { detail: s })); }

    // WhatsApp Web writes people as …@c.us; the dashboard (like WaSender) uses …@s.whatsapp.net.
    function wid(w) {
      if (!w) return '';
      var s = typeof w === 'string' ? w : (w._serialized || (w.toString ? w.toString() : ''));
      return String(s).replace(/@c\.us$/, '@s.whatsapp.net');
    }
    function chatName(id) {
      try {
        var c = WPP.chat.get(id);
        if (!c) return '';
        return c.formattedTitle || c.name || (c.contact && (c.contact.name || c.contact.pushname)) || '';
      } catch (e) { return ''; }
    }

    // System notices, reactions, edits and deletes are not things a person said.
    var SKIP = { e2e_notification: 1, notification_template: 1, notification: 1, gp2: 1, protocol: 1, reaction: 1,
                 revoked: 1, ciphertext: 1, broadcast_notification: 1, pinned_message: 1, keep_in_chat: 1,
                 poll_update: 1, debug: 1, unknown: 1 };
    var TYPE = { chat: 'text', image: 'image', video: 'video', ptt: 'voice', audio: 'audio', document: 'document',
                 sticker: 'sticker', location: 'location', vcard: 'contact', multi_vcard: 'contact',
                 poll_creation: 'poll', call_log: 'call' };

    function row(m, name) {
      if (!m || !m.id || !m.id.id) return null;
      var type = m.type || 'chat';
      if (SKIP[type]) return null;
      var chat = wid(m.id.remote || (m.id.fromMe ? m.to : m.from));
      if (!chat || /@(broadcast|newsletter)$/.test(chat)) return null;
      var isGroup = /@g\.us$/.test(chat), fromMe = !!m.id.fromMe;
      var sender = fromMe ? '' : wid(isGroup ? (m.author || m.id.participant) : (m.from || chat));
      // For media, `body` holds a thumbnail, not words — only the caption / file name is text.
      var text = type === 'chat' ? (m.body || '') : (m.caption || m.filename || '');
      if (type === 'call_log') text = (m.isVideoCall ? 'Video call ' : 'Call ') + (m.callOutcome === 'missed' ? 'missed' : 'aaya');
      return {
        id: m.id.id, t: (m.t || 0) * 1000, chat: chat, chat_name: name || '', from_me: fromMe ? 1 : 0,
        sender: sender, sender_phone: /@s\.whatsapp\.net$/.test(sender) ? sender.split('@')[0] : '',
        sender_name: fromMe ? '' : (m.notifyName || (m.senderObj && (m.senderObj.name || m.senderObj.pushname)) || ''),
        type: TYPE[type] || type, text: String(text).slice(0, 3000),
        mentions: (m.mentionedJidList || []).map(wid).join(','), reply_to: wid(m.quotedParticipant)
      };
    }

    function start() {
      status('live ✓');
      WPP.on('chat.new_message', function (m) {
        try { var r = row(m, chatName(m.id.remote)); if (r) emit([r]); } catch (e) { /* one odd message must not stop the rest */ }
      });
      try {
        WPP.on('call.incoming_call', function (c) {
          var from = wid(c.sender || c.peerJid);
          if (!from) return;
          emit([{ id: 'call:' + c.id, t: c.offerTime ? c.offerTime * 1000 : Date.now(), chat: from, chat_name: chatName(c.sender || c.peerJid),
                  from_me: 0, sender: from, sender_phone: /@s\.whatsapp\.net$/.test(from) ? from.split('@')[0] : '', sender_name: '',
                  type: c.isVideo ? 'video call' : 'call', text: (c.isVideo ? 'Video call' : 'Call') + ' aaya', mentions: '', reply_to: '' }]);
        });
      } catch (e) { /* older WA-JS without call events — messages still flow */ }
      backfill();
    }

    // What arrived while this page was closed: every chat active in the last two days.
    async function backfill() {
      var since = Date.now() / 1000 - DAYS_BACK * 86400;
      var chats = [];
      try { chats = await WPP.chat.list(); } catch (e) { status('live ✓ (purane messages nahi mil paaye)'); return; }
      chats = chats.filter(function (c) { return (c.t || 0) >= since; });
      var done = 0, total = 0;
      for (var i = 0; i < chats.length; i++) {
        var c = chats[i];
        try {
          var msgs = await WPP.chat.getMessages(c.id, { count: PER_CHAT });
          var name = c.formattedTitle || c.name || '';
          var rows = [];
          msgs.forEach(function (m) { if ((m.t || 0) >= since) { var r = row(m, name); if (r) rows.push(r); } });
          emit(rows);
          total += rows.length;
        } catch (e) { /* skip this chat */ }
        done++;
        if (done % 10 === 0) status('purane messages: ' + done + '/' + chats.length + ' chats');
        await new Promise(function (r) { setTimeout(r, 40); });
      }
      status('live ✓');
    }

    function waitForWpp(tries) {
      if (window.WPP && WPP.webpack) {
        if (WPP.isReady) start(); else WPP.webpack.onReady(start);
      } else if (tries > 0) {
        setTimeout(function () { waitForWpp(tries - 1); }, 500);
      } else {
        status('⚠ WA-JS shuru nahi hua — page reload kijiye');
      }
    }
    status('WhatsApp ke ready hone ka intezaar…');
    waitForWpp(120);
  }
})();
