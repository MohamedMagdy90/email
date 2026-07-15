# DNA Outreach — Simple Email Sender

A simple tool to send promotional emails to potential **customers** and **partners**.
No AI. No complications.

## What it does
1. Build a list of company emails (crawl websites + add manually + import CSV).
2. Pick a saved template (Customer or Partner) and fill in the blanks.
3. Select the contacts to send to.
4. Send.

## Two email types
- **Customer** — sells DNA ERP.
- **Partner** — sells the Makers program (35% / 15% commission) to accounting firms, IT providers / VARs, ERP consultancies, and regional distributors.

## Templates (no AI)
- Save and reuse templates.
- Merge tags fill in per recipient: `{{company}}`, `{{country}}`, `{{industry}}`, `{{email}}`.
- Write in plain text or paste your own HTML.

## Finding emails (crawler)
- Paste a website (or a list of websites) → crawl for public emails: `info@`, `sales@`, `contact@`.
- Or add emails manually.
- Or import a CSV.
- Auto dedupe + auto-skip anyone unsubscribed or bounced.

## Sending (via Resend + domain rotation)
- The app sends through **Resend** (your subscription) using its API. No mail server, no mailboxes.
- Add **multiple verified domains** in Resend → the app **rotates** between them to spread volume.
- Per-domain **daily cap** + **random delay** between emails.
- Auto unsubscribe link on every email.
- Verify **secondary domains** only (e.g. `dna-erp.com`) — never `dna.systems`.

## Important: Resend + cold email
- Domain rotation spreads volume so no single domain looks spammy (better inbox placement).
- BUT all domains sit under one Resend account. Resend bans cold/unsolicited lists and watches account-wide bounce + complaint rates.
- If complaints spike, Resend can suspend the whole account — rotation can't prevent that.
- **Rule:** keep lists targeted and clean, personalize, keep volume sensible, watch complaints.

## Deliverability safeguards (built in)
- Domain rotation to spread volume.
- Daily send cap per domain.
- Random delay between sends.
- Auto-skip bounced / unsubscribed contacts.
- Unsubscribe link on every email.

## Screens (only 4)
1. **Contacts** — add / import / crawl, view the list.
2. **Templates** — create & edit Customer and Partner templates.
3. **Send** — pick template → pick contacts → review → send.
4. **History** — sent / opened / bounced / unsubscribed.

## Tech stack
- **Frontend:** React (Vite) + Tailwind → hosted on **Netlify**.
- **Backend:** Bun + Hono API → hosted on **Railway**.
- **Database:** Postgres (on Railway).
- **Sending:** **Resend API** (multiple domains + rotation).
- **Crawler:** backend fetch + email pattern match.

## What you provide
- Your **Resend API key** (you have it).
- **1–3 secondary domains** verified in Resend (add the DNS records Resend gives you).
- Never `dna.systems`.

## Costs
- App, crawler, templates, sending logic — free.
- Resend — your existing plan.
- Secondary domains — ~$10/year each.
- Railway — ~$5/month hobby plan.
- (No mailbox / Workspace fees — we don't use mailboxes.)

## Data model (simple)
- **contacts:** id, email, company, country, industry, status (new / sent / bounced / unsubscribed)
- **templates:** id, type (customer / partner), subject, body
- **domains:** id, domain, from_name, from_email, daily_cap, sent_today
- **sends:** id, contact_id, template_id, domain_id, status, sent_at, opened

## Build order
1. **Core:** Contacts + Templates + Send + Resend/domains settings with rotation.
2. **Add-ons:** Website crawler + CSV import + History/tracking.
