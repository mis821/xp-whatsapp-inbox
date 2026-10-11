# XP WhatsApp Inbox

Office number (XP Purchase) ke 260+ WhatsApp groups ka private dashboard.
Ye PO tracker se bilkul alag project hai. Isme koi Google Sheet nahi hai: ye Cloudflare Workers pe chalta hai aur data Cloudflare D1 database mein rehta hai (free plan).

## Kya milta hai
- **Inbox:** har group ke saare messages, bina tag wale bhi, aur har chat mein "bina dekhe" count.
  Jisme aapko tag kiya ho, aapke message pe reply aaya ho, personal message ho ya WhatsApp call ho, wo upar **"Reply baaki"** mein rukta hai. Wo tab tak wahan rehta hai jab tak aap WhatsApp pe jawab na de dein ya "✓ Ho gaya" na dabayein.
- **Mere Kaam:** commitments (payment, material, follow-up) due date aur team ke saath.
  "📤 Team ko bhejo" dabane se kaam Accounts ya Store ke group mein chala jata hai.
  Phone se: apne "Message yourself" chat mein `#kaam Party: kya promise kiya kal` likhiye, task turant ban jayega.
- **Shaam ka hisaab:** overdue kaam, kal ke kaam, reply baaki, aaj ke calls aur kahan kitne messages aaye.
  Setup mein summary chalu karenge to subah 9:30 aur shaam 7 baje ye summary aapke WhatsApp pe aayegi.

## Speed
Inbox khulte hi sirf list aati hai (har chat ka count aur aakhri message).
Test mein 30,000 messages aur 266 chats pe ye **125 KB mein ~90 ms** mein load hui.
Kisi chat ke messages tabhi aate hain jab aap use kholte hain (~9 KB).

## Setup (ek baar, ~15 min)
1. **Cloudflare account (free):** https://dash.cloudflare.com/sign-up
   Login ke baad ek baar **Workers & Pages** page kholiye. Isse aapka `*.workers.dev` address ban jata hai.
2. **API token:** My Profile → API Tokens → Create Token → template **"Edit Cloudflare Workers"** chuniye.
   Usme ek permission aur jodiye: **Account → D1 → Edit**. Phir Create dabaiye aur token copy kar lijiye.
   **Account ID** aapko Workers & Pages page pe right side mein milega.
3. **GitHub secrets:** is repo mein Settings → Secrets and variables → Actions → New repository secret. Ye 4 secrets daaliye:
   | Name | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | step 2 ka token |
   | `CLOUDFLARE_ACCOUNT_ID` | step 2 ka Account ID |
   | `WASENDER_API_KEY` | WaSender → aapka session → API key |
   | `DASHBOARD_PASSWORD` | dashboard kholne ka password (lamba rakhiye) |
4. **Deploy:** Actions → Deploy → Run workflow. Khatam hone pe Summary mein dashboard ka URL dikhega.
5. **Messages lana (WhatsApp Web se):** dashboard kholiye → **⚙️ Setup**:
   - Chrome mein **Tampermonkey** install kijiye. Extensions → Tampermonkey → Details mein **"Allow User Scripts"** ON kijiye.
   - **⬇ Script install karo** dabaiye → Tampermonkey mein **Install** dabaiye.
   - WhatsApp Web (office number) ka tab reload kijiye. Neeche left mein **"XP Inbox: live ✓"** dikhega.
   - Jab tak WhatsApp Web ka tab khula hai, messages aate rahenge. Tab kholte hi pichhle 2 din ke messages bhi aa jaate hain.
   - *Optional:* WaSender dashboard mil jaye to Setup tab ka webhook URL wahan daal dijiye. Phir computer band hone pe bhi messages aate rahenge.
6. Setup tab mein "Group names + contacts abhi laao" dabaiye. Chahein to WhatsApp summary bhi chalu kar dijiye.

Iske baad `main` pe har push apne aap deploy ho jayega.

## Dhyan rahe
- Computer ya WhatsApp Web ka tab band ho to us beech ke messages tab aayenge, jab tab dobara khulega (pichhle 2 din tak ke).
- Messages 30 din baad apne aap mit jaate hain. Kaam (tasks) kabhi nahi mitte.
- Webhook URL mein ek secret token hai. Ye URL kisi ko mat dijiye.

## Code
| File | Kya hai |
|---|---|
| `src/app.js` | webhook, database, login, inbox/kaam/summary, cron |
| `src/inbox.html` | dashboard page |
| `src/wa-sync.user.js` | Tampermonkey script: WhatsApp Web ke messages padh kar dashboard ko bhejti hai ([WA-JS](https://github.com/wppconnect-team/wa-js) ke zariye). Sirf padhti hai, kuch bhejti nahi |
| `migrations/0001_init.sql` | database tables |
| `wrangler.toml` | Worker config, cron times (UTC) |
| `test/run.mjs` | end-to-end tests (`node test/run.mjs`): asli SQL, nakli WaSender |
| `test/serve.mjs` | local demo server, sample data ke saath (password `demo`) |
