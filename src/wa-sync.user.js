// ==UserScript==
// @name         XP WhatsApp Inbox — sync
// @namespace    xp-whatsapp-inbox
// @version      1.2.0
// @description  WhatsApp Web (office number) ke messages XP WhatsApp Inbox dashboard ko bhejta hai, aur dashboard se likhe reply bhejta hai.
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
 * flat row and posts it to the dashboard. The one thing it ever sends is a reply you wrote on the
 * dashboard yourself (↩ Reply), as a quoted reply from this WhatsApp — nothing is deleted or marked.
 *
 * Two halves, because of where code may run:
 *   - wa-core.js (fetched from the dashboard on every load) runs inside WhatsApp Web's own page —
 *     that is where WA-JS can reach WhatsApp's internals — and hands rows out as a DOM event;
 *   - this file runs in Tampermonkey's sandbox, the only place allowed to POST to another site
 *     (WhatsApp Web's security policy blocks the page itself from doing that).
 *
 * The dashboard drops duplicates, so re-sending the same message on every page load is harmless.
 */
(function () {
  'use strict';

  var ENDPOINT = '__ENDPOINT__';
  // The in-page half lives on the Worker, so fixes reach this PC without reinstalling (see wa-core.js).
  var CORE_URL = ENDPOINT.replace('/webhook?', '/wa-core.js?');
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

  // Bridge: the in-page code (wa-core.js) cannot reach the dashboard itself (WhatsApp Web's security
  // policy), so it asks here. Only the dashboard's own /wa-… paths, always with this script's token.
  var BASE = ENDPOINT.split('/webhook?')[0];
  var TOKEN = (ENDPOINT.match(/[?&]token=([^&]+)/) || [])[1] || '';
  document.addEventListener('xpwa-fetch', function (e) {
    var q;
    try { q = JSON.parse(e.detail); } catch (x) { return; }
    var reply = function (status, body) {
      document.dispatchEvent(new CustomEvent('xpwa-fetch-done', { detail: JSON.stringify({ id: q.id, status: status, body: body }) }));
    };
    if (!/^\/wa-[a-z-]+$/.test(String(q.path || ''))) return reply(400, '');
    GM_xmlhttpRequest({
      method: q.method === 'POST' ? 'POST' : 'GET', url: BASE + q.path + '?token=' + TOKEN, timeout: 30000,
      headers: { 'Content-Type': 'application/json' }, data: q.body ? JSON.stringify(q.body) : undefined,
      onload: function (r) { reply(r.status, r.responseText); },
      onerror: function () { reply(0, ''); }, ontimeout: function () { reply(0, ''); }
    });
  });
  document.documentElement.setAttribute('data-xpwa-bridge', '1');

  // ---------- load WA-JS into the page, then pageMain ----------
  function get(url, minLen) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET', url: url, timeout: 60000,
        onload: function (r) { r.status === 200 && r.responseText.length > (minLen || 10000) ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)); },
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
    var core = null;
    try { core = await get(CORE_URL, 500); } catch (e) { lastErr = 'dashboard se script nahi mili (' + e.message + ')'; badge(); return; }
    GM_addElement('script', { textContent: code });
    GM_addElement('script', { textContent: core });
  })();

})();
