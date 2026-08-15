import type { Template } from "./api";

type Starter = Pick<Template, "type" | "name" | "subject" | "body">;

export const STARTERS: Starter[] = [
  {
    type: "customer",
    name: "Customer — Intro",
    subject: "A simpler way to run {{company}}",
    body: `<p>Hi {{company}} team,</p>
<p>Most {{industry}} businesses lose hours every week to manual data entry, scattered spreadsheets, and slow approvals. DNA ERP brings finance, sales, inventory, procurement, and projects into one AI-powered platform — with no-code customization and real-time reporting.</p>
<p>A few things teams like yours use most:</p>
<p>• AI that reads invoices &amp; bank statements in seconds<br/>
• Multi-level approvals with a full audit trail<br/>
• Live dashboards instead of month-end surprises</p>
<p>Would you be open to a 15-minute look at how it'd fit {{company}}?</p>
<p>Best,<br/>The DNA Systems team</p>`,
  },
  {
    type: "partner",
    name: "Partner — Accounting & Audit firms",
    subject: "Add recurring revenue to {{company}}",
    body: `<p>Hi {{company}} team,</p>
<p>You already advise clients on finance and compliance — DNA ERP can be the system behind that advice, and a new recurring revenue line for your firm.</p>
<p>As a DNA Maker you'd earn <strong>up to 35% recurring commission</strong> for the life of every account and keep <strong>100% of your implementation &amp; services</strong> revenue. We never compete with you for the work.</p>
<p>It's already compliant across 40+ countries (ZATCA, FTA VAT, GST and more), so you can sell confidently in {{country}}.</p>
<p>Worth a quick call to walk through the program?</p>
<p>Best,<br/>DNA Systems — Partnerships</p>`,
  },
  {
    type: "partner",
    name: "Partner — IT providers & VARs",
    subject: "A recurring-revenue ERP for {{company}}'s stack",
    body: `<p>Hi {{company}} team,</p>
<p>You already manage systems for your clients — DNA ERP adds an AI-native, no-code ERP to your stack with <strong>up to 35% recurring commission</strong> and <strong>100% of the implementation &amp; services</strong> you deliver.</p>
<p>We handle the product and back you with training, certification, demo accounts, and a dedicated partner manager. You own the client relationship.</p>
<p>Open to a short intro call?</p>
<p>Best,<br/>DNA Systems — Partnerships</p>`,
  },
  {
    type: "partner",
    name: "Partner — ERP & transformation consultancies",
    subject: "Implement faster, keep 100% of services",
    body: `<p>Hi {{company}} team,</p>
<p>If you implement ERP or run digital transformation projects, DNA ERP lets you deliver faster on a no-code, AI-native platform — and keep <strong>100% of your services</strong> revenue plus <strong>up to 35% recurring</strong> on every license.</p>
<p>No competition from us, free certification for your team, and deal registration to protect your pipeline.</p>
<p>Could we find 15 minutes this week?</p>
<p>Best,<br/>DNA Systems — Partnerships</p>`,
  },
  {
    type: "partner",
    name: "Partner — Regional distributors",
    subject: "Own {{country}} with an AI-native ERP",
    body: `<p>Hi {{company}} team,</p>
<p>We're expanding the DNA Makers network in {{country}} and looking for a distributor to own the territory.</p>
<p>You'd sell a platform already compliant in your market, earn <strong>up to 35% recurring commission</strong> for the life of each account, and keep <strong>100% of implementation &amp; services</strong> — with full training, certification, and marketing support behind you.</p>
<p>Would you be open to exploring it?</p>
<p>Best,<br/>DNA Systems — Partnerships</p>`,
  },
];

/* ------------------------- Follow-up retry pack ------------------------- */
//
// The four rungs of the ladder, in both voices. Three rules shaped this copy:
//
//  1. A retry must not look like the first email. Someone who ignored a
//     designed, image-heavy broadcast will ignore it again — so each rung gets
//     LIGHTER. Rung 1 drops the hero mockup and the badge; rung 2 drops the
//     images and the logo bar entirely and reads like a person typed it, which
//     is also what lands in the inbox rather than Promotions.
//  2. No merge tags in the subject lines. `{{company}}` falls back to "there",
//     which turns "A quicker way to run {{company}}" into "…run there" — and
//     tokens in cold subject lines are a spam signal anyway.
//  3. The ask shrinks as the ladder goes on. The first email asks for a trial;
//     the last one asks for a single word back.

export type RetryRung = "no_open_1" | "no_open_2" | "no_click_1" | "no_click_2";

