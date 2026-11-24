// Local server: the real Worker over node:sqlite, seeded with sample (made-up) messages. For UI tests.
import http from 'node:http';
import fs from 'node:fs';
import { makeD1 } from './d1.mjs';
import { makeWorker } from '../src/app.js';
const ROOT = new URL('..', import.meta.url).pathname;
const ME_LID = '123450000000001', ME_PN = '919999900000';
const groups = [['G1@g.us', 'XPP | Jyoti Timbers | Orders & Bills'], ['G2@g.us', 'Internal Payment Request'], ['G3@g.us', 'XP Store Ops'],
  ['G4@g.us', 'XPP | Maruti Paper'], ['G6@g.us', 'XPP | Shivani Steel'], ['G7@g.us', 'Daily holding vehicles update'],
  ['G8@g.us', 'XPP | Bhagwati Kripa paper (Reel)'], ['G9@g.us', 'Vendor payment']];
// A made-up ERPNext for the 🧾 Reconciliation tab: a few debit notes, and a one-page PDF.
const ERP = { 'Purchase Invoice': ['PRET-2627-00031', 'PRET-HR-26270013', 'PRET-25-00168', 'PRET-25-00170'], 'Purchase Receipt': [],
  'Journal Entry': ['PRET-GJ-26270003'] };
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
function fakeErp(u) {
  if (u.pathname.startsWith('/api/resource/')) {
    const dt = decodeURIComponent(u.pathname.slice(14)), [[, op, val]] = JSON.parse(u.searchParams.get('filters'));
    const re = new RegExp('^' + String(val).split('%').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    const data = (ERP[dt] || []).filter(n => op === 'in' ? val.includes(n) : re.test(n))
      .map(name => ({ name, supplier: 'Demo Supplier', posting_date: '2026-06-18', grand_total: 5499, total_debit: 5499, docstatus: name.includes('HR') ? 2 : 1 }));
    return new Response(JSON.stringify({ data }));
  }
  return new Response(PDF, { headers: { 'content-type': 'application/pdf' } });
}
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://xpertpack.frappe.cloud')) return fakeErp(new URL(String(url)));
  const path = String(url).replace('https://www.wasenderapi.com/api', '');
  const j = d => new Response(JSON.stringify(d));
  if (path === '/user') return j({ data: { id: ME_PN + ':1@s.whatsapp.net', lid: ME_LID + ':1@lid', name: 'XP Purchase' } });
  if (path === '/status') return j({ status: 'connected' });
  if (path === '/groups') return j({ data: groups.map(g => ({ id: g[0], name: g[1] })) });
  if (path === '/contacts') return j({ data: [{ id: '918888800001@s.whatsapp.net', lid: '701@lid', notify: 'Ramesh (Jyoti)' },
    { id: '918888800002@s.whatsapp.net', lid: '702@lid', notify: 'Sunil Store' }, { id: '918888800003@s.whatsapp.net', lid: '703@lid', notify: 'Accounts - Pooja' },
    { id: '918888800004@s.whatsapp.net', lid: '704@lid', notify: 'Vikas Maruti' }, { id: '918888800005@s.whatsapp.net', lid: '705@lid', notify: 'Anil Shivani Steel' },
    { id: '917777700000@s.whatsapp.net', lid: null, notify: 'Mahesh Bhagwati' }] });
  return j({ success: true, data: {} });
};
const env = { DB: makeD1(ROOT + 'migrations'), WASENDER_API_KEY: 'k', DASHBOARD_PASSWORD: 'demo', ERP_API_TOKEN: 'demo:demo' };
const worker = makeWorker(fs.readFileSync(ROOT + 'src/inbox.html', 'utf8'), fs.readFileSync(ROOT + 'src/wa-sync.user.js', 'utf8'), fs.readFileSync(ROOT + 'src/wa-core.js', 'utf8'));
const call = (path, init) => worker.fetch(new Request('http://localhost:8787' + path, init), env, { waitUntil() {} });
const { syncNames } = await import('../src/app.js');
await syncNames(env, true);
const token = (await call('/health'), env.DB.raw.prepare("SELECT v FROM settings WHERE k='webhook_token'").get());
const r0 = await call('/webhook?token=x', { method: 'POST', body: '{}' });
const tok = env.DB.raw.prepare("SELECT v FROM settings WHERE k='webhook_token'").get().v;
const sec = Math.floor(Date.now() / 1000); let n = 0;
const msg = (chat, who, mins, text, extra = {}) => call('/webhook?token=' + tok, { method: 'POST', body: JSON.stringify({ event: 'messages.upsert', data: { messages: {
  key: Object.assign({ id: 'M' + (++n), fromMe: who === 'me', remoteJid: chat }, chat.endsWith('@g.us') && who !== 'me' ? { participant: who + '@lid' } : {}),
  messageTimestamp: sec - mins * 60, messageBody: text, message: extra.message || { extendedTextMessage: { text, contextInfo: extra.ctx || {} } } } } }) });
