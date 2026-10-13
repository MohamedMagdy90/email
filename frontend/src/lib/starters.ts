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
