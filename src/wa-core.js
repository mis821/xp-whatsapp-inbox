/*
 * XP WhatsApp Inbox — the part that runs INSIDE WhatsApp Web (served by the Worker at /wa-core.js).
 *
 * The Tampermonkey script is only a loader: it fetches WA-JS and this file fresh on every page
 * load and injects both. So a fix here reaches the office PC on its next reload, with nobody
 * reinstalling anything. No Tampermonkey functions here — only WPP and the DOM; rows leave as a
 * DOM event that the loader forwards to the Worker.
 */
(function () {

    var DAYS_BACK = 2;
    var PER_CHAT = 60;
    var CHECK_DAYS = 7;          // chats active this recently are compared for deleted messages
    var DEEP = 400;              // messages compared in a chat that has items on the dashboard's lists
    var RECHECK_MIN = 30;        // compare again this often while the tab stays open

    function emit(rows) { if (rows.length) document.dispatchEvent(new CustomEvent('xpwa-rows', { detail: JSON.stringify(rows) })); }
    function status(s) { document.dispatchEvent(new CustomEvent('xpwa-status', { detail: s })); }

    // WhatsApp Web writes people as …@c.us; the dashboard (like WaSender) uses …@s.whatsapp.net.
    function wid(w) {
      if (!w) return '';
      var s = typeof w === 'string' ? w : (w._serialized || (w.toString ? w.toString() : ''));
      return String(s).replace(/@c\.us$/, '@s.whatsapp.net');
    }
    // A LID (…@lid) is not a phone number. WhatsApp's contact record often knows the phone behind
    // it; without it the dashboard falls back to its own contact list.
    function phoneOf(w) {
      try {
        if (!w || !/@lid$/.test(wid(w))) return '';
        var c = WPP.whatsapp.ContactStore.get(w);
        var pn = c && (c.phoneNumber || (c.attributes && c.attributes.phoneNumber));
        return pn ? wid(pn).split('@')[0].replace(/\D/g, '') : '';
      } catch (e) { return ''; }
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
      var senderWid = fromMe ? null : (isGroup ? (m.author || m.id.participant) : (m.from || m.id.remote));
      var sender = wid(senderWid);
      // For media, `body` holds a thumbnail, not words — only the caption / file name is text.
      var text = type === 'chat' ? (m.body || '') : (m.caption || m.filename || '');
      if (type === 'call_log') text = (m.isVideoCall ? 'Video call ' : 'Call ') + (m.callOutcome === 'missed' ? 'missed' : 'received');
      return {
        id: m.id.id, t: (m.t || 0) * 1000, chat: chat, chat_name: name || '', from_me: fromMe ? 1 : 0,
        sender: sender, sender_phone: /@s\.whatsapp\.net$/.test(sender) ? sender.split('@')[0] : phoneOf(senderWid),
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
                  type: c.isVideo ? 'video call' : 'call', text: (c.isVideo ? 'Video call' : 'Call') + ' received', mentions: '', reply_to: '' }]);
        });
      } catch (e) { /* older WA-JS without call events — messages still flow */ }
      // Deleted for everyone: WhatsApp tells us which message it was.
      try {
        WPP.on('chat.msg_revoke', function (e) {
          var k = e && e.refId, id = k && (k.id || (typeof k === 'string' ? k.split('_')[2] : ''));
          if (id) bridge('/wa-deletes', 'POST', { msgs: [{ id: String(id).slice(0, 120) }] });
        });
      } catch (e) { /* the next comparison still catches it */ }
      // A whole chat deleted: checked again after a moment, because WhatsApp also briefly removes a
      // chat when it moves a person from a phone-number id to a LID id.
      try {
        WPP.whatsapp.ChatStore.on('remove', function (c) {
          var jid = wid(c && c.id);
          if (!jid) return;
          setTimeout(async function () {
            var present = await presentUsers();
            if (present && !present[jid.split('@')[0]]) bridge('/wa-deletes', 'POST', { chats: [jid] });
          }, 15000);
        });
      } catch (e) { /* the next comparison still catches it */ }
      backfill(true);
      setInterval(function () { backfill(false); }, RECHECK_MIN * 60000);
      startReplies();
    }

    // Everyone WhatsApp Web has a chat with, by number / LID / group id. A person can appear under
    // either a phone number or a LID, so both are collected. Null while WhatsApp is still loading.
    async function presentUsers() {
      var chats = [];
      try { chats = await WPP.chat.list(); } catch (e) { return null; }
      if (chats.length < 20) return null;
      var set = {};
      var add = function (w) { var s = wid(w); if (s) set[s.split('@')[0]] = 1; };
      chats.forEach(function (c) {
        add(c.id);
        try {
          var ct = c.contact;
          if (ct) { add(ct.phoneNumber || (ct.attributes && ct.attributes.phoneNumber)); add(ct.lid || (ct.attributes && ct.attributes.lid)); }
        } catch (e) { /* ignore */ }
      });
      return set;
    }

    // What arrived while this page was closed (every chat active in the last two days), and what
    // was deleted on WhatsApp: for each chat, the ids WhatsApp still has between its oldest and
    // newest loaded message go to the dashboard, which removes whatever it holds in that window
    // that is no longer there. `withRows` = also send the messages (only on page load).
    var checking = false;
    async function backfill(withRows) {
      if (checking) return;
      checking = true;
      try { await compare(withRows); } catch (e) { /* next round */ }
      checking = false;
      status('live ✓');
    }
    async function compare(withRows) {
      var now = Date.now() / 1000, since = now - DAYS_BACK * 86400, checkSince = now - CHECK_DAYS * 86400;
      var chats = [];
      try { chats = await WPP.chat.list(); } catch (e) { status('live ✓ (earlier messages could not be loaded)'); return; }
      var known = {};
      try {
        var k = await bridge('/wa-check', 'GET');
        if (k.status === 200) (JSON.parse(k.body).chats || []).forEach(function (c) { known[c.chat] = c; });
      } catch (e) { /* compare recent chats only */ }
      var list = chats.filter(function (c) { var j = known[wid(c.id)]; return (c.t || 0) >= checkSince || (j && j.flagFrom); });
      var snaps = [], done = 0;
      for (var i = 0; i < list.length; i++) {
        var c = list[i], jid = wid(c.id), kc = known[jid];
        try {
          var msgs = await WPP.chat.getMessages(c.id, { count: kc && kc.flagFrom ? DEEP : PER_CHAT });
          var name = c.formattedTitle || c.name || '';
          if (withRows && (c.t || 0) >= since) {
            var rows = [];
            msgs.forEach(function (m) { if ((m.t || 0) >= since) { var r = row(m, name); if (r) rows.push(r); } });
            emit(rows);
          }
          var lo = Infinity, hi = 0, ids = [];
          msgs.forEach(function (m) {
            if (!m || !m.id || !m.id.id || !(m.t > 0)) return;
            lo = Math.min(lo, m.t * 1000); hi = Math.max(hi, m.t * 1000);
            if (m.type !== 'revoked') ids.push(String(m.id.id).slice(0, 120));   // "This message was deleted" → remove it
          });
          if (kc && ids.length && hi > lo) snaps.push({ chat: jid, after: lo, upto: hi, ids: ids });
        } catch (e) { /* skip this chat */ }
        done++;
        if (withRows && done % 10 === 0) status('loading earlier messages: ' + done + '/' + list.length + ' chats');
        if (snaps.length >= 20) { await bridge('/wa-deletes', 'POST', { snaps: snaps }); snaps = []; }
        await new Promise(function (r) { setTimeout(r, 40); });
      }
      if (snaps.length) await bridge('/wa-deletes', 'POST', { snaps: snaps });
      // Whole chats deleted while this page was closed. Skipped if it looks like WhatsApp has not
      // finished loading its chat list (too few chats, or too many apparently gone at once).
      var present = await presentUsers();
      if (present) {
        var gone = Object.keys(known).filter(function (j) { return known[j].web && !present[j.split('@')[0]]; });
        if (gone.length && gone.length <= 25) await bridge('/wa-deletes', 'POST', { chats: gone });
      }
    }

    // WA-JS 4 calls its readiness hooks WPP.loader; older releases called them WPP.webpack.
    var started = false;
    function go() { if (!started) { started = true; start(); } }
    // ---------- replies written on the dashboard ----------
    var pendingFetch = {}, fetchSeq = 0;
    document.addEventListener('xpwa-fetch-done', function (e) {
      try { var r = JSON.parse(e.detail); var cb = pendingFetch[r.id]; delete pendingFetch[r.id]; if (cb) cb(r); } catch (x) { /* ignore */ }
    });
    function bridge(path, method, body) {
      return new Promise(function (resolve) {
        var id = ++fetchSeq;
        pendingFetch[id] = resolve;
        document.dispatchEvent(new CustomEvent('xpwa-fetch', { detail: JSON.stringify({ id: id, path: path, method: method, body: body }) }));
        setTimeout(function () { if (pendingFetch[id]) { delete pendingFetch[id]; resolve({ status: 0, body: '' }); } }, 35000);
      });
    }
    // The dashboard stores chats as …@s.whatsapp.net; WhatsApp Web calls them …@c.us.
    function waChatId(jid) { return String(jid).replace(/@s\.whatsapp\.net$/, '@c.us'); }
    async function sendOne(item) {
      var chatId = waChatId(item.chat);
      var opts = {};
      if (item.quote) {
        try {
          var msgs = await WPP.chat.getMessages(chatId, { count: 400 });
          for (var i = 0; i < msgs.length; i++) if (msgs[i].id && msgs[i].id.id === item.quote) { opts.quotedMsg = msgs[i].id; break; }
        } catch (e) { /* send without the quote rather than not at all */ }
      }
      await WPP.chat.sendTextMessage(chatId, item.text, opts);
    }
    var polling = false;
    async function pollOutbox() {
      if (polling) return;
      polling = true;
      try {
        var r = await bridge('/wa-outbox', 'GET');
        if (r.status === 200) {
          var items = (JSON.parse(r.body || '{}').items) || [];
          for (var i = 0; i < items.length; i++) {
            var ok = true, err = '';
            try { await sendOne(items[i]); } catch (e) { ok = false; err = (e && e.message) || String(e); }
            await bridge('/wa-outbox', 'POST', { id: items[i].id, ok: ok, error: err });
            status(ok ? 'live ✓ · reply sent' : '⚠ reply not sent: ' + err.slice(0, 60));
          }
        }
      } catch (e) { /* next round */ }
      polling = false;
    }
    function startReplies() {
      if (document.documentElement.getAttribute('data-xpwa-bridge') !== '1') {
        status('live ✓ · update the script to enable replies (Setup → copy script)');
        return;
      }
      pollOutbox();
      setInterval(pollOutbox, 8000);
    }

    function waitForWpp(tries) {
      var L = window.WPP && (WPP.loader || WPP.webpack);
      if (L && typeof L.onReady === 'function') {
        if (WPP.isReady) go(); else L.onReady(go);
      } else if (tries > 0) {
        setTimeout(function () { waitForWpp(tries - 1); }, 500);
      } else {
        status('⚠ WA-JS did not start (' + (window.WPP ? 'WPP: ' + Object.keys(WPP).slice(0, 8).join(',') : 'WPP not found') + ') — please reload the page');
      }
    }
    status('waiting for WhatsApp to load…');
    waitForWpp(120);
  })();