export interface RetryStarter extends Starter {
  /** Which rung of the ladder this is written for. */
  rung: RetryRung;
  /** One line explaining the intent, shown in the loader. */
  why: string;
}

const WRAP_OPEN = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;margin:0 auto;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #eae7e0;">`;
const WRAP_CLOSE = `</table>`;

const LOGO_BAR = `
  <tr>
    <td style="background:#000000;padding:20px 40px;text-align:center;">
      <img src="https://jlt3a7nn4lo.netlify.app/campaign-logo.png" alt="DNA ERP" style="height:30px;width:auto;display:inline-block;" />
    </td>
  </tr>`;

const tick = (title: string, body: string) => `
        <tr>
          <td style="padding:9px 0;vertical-align:top;width:42px;">
            <div style="width:28px;height:28px;background:#fdeae6;border-radius:8px;text-align:center;line-height:28px;">
              <span style="color:#f3350c;font-size:16px;font-weight:700;line-height:28px;">&#10003;</span>
            </div>
          </td>
          <td style="padding:9px 0 9px 14px;vertical-align:top;">
            <p style="font-size:15px;font-weight:700;color:#0f0f10;margin:0 0 2px 0;">${title}</p>
            <p style="font-size:13px;color:#6a6a6a;margin:0;line-height:1.5;">${body}</p>
          </td>
        </tr>`;

const sig = (team: string, line: string, link: string) => `
  <tr>
    <td style="background:#ffffff;padding:4px 40px 32px 40px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="border-top:1px solid #eeeeee;padding-top:22px;">
            <p style="font-size:14px;color:#1a1a1a;margin:0;font-weight:700;">${team}</p>
            <p style="font-size:13px;color:#6a6a6a;margin:2px 0 10px 0;">${line}</p>
            <p style="font-size:13px;margin:0;"><a href="mailto:inquiry@dna.systems" style="color:#f3350c;text-decoration:none;font-weight:600;">inquiry@dna.systems</a> &nbsp;&middot;&nbsp; <a href="${link}" style="color:#6a6a6a;text-decoration:none;">www.dna.systems</a></p>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;

const FOOTER = `
  <tr>
    <td style="background:#f8f7f3;padding:20px 40px;border-top:1px solid #eae7e0;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="vertical-align:middle;"><a href="https://www.dna.systems" style="color:#f3350c;font-size:13px;font-weight:600;text-decoration:none;">www.dna.systems</a></td>
          <td style="text-align:right;vertical-align:middle;"><p style="font-size:11px;color:#999;margin:0;">&copy; 2026 DNA Systems</p></td>
        </tr>
      </table>
    </td>
  </tr>`;

// Rung 2 is deliberately unbranded: no logo bar, no images, system font stack.
// It is the highest-replying email in any sequence precisely because it does
// not look like marketing.
const plain = (inner: string) => `<div style="max-width:560px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.65;color:#1a1a1a;">
${inner}
</div>`;

export const RETRY_STARTERS: RetryStarter[] = [
  /* ----------------------------- customer ----------------------------- */
  {
    rung: "no_open_1",
    type: "customer",
    name: "Customer · Retry 1 — never opened",
    why: "New subject, no hero image, one small ask. The first subject line didn't land, so nothing about this one repeats it.",
    subject: "How long does your month-end close take?",
    body: `${WRAP_OPEN}${LOGO_BAR}
  <tr>
    <td style="background:#ffffff;padding:34px 40px 8px 40px;">
      <h1 style="font-size:24px;line-height:1.25;font-weight:800;color:#0f0f10;margin:0 0 18px 0;letter-spacing:-0.4px;">Most of that time goes into making two systems agree</h1>
      <p style="font-size:15px;color:#4a4a4a;margin:0 0 14px 0;line-height:1.65;">Hi there,</p>
      <p style="font-size:15px;color:#4a4a4a;margin:0;line-height:1.65;">For most of the companies we speak to the answer is days rather than hours, and the bulk of it is reconciliation: finance exports one number, the stock system says another, and someone spends the first week of the month making the two agree.</p>
    </td>
  </tr>
  <tr>
    <td style="background:#ffffff;padding:18px 40px 4px 40px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">${tick("One set of numbers", "Finance, stock and sales read from the same live data.")}${tick("The close runs itself", "Approvals, invoicing and reporting stop waiting on someone.")}${tick("See it on your own data", "There is a 14-day free trial, so you can look before committing to anything.")}</table>
    </td>
  </tr>
  <tr>
    <td style="background:#ffffff;padding:24px 40px 8px 40px;text-align:center;">
      <a href="https://www.dna.systems" style="display:inline-block;background:#f3350c;color:#ffffff;padding:14px 34px;text-decoration:none;font-weight:700;font-size:15px;border-radius:10px;">See it in two minutes &rarr;</a>
    </td>
  </tr>
  <tr>
    <td style="background:#ffffff;padding:4px 40px 20px 40px;text-align:center;">
      <p style="font-size:13px;color:#6a6a6a;margin:0;line-height:1.6;">Or just reply with your biggest month-end headache — it reaches us directly.</p>
    </td>
  </tr>${sig("The DNA Systems Team", "DNA ERP — all-in-one business platform", "https://www.dna.systems")}${FOOTER}${WRAP_CLOSE}`,
  },
  {
    rung: "no_open_2",
    type: "customer",
    name: "Customer · Retry 2 — last note",
    why: "The break-up. No images, no branding, sixty words. It reads like a person, so it lands in the inbox and gets replies the designed one never will.",
    subject: "Closing the file — or worth a look later?",
    body: plain(`<p style="margin:0 0 14px 0;">Hi there,</p>
