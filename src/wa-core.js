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
      if (type === 'call_log') text = (m.isVideoCall ? 'Video call ' : 'Call ') + (m.callOutcome === 'missed' ? 'missed' : 'aaya');
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

    // WA-JS 4 calls its readiness hooks WPP.loader; older releases called them WPP.webpack.
    var started = false;
    function go() { if (!started) { started = true; start(); } }
    function waitForWpp(tries) {
      var L = window.WPP && (WPP.loader || WPP.webpack);
      if (L && typeof L.onReady === 'function') {
        if (WPP.isReady) go(); else L.onReady(go);
      } else if (tries > 0) {
        setTimeout(function () { waitForWpp(tries - 1); }, 500);
      } else {
        status('⚠ WA-JS shuru nahi hua (' + (window.WPP ? 'WPP: ' + Object.keys(WPP).slice(0, 8).join(',') : 'WPP nahi mila') + ') — page reload kijiye');
      }
    }
    status('WhatsApp ke ready hone ka intezaar…');
    waitForWpp(120);
  })();
