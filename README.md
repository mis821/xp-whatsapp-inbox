# XP WhatsApp Inbox

A private dashboard for the office WhatsApp number (XP Purchase) and its 260+ groups.
It is a standalone project — separate from the PO Tracker, with no Google Sheets. It runs on
Cloudflare Workers, with data in a Cloudflare D1 database (free plan).

## Tabs
- **⭐ Priority** — only messages where you are mentioned in a group, where "Neeraj" is named (any common spelling: Neeraj, Niraj, Neraj, नीरज), or where a payment is raised. Items stay until marked **✓ Done**; reading or replying on WhatsApp does not clear them.
- **📋 Task List** — daily reminders from the task system (tools.xpertpack.in), one card per task however many reminders arrive.
- **👑 Owners** — every message from Anant Sir, Hitesh Sir and Raj Kumar Sir (numbers in `OWNERS` in `src/app.js`).
- **✅ Work List** — commitments and follow-ups with due date and owner; can be sent to a team's WhatsApp group.
- **🌆 Daily Review**, **💬 All Chats**, **📊 Report**, **⚙️ Setup**.
- The screen is split 70 : 30 — click a card to see the full message, the conversation around it and every action on the right.
- **↩ Reply** — write a reply on the dashboard; WhatsApp Web sends it as a quoted reply from the office number (WaSender is the unquoted fallback when that tab is closed).
- GPS / vehicle position updates are never shown.

## Record and backup
- **Deleted on WhatsApp → deleted here.** A message deleted for everyone, a message you delete for yourself, or a whole chat you delete disappears from every tab, the report and the export. WhatsApp Web reports deletions live and re-checks every 30 minutes and on each reload (chats active in the last 7 days, and chats with listed items further back). Work List items you created yourself stay. A removed message is kept in a hidden trash for 30 days only, in case of a mistake.
- Every message that has ever been on a list, every Work List item and every reply is kept permanently; only ordinary chat messages are cleared after 30 days.
- **📊 Report** shows, per month, what came in and what was handled, response times and what is open now. Both lists download as Excel (CSV). On the **Priority** tab, **⬇ Payment list (Excel)** downloads every group (or contact name with mobile number, for direct chats) that still has a pending payment item; once you mark its items ✓ Done it drops off the list.
- The **Backup** workflow exports the full database every night (kept 90 days under Actions → Backup → Artifacts). Cloudflare D1 additionally keeps 30 days of point-in-time history.

## Lock and fingerprint sign-in
- The dashboard locks itself when the screen is locked (**Windows+L**) and after a chosen idle time (5–60 minutes, default 15), or with the **🔒 Lock** button. Locking ends the session on the server, so reloading the page only shows the sign-in screen.
- Windows+L detection uses Chrome's screen-lock detection, which needs a one-time **Allow** (banner at the top, or ⚙️ Setup → Security). Without it, only the idle timer applies.
- **Fingerprint sign-in:** ⚙️ Setup → Security → enter the dashboard password → **Add fingerprint**. The sign-in page then offers **"Sign in with fingerprint"** (Windows Hello). The password always remains available as a fallback.
- Windows Hello also accepts the laptop's Windows Hello PIN in place of the fingerprint; keep that PIN private.

## 🤖 Claude tab
Write work requests for Claude on the dashboard and choose which Claude conversation they are for (the list is refreshed hourly). Every hour Claude reads new requests (through the **Claude requests** workflow), asks for confirmation in the Claude conversation, and starts only after it is confirmed there (requests for another conversation are forwarded to it); progress and the result appear on the request's card. The **💬 Claude** button opens the conversation directly.

## Setup (once)
1. **Cloudflare account (free):** https://dash.cloudflare.com/sign-up — open **Workers & Pages** once so the `*.workers.dev` address is created.
2. **API token:** My Profile → API Tokens → Create Token → template **"Edit Cloudflare Workers"**, add **Account → D1 → Edit**. Note the **Account ID** shown on Workers & Pages.
3. **GitHub secrets** (Settings → Secrets and variables → Actions): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `WASENDER_API_KEY`, `DASHBOARD_PASSWORD`.
4. **Deploy:** Actions → Deploy → Run workflow. The summary shows the dashboard URL. Every push to `main` deploys automatically.
5. **Messages from WhatsApp Web:** dashboard → ⚙️ Setup → install Tampermonkey, enable "Allow User Scripts", install the script, reload WhatsApp Web. A green "XP Inbox: live ✓" label confirms it is running.

## Code
| File | Purpose |
|---|---|
| `src/app.js` | Webhook, database, login, Priority / Task List / Owners rules, Work List, replies, report, export, scheduled jobs |
| `src/inbox.html` | The dashboard |
| `src/wa-sync.user.js` | Tampermonkey loader: forwards WhatsApp Web messages, and is the bridge for replies |
| `src/wa-core.js` | Runs inside WhatsApp Web (served by the Worker, so updates need no reinstall) |
| `migrations/` | Database tables |
| `test/run.mjs` | End-to-end tests (`node test/run.mjs`) with real SQL and a fake WaSender |
| `test/serve.mjs` | Local demo server with sample data (password `demo`) |