<p style="margin:0 0 14px 0;">We have written twice about DNA ERP without hearing back, which usually means the timing is wrong rather than the idea. So this is our last note — we will not keep filling your inbox.</p>
<p style="margin:0 0 14px 0;">If it's worth a look later, everything is on <a href="https://www.dna.systems" style="color:#f3350c;font-weight:600;text-decoration:none;">dna.systems</a>, and replying to this email reaches a person, not a mailbox.</p>
<p style="margin:0 0 14px 0;">Either way, good luck with the rest of the year.</p>
<p style="margin:0;color:#1a1a1a;"><strong>The DNA Systems Team</strong><br/>
<span style="color:#6a6a6a;font-size:13px;">inquiry@dna.systems &middot; dna.systems</span></p>`),
  },
  {
    rung: "no_click_1",
    type: "customer",
    name: "Customer · Nudge 1 — opened, no click",
    why: "They read it and did nothing, so this one drops the pitch and shows the three numbers people actually open an ERP to see.",
    subject: "The three numbers most owners ask us for first",
    body: `${WRAP_OPEN}${LOGO_BAR}
  <tr>
    <td style="background:#ffffff;padding:34px 40px 8px 40px;">
      <h1 style="font-size:24px;line-height:1.25;font-weight:800;color:#0f0f10;margin:0 0 18px 0;letter-spacing:-0.4px;">Three questions DNA ERP usually gets bought to answer</h1>
      <p style="font-size:15px;color:#4a4a4a;margin:0 0 14px 0;line-height:1.65;">Hi there,</p>
      <p style="font-size:15px;color:#4a4a4a;margin:0;line-height:1.65;">Thanks for taking a look at the last one. Rather than repeat the overview, here are the three questions people actually keep the dashboard open for:</p>
    </td>
  </tr>
  <tr>
    <td style="background:#ffffff;padding:18px 40px 4px 40px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">${tick("Where is the cash, right now?", "Receivables, payables and bank position on one screen — not last month's.")}${tick("What is actually in stock?", "Live quantities per location, with what's already committed to orders.")}${tick("Which jobs made money?", "Real cost per project or order, once labour and materials are in.")}</table>
    </td>
  </tr>
  <tr>
    <td style="background:#f8f7f3;padding:20px 40px;">
      <p style="font-size:14px;color:#4a4a4a;margin:0;line-height:1.6;">If any of those three is currently a spreadsheet, that is the part worth seeing first.</p>
    </td>
  </tr>
  <tr>
    <td style="background:#ffffff;padding:24px 40px 8px 40px;text-align:center;">
      <a href="https://www.dna.systems/trial" style="display:inline-block;background:#f3350c;color:#ffffff;padding:14px 34px;text-decoration:none;font-weight:700;font-size:15px;border-radius:10px;">See these on live data &rarr;</a>
    </td>
  </tr>
  <tr>
    <td style="background:#ffffff;padding:6px 40px 20px 40px;text-align:center;">
      <a href="https://www.dna.systems/contact" style="display:inline-block;border:1.5px solid #d9d5cc;color:#0f0f10;padding:11px 28px;text-decoration:none;font-weight:700;font-size:14px;border-radius:10px;">Or have someone walk you through it</a>
    </td>
  </tr>${sig("The DNA Systems Team", "DNA ERP — all-in-one business platform", "https://www.dna.systems")}${FOOTER}${WRAP_CLOSE}`,
  },
  {
    rung: "no_click_2",
    type: "customer",
    name: "Customer · Nudge 2 — opened, no click",
    why: "Last rung. One question, answerable with one word — the smallest ask in the ladder, and the one that gets a reply.",
    subject: "One question, then we will stop",
    body: plain(`<p style="margin:0 0 14px 0;">Hi there,</p>