await msg('G1@g.us', '701', 400, 'Sir last week ka material bill bhej diya hai, payment kab tak hoga?');
await msg('G1@g.us', '701', 180, '@' + ME_LID + ' sir payment ka update de dijiye please', { ctx: { mentionedJid: [ME_LID + '@lid'] } });
await msg('G3@g.us', '702', 300, 'Shivani Steel ka material aa gaya, 2 coil short hai');
await msg('G3@g.us', 'me', 280, 'ok, short qty ka debit note banao');
await msg('G3@g.us', '702', 95, 'Bhagwati Kripa ki gaadi gate pe khadi hai, unloading ke liye manpower nahi hai');
await msg('G2@g.us', '703', 240, 'Jyoti Timbers ka payment approval chahiye - ₹1,84,500');
await msg('G2@g.us', '703', 60, 'Sir ye approve kar dijiye', { ctx: { participant: ME_PN + '@s.whatsapp.net' } });
await msg('G4@g.us', '704', 150, 'Sir rate revise hoga next month se, 3% increase');
await msg('G4@g.us', '704', 147, '', { message: { documentMessage: { fileName: 'Maruti_rate_list_Nov.pdf' } } });
await msg('G6@g.us', '705', 70, 'Dispatch kal subah ho jayega sir');
await msg('G7@g.us', '702', 30, 'HR55 AB 1234 — 4 ghante se hold');
await msg('G8@g.us', '918888800009', 45, 'Reel ka payment pending hai 45 din se');
await msg('G9@g.us', '703', 20, 'Aaj ki payment list final kar di hai');
await msg('G4@g.us', '704', 35, 'Neeraj sir ko bol dijiye rate list approve karni hai');
await msg('G6@g.us', '705', 25, 'Sir pichle 2 bill ka pymt kara dijiye please');
for (const [mins, id, title, due, whose] of [[300, 'k0tIhWwvjSbeNvSP', 'Debit note to Shakti Gum', '10 Oct', ''], [12, 'k0tIhWwvjSbeNvSP', 'Debit note to Shakti Gum', '10 Oct', ''],
    [290, 'LYTXbnT8Oppmf_LR', 'Generator in chennai', '9 Oct', ''], [280, 'PnKtfLEALPtaYYiA', 'need suppliers names in the...', '5 Oct', "Hitesh's task"]]) {
  await msg('918447731703@s.whatsapp.net', 'x', mins, "Neeraj, '" + title + "' was due on " + due + '. When will you close it?' + (whose ? ' (' + whose + ')' : '') +
    ' If the date has moved, change it here: https://tools.xpertpack.in/tasks/t/' + id);
}
await call('/webhook?token=' + tok, { method: 'POST', body: JSON.stringify({ event: 'xp.rows', data: { rows: [
  { id: 'OW1', t: Date.now() - 40 * 60000, chat: 'G5@g.us', sender: '918447731702@s.whatsapp.net', sender_phone: '918447731702', sender_name: 'Hitesh Sir', text: 'Purchase team kal 10 baje meeting mein aaye' },
  { id: 'OW2', t: Date.now() - 20 * 60000, chat: '918383828836@s.whatsapp.net', sender: '918383828836@s.whatsapp.net', sender_phone: '918383828836', sender_name: 'Raj Kumar Sir', text: 'Neeraj, Chennai plant ka PO status bhejo' }] } }) });
await msg('917777700000@s.whatsapp.net', 'x', 15, 'Sir call kijiye urgent');
await call('/webhook?token=' + tok, { method: 'POST', body: JSON.stringify({ event: 'call', data: { call: { id: 'C9', from: '917777700000@s.whatsapp.net', date: new Date(Date.now() - 14 * 60000).toISOString(), status: 'offer' } } }) });
for (const [mins, id, sup, sum, rows, note] of [
  [50, 'NNAu7IN0nQuXqfa3', 'Shivani Steel', '3 debit notes not in their books (₹24,827), send and get them booked',
    ['PRET262700031  18-Jun-26  ₹5,499  (their bill 864)', 'PRET262700087  06-Aug-26  ₹7,464  (their bill 1575)', 'PRET-HR-26270013  26-Aug-26  ₹10,864  (their bill 1834)'], ''],
  [48, 'CX5IIOdhzdbjIgXb', 'Maruti Paper', '2 debit notes not in their books (₹8,318), and their CN/26-27/018 (₹99,768) missing in their own books',
    ['PRET-25-00168  22-Sep-25  ₹2,067  (their bill TI/25-26/01811)', 'PRET-25-00170  22-Sep-25  ₹6,251  (their bill TI/25-26/01629)'],
    'Their credit note CN/26-27/018 of 31-Jul-26, ₹99,768: we booked it on 23-Sep-26 (PRET-GJ-26270003), it is not in their ledger.']]) {
  await msg('919000000001@s.whatsapp.net', 'x', mins, 'Hi Neeraj, one task for you —\n' + sup + ': ' + sum + '\n\nOur debit notes missing in their ledger:\n' +
    rows.join('\n') + (note ? '\n\n' + note : '') + '\n\nWhen can you finish it? Put a date on the link.\nClose it there when done:\nhttps://tools.xpertpack.in/tasks/t/' + id);
}
await msg(ME_LID + '@lid', 'me', 120, '#kaam Jyoti Timbers: payment kal ho jayega');
await msg(ME_LID + '@lid', 'me', 110, '#kaam Shivani Steel - 2 coil short ka debit note aaj');
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await call(req.url, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) });
  const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
  res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787, () => console.log('listening 8787'));
