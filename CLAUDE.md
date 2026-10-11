# Working on this project

- **Language:** everything the user sees — dashboard text, buttons, messages, WhatsApp summaries, errors,
  documentation — is written in clear, professional English. Do not use Hindi or Hinglish in the product.
- Run `node test/run.mjs` before every push; a push to `main` deploys to Cloudflare.
- WaSender cannot fetch history; WhatsApp Web (Tampermonkey) is the primary message source.
- Keep the dashboard's look aligned with the PO Tracker: white underline tab bar, stats line over a blue rule, card grid with coloured left edge and full-width buttons.