<p style="margin:0 0 14px 0;">You opened the last couple of emails, so something in there was close, but nothing since. That usually means one of two things.</p>
<p style="margin:0 0 14px 0;">Would you reply with a single word?</p>
<p style="margin:0 0 6px 0;"><strong>Later</strong> — right idea, wrong quarter. We will come back once and leave it there.<br/>
<strong>No</strong> — not a fit. We will close the file today and you will hear nothing more from us.</p>
<p style="margin:14px 0 14px 0;">If it's neither and you'd rather just see it, <a href="https://www.dna.systems/contact" style="color:#f3350c;font-weight:600;text-decoration:none;">pick any 15 minutes here</a>.</p>
<p style="margin:0;color:#1a1a1a;"><strong>The DNA Systems Team</strong><br/>
<span style="color:#6a6a6a;font-size:13px;">inquiry@dna.systems &middot; dna.systems</span></p>`),
  },

  /* ------------------------------ partner ----------------------------- */
  {
    rung: "no_open_1",
    type: "partner",
    name: "Partner · Retry 1 — never opened",
    why: "Leads with the number that decides it for a firm — the margin they keep — instead of the programme name they ignored.",
    subject: "What margin do you keep on an ERP implementation?",
    body: `${WRAP_OPEN}${LOGO_BAR}
  <tr>
    <td style="background:#ffffff;padding:34px 40px 8px 40px;">
      <h1 style="font-size:24px;line-height:1.25;font-weight:800;color:#0f0f10;margin:0 0 18px 0;letter-spacing:-0.4px;">With us it's 100% of services, plus a share of the licence for life</h1>
      <p style="font-size:15px;color:#4a4a4a;margin:0 0 14px 0;line-height:1.65;">Hi there,</p>
      <p style="font-size:15px;color:#4a4a4a;margin:0;line-height:1.65;">Most vendors take a cut of your implementation work, then start selling direct to the client you introduced. The DNA Makers programme is built the other way round.</p>
    </td>
  </tr>
  <tr>
    <td style="background:#ffffff;padding:18px 40px 4px 40px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">${tick("Keep 100% of services", "Every dollar of implementation, customisation and support stays with you.")}${tick("Up to 35% recurring, for life", "On every licence, for as long as the account exists.")}${tick("We never compete with you", "We build the product. The client relationship is yours, permanently.")}</table>
    </td>
  </tr>
  <tr>
    <td style="background:#ffffff;padding:24px 40px 8px 40px;text-align:center;">
      <a href="https://www.dna.systems/become-a-partner" style="display:inline-block;background:#f3350c;color:#ffffff;padding:14px 34px;text-decoration:none;font-weight:700;font-size:15px;border-radius:10px;">See the numbers &rarr;</a>
    </td>
  </tr>
  <tr>
    <td style="background:#ffffff;padding:4px 40px 20px 40px;text-align:center;">
      <p style="font-size:13px;color:#6a6a6a;margin:0;line-height:1.6;">Already compliant in 40+ countries, so you can sell it in {{country}} tomorrow.</p>
    </td>
  </tr>${sig("The DNA Systems Partnerships Team", "DNA ERP — Makers Network", "https://www.dna.systems/become-a-partner")}${FOOTER}${WRAP_CLOSE}`,
  },
  {
    rung: "no_open_2",
    type: "partner",
    name: "Partner · Retry 2 — last note",
    why: "The break-up, partner voice. Plain text, one link, and a door left open — firms change ERP vendor on their own timetable, not yours.",
    subject: "Closing the loop on the Makers programme",
    body: plain(`<p style="margin:0 0 14px 0;">Hi there,</p>
<p style="margin:0 0 14px 0;">We have written twice about the DNA Makers programme without hearing back, so we will assume it is not the right moment and stop there.</p>
<p style="margin:0 0 14px 0;">If your margins get squeezed again at renewal — or a client asks for something your current platform can't do in {{country}} — the terms are on <a href="https://www.dna.systems/become-a-partner" style="color:#f3350c;font-weight:600;text-decoration:none;">dna.systems/become-a-partner</a> and they don't expire.</p>
<p style="margin:0 0 14px 0;">Replying to this reaches our partnerships team directly.</p>
<p style="margin:0;color:#1a1a1a;"><strong>The DNA Systems Partnerships Team</strong><br/>
<span style="color:#6a6a6a;font-size:13px;">inquiry@dna.systems &middot; dna.systems</span></p>`),
  },
  {
    rung: "no_click_1",
    type: "partner",
    name: "Partner · Nudge 1 — opened, no click",
    why: "They read it, so this one removes the decision: two tiers, side by side, with the low-effort one made obvious.",
    subject: "35% recurring, or 15% for just the introduction?",
    body: `${WRAP_OPEN}${LOGO_BAR}
  <tr>
    <td style="background:#ffffff;padding:34px 40px 8px 40px;">
      <h1 style="font-size:24px;line-height:1.25;font-weight:800;color:#0f0f10;margin:0 0 18px 0;letter-spacing:-0.4px;">Two ways in — one needs no technical work at all</h1>
      <p style="font-size:15px;color:#4a4a4a;margin:0 0 14px 0;line-height:1.65;">Hi there,</p>
      <p style="font-size:15px;color:#4a4a4a;margin:0;line-height:1.65;">Thanks for taking a look at the last one. If what stopped you was capacity — no room to implement another platform — the second option below exists for exactly that.</p>
    </td>
  </tr>
  <tr>
    <td style="background:#ffffff;padding:22px 40px 6px 40px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td width="50%" style="padding:0 8px 0 0;vertical-align:top;">
            <div style="border:1.5px solid #f3350c;border-radius:12px;padding:18px;">
              <p style="font-size:11px;font-weight:700;color:#f3350c;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:1px;">Reseller</p>
              <p style="font-size:22px;font-weight:800;color:#0f0f10;margin:0 0 8px 0;">35% recurring</p>
              <p style="font-size:13px;color:#6a6a6a;margin:0;line-height:1.55;">You implement, you support, you keep 100% of that revenue.</p>
            </div>
          </td>
          <td width="50%" style="padding:0 0 0 8px;vertical-align:top;">
            <div style="border:1.5px solid #eae7e0;border-radius:12px;padding:18px;">
              <p style="font-size:11px;font-weight:700;color:#6a6a6a;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:1px;">Referral</p>
              <p style="font-size:22px;font-weight:800;color:#0f0f10;margin:0 0 8px 0;">15% recurring</p>
              <p style="font-size:13px;color:#6a6a6a;margin:0;line-height:1.55;">You make the introduction. We do the rest. Zero technical work.</p>
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="background:#f8f7f3;padding:18px 40px;">
      <p style="font-size:14px;color:#4a4a4a;margin:0;line-height:1.6;">Both are recurring for the life of the account, and both include training, certification and deal registration.</p>
    </td>
  </tr>
  <tr>
    <td style="background:#ffffff;padding:24px 40px 20px 40px;text-align:center;">
      <a href="https://www.dna.systems/become-a-partner" style="display:inline-block;background:#f3350c;color:#ffffff;padding:14px 34px;text-decoration:none;font-weight:700;font-size:15px;border-radius:10px;">Apply to the programme &rarr;</a>
    </td>
  </tr>${sig("The DNA Systems Partnerships Team", "DNA ERP — Makers Network", "https://www.dna.systems/become-a-partner")}${FOOTER}${WRAP_CLOSE}`,
  },
  {
    rung: "no_click_2",
    type: "partner",
    name: "Partner · Nudge 2 — opened, no click",
    why: "Final rung. Gives them an easy no, which is what makes the yes worth having.",
    subject: "Worth fifteen minutes, or shall I stop here?",
    body: plain(`<p style="margin:0 0 14px 0;">Hi there,</p>
<p style="margin:0 0 14px 0;">You opened the last couple of emails about the Makers programme, so the idea probably is not the problem — but a clear no is more useful to us than a guess.</p>
<p style="margin:0 0 6px 0;">One word back is plenty:</p>
<p style="margin:0 0 6px 0;"><strong>Send it</strong> — we will email the commission terms and the certification path, nothing else.<br/>
<strong>No</strong> — we will close the file today.</p>
<p style="margin:14px 0 14px 0;">Or if it's easier to talk it through, <a href="https://www.dna.systems/contact" style="color:#f3350c;font-weight:600;text-decoration:none;">take any 15 minutes here</a>.</p>
<p style="margin:0;color:#1a1a1a;"><strong>The DNA Systems Partnerships Team</strong><br/>
<span style="color:#6a6a6a;font-size:13px;">inquiry@dna.systems &middot; dna.systems</span></p>`),
  },
];
