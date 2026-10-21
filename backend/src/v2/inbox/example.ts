// Example inbox, shown before Instantly is connected. The people are made up,
// but what happens to each reply comes from decideReply() with YOUR saved
// settings, so changing the Agent rules changes this preview.
import { decideReply, REPLY_CATEGORIES, type AgentSettings } from "../agent-settings";
import { latestReply } from "./classify";

interface Ex {
  id: string;
  name: string;
  email: string;
  title: string;
  company: string;
  city: string;
  country: string;
  industry: string;
  mailbox: string;
  minutesAgo: number;
  subject: string;
  first: string;
  reply: string;
  replySubject?: string;
  autoReply?: boolean;
  category: string;
  confidence: number;
  source: "ai" | "rules";
  summary: string;
  answer?: string;
  research: string[];
}

const EXAMPLES = (first: string, sign: string): Ex[] => [
  {
    id: "ex-1",
    name: "Nasser Al-Kuwari",
    email: "nasser@alrayyan-bm.qa",
    title: "Procurement Director",
    company: "Al Rayyan Building Materials",
    city: "Doha",
    country: "Qatar",
    industry: "Building materials distribution",
    mailbox: "mohamed@dnaerp-mail.com",
    minutesAgo: 9,
    subject: "stock across your yards",
    first: `Hi Nasser,\n\nSaw that Al Rayyan opened a third yard in Industrial Area this year. Keeping stock and invoices in step across sites is usually where spreadsheets start to hurt.\n\nWould it help to see how DNA keeps every yard's stock live in one place?\n\n${sign}`,
    reply: "This is timely, we are replacing our accounting system next quarter. Can we do a call on Sunday or Monday? I'd like our finance manager to join.",
    category: "interested",
    confidence: 0.93,
    source: "ai",
    summary: "Replacing their accounting system next quarter and wants a call early next week.",
    answer: `Hi Nasser,\n\nGreat timing, and happy to include your finance manager.\n\nSunday at 11:00 or Monday at 14:00 Doha time would work on my side. Which suits you both?\n\n${sign}`,
    research: ["Distributes cement, steel and blocks to contractors from three yards.", "Opened a third yard in Industrial Area in 2026."],
  },
  {
    id: "ex-2",
    name: "Fatima Al-Harthy",
    email: "fatima.harthy@muscatmedical.om",
    title: "Finance Manager",
    company: "Muscat Medical Supplies LLC",
    city: "Muscat",
    country: "Oman",
    industry: "Medical supplies",
    mailbox: "mohamed@trydna-erp.com",
    minutesAgo: 140,
    subject: "two branches, one set of books",
    first: `Hi Fatima,\n\nMuscat Medical now runs branches in Muscat and Sohar. Closing the month across two branches is often the slowest part of a finance manager's week.\n\nIs consolidating the two still a manual job for your team?\n\n${sign}`,
    reply: "Yes it is. Does DNA handle VAT returns for Oman, and can we keep separate books for the two branches but report together? Also roughly what does it cost for 10 users?",
    category: "question",
    confidence: 0.88,
    source: "ai",
    summary: "Asks about Oman VAT, branch books with joint reporting, and price for 10 users.",
    answer: `Hi Fatima,\n\nYes on both: DNA is VAT ready across the GCC, Oman included, and each branch can keep its own books while you report on them together.\n\nOn price for 10 users, I'd rather confirm the exact figure than guess. I'll send it over today.\n\nWould a 20-minute walkthrough of the branch setup be useful?\n\n${sign}`,
    research: ["Medical consumables distributor with branches in Muscat and Sohar."],
  },
  {
    id: "ex-3",
    name: "Saeed Al-Ghamdi",
    email: "saeed@ghamdi-autoparts.sa",
    title: "Owner",
    company: "Al-Ghamdi Auto Parts",
    city: "Jeddah",
    country: "Saudi Arabia",
    industry: "Auto parts retail",
    mailbox: "mohamed@dnaerp-mail.com",
    minutesAgo: 190,
    subject: "ZATCA phase two",
    first: `Hi Saeed,\n\nWith ZATCA phase two rolling out to more businesses, a lot of parts retailers in Jeddah are switching from desktop invoicing.\n\nAre your four shops already sending invoices through an integrated system?\n\n${sign}`,
    reply: "We're comparing you with two others. If we sign for 3 years can you do 30% off and waive the implementation fee?",
    category: "negotiation",
    confidence: 0.9,
    source: "ai",
    summary: "Comparing vendors; asks for 30% off and no implementation fee on a 3-year deal.",
    answer: `Hi Saeed,\n\nThanks for being upfront that you're comparing options.\n\nImplementation and data migration support are included with DNA. On contract length and pricing, let's go through it properly on a short call so you get exact numbers. Would Tuesday work?\n\n${sign}`,
    research: ["Four auto parts shops in Jeddah.", "Invoices from a desktop package."],
  },
  {
    id: "ex-4",
    name: "عبدالله الدوسري",
    email: "a.aldossary@dossary-group.sa",
    title: "المدير المالي",
    company: "مجموعة الدوسري التجارية",
    city: "Riyadh",
    country: "Saudi Arabia",
    industry: "Trading",
    mailbox: "mohamed@trydna-erp.com",
    minutesAgo: 55,
    subject: "الفوترة الإلكترونية",
    first: `Hi Abdullah,\n\nNoticed Dossary Group is hiring two accountants in Riyadh. Teams growing that fast usually feel invoicing and VAT first.\n\nWould it help to see how DNA handles ZATCA e-invoicing in Arabic and English?\n\n${sign}`,
    reply: "السلام عليكم، هل النظام يدعم الفوترة الإلكترونية لهيئة الزكاة (المرحلة الثانية)؟ وكم يستغرق التطبيق تقريباً؟",
    category: "question",
    confidence: 0.62,
    source: "ai",
    summary: "Asks (in Arabic) about ZATCA phase two support and implementation time.",
    answer: `وعليكم السلام أستاذ عبدالله،\n\nنعم، نظام DNA جاهز للفوترة الإلكترونية وفق متطلبات هيئة الزكاة والضريبة والجمارك، وواجهته متاحة بالعربية والإنجليزية.\n\nأما مدة التطبيق فتعتمد على حجم البيانات وعدد الفروع، وسأؤكد لك تقديراً دقيقاً بعد معرفة التفاصيل. هل يناسبك اتصال قصير هذا الأسبوع؟\n\n${sign}`,
    research: ["Trading group in Riyadh, hiring two accountants."],
  },
  {
    id: "ex-5",
    name: "Omar Haddad",
    email: "omar@haddadtrading.jo",
    title: "General Manager",
    company: "Haddad Trading Est.",
    city: "Amman",
    country: "Jordan",
    industry: "FMCG distribution",
    mailbox: "mohamed@dnaerp-mail.com",
    minutesAgo: 60 * 26,
    subject: "year-end in Amman",
    first: `Hi Omar,\n\nHaddad Trading supplies over 400 shops across Amman. At that size, stock counts and year-end tend to take over December.\n\nIs that the case for your team this year?\n\n${sign}`,
    reply: "Thanks. We're in the middle of our year-end close, please reach out again in January.",
    category: "not_now",
    confidence: 0.91,
    source: "ai",
    summary: "Busy with year-end; asks to be contacted again in January.",
    answer: `Thanks Omar, understood. Good luck with the close.\n\nI'll check back in the second week of January.\n\n${sign}`,
    research: ["FMCG distributor serving 400+ shops in Amman."],
  },
  {
    id: "ex-6",
    name: "Priya Nair",
    email: "priya@gulfcoastlog.ae",
    title: "Office Manager",
    company: "Gulf Coast Logistics",
    city: "Dubai",
    country: "United Arab Emirates",
    industry: "Freight forwarding",
    mailbox: "mohamed@trydna-erp.com",
    minutesAgo: 60 * 30,
    subject: "billing per shipment",
    first: `Hi Priya,\n\nGulf Coast Logistics bills per shipment across sea and air. Matching those invoices to costs is often still done by hand.\n\nIs that something your team handles in spreadsheets today?\n\n${sign}`,
    reply: "I'm not the right person for this, our CFO Rashid Khan (rashid.khan@gulfcoastlog.ae) handles systems.",
    category: "referral",
    confidence: 0.86,
    source: "ai",
    summary: "Points to the CFO, Rashid Khan, as the right person.",
    answer: `Thank you Priya, that's very helpful.\n\nWould you mind introducing me to Rashid with a quick reply-all? A short note from you goes a long way.\n\n${sign}`,
    research: ["Sea and air freight forwarder in Jebel Ali."],
  },
  {
    id: "ex-7",
    name: "Desert Bloom Flowers",
    email: "info@desertbloom.qa",
    title: "",
    company: "Desert Bloom Flowers",
    city: "Doha",
    country: "Qatar",
    industry: "Retail",
    mailbox: "mohamed@dnaerp-mail.com",
    minutesAgo: 60 * 6,
    subject: "orders across your shops",
    first: `Hi there,\n\nDesert Bloom runs five flower shops in Doha. Keeping orders and stock in sync across shops is hard on paper.\n\nIs that a problem for you today?\n\n${sign}`,
    reply: "Please remove us from your list.",
    category: "unsubscribe",
    confidence: 0.94,
    source: "rules",
    summary: "Asks to stop receiving emails.",
    research: [],
  },
  {
    id: "ex-8",
    name: "Layla Mansour",
    email: "layla.mansour@bhg.bh",
    title: "HR Director",
    company: "Bahrain Hospitality Group",
    city: "Manama",
    country: "Bahrain",
    industry: "Hospitality",
    mailbox: "mohamed@trydna-erp.com",
    minutesAgo: 60 * 20,
    subject: "payroll across six hotels",
    replySubject: "Automatic reply: payroll across six hotels",
    autoReply: true,
    first: `Hi Layla,\n\nBahrain Hospitality Group runs payroll for six hotels. Shift-based pay and end-of-service calculations are where most HR teams lose days.\n\nIs payroll still split across systems for you?\n\n${sign}`,
    reply: "Thank you for your email. I am on annual leave until 9 November with limited access to email. For urgent matters please contact hr@bhg.bh.",
    category: "out_of_office",
    confidence: 0.95,
    source: "rules",
    summary: "Auto-reply: they are away.",
    research: [],
  },
];

export function exampleInbox(s: AgentSettings, now = new Date()) {
  const first = (s.senderName || "Mohamed").split(/\s+/)[0];
  const sign = s.signature.trim() || first;
  const iso = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
  const threads: any[] = [];
  const details: Record<string, any> = {};

  for (const ex of EXAMPLES(first, sign)) {
    const cat = REPLY_CATEGORIES.find((c) => c.id === ex.category)!;
    const d = decideReply(s, { category: ex.category, confidence: ex.confidence, autoRepliesInThread: 0 });
    const outAt = iso(ex.minutesAgo + 60 * 24 * 2 + 37);
    const inAt = iso(ex.minutesAgo);
    const avgDelay = d.delayMinutes ? (d.delayMinutes[0] + d.delayMinutes[1]) / 2 : 0;
    const dueAt = new Date(new Date(inAt).getTime() + avgDelay * 60_000).toISOString();
    const sentAlready = d.action === "send" && new Date(dueAt).getTime() <= now.getTime();

    let aiStatus = "skipped";
    let draft: string | null = null;
    let due: string | null = null;
    if (d.action === "send") {
      aiStatus = sentAlready ? "replied" : "scheduled";
      draft = sentAlready ? null : ex.answer || null;
      due = sentAlready ? null : dueAt;
    } else if (d.action === "draft") {
      aiStatus = "drafted";
      draft = ex.answer || null;
    } else if (d.action === "handoff") {
      aiStatus = "needs_human";
      draft = cat.kind === "reply" ? ex.answer || null : null;
    }

    const messages: any[] = [
      {
        id: `${ex.id}-out`,
        direction: "out",
        from: ex.mailbox,
        to: ex.email,
        subject: ex.subject,
        text: ex.first,
        replyText: ex.first,
        hasQuote: false,
        sentAt: outAt,
        isAutoReply: false,
        step: "1",
        classification: null,
        confidence: null,
        summary: null,
        aiStatus: null,
        aiReason: null,
        aiDraft: null,
        aiSource: null,
        replyDueAt: null,
        sentBy: "campaign",
        meta: {},
      },
      {
        id: `${ex.id}-in`,
        direction: "in",
        from: ex.email,
        to: ex.mailbox,
        subject: ex.replySubject || `Re: ${ex.subject}`,
        text: ex.reply,
        replyText: latestReply(ex.reply),
        hasQuote: false,
        sentAt: inAt,
        isAutoReply: !!ex.autoReply,
        step: null,
        classification: ex.category,
        confidence: ex.confidence,
        summary: ex.summary,
        aiStatus,
        aiReason: sentAlready ? "The agent replied." : d.reason,
        aiDraft: draft,
        aiSource: ex.source,
        replyDueAt: due,
        sentBy: null,
        meta: { language: /[\u0600-\u06FF]/.test(ex.reply) ? "ar" : "en" },
      },
    ];
    if (sentAlready && ex.answer) {
      messages.push({
        ...messages[0],
        id: `${ex.id}-ans`,
        subject: `Re: ${ex.subject}`,
        text: ex.answer,
        replyText: ex.answer,
        sentAt: dueAt,
        step: null,
        sentBy: "agent",
      });
    }

    const status =
      aiStatus === "needs_human" || aiStatus === "drafted"
        ? "needs_human"
        : aiStatus === "scheduled"
          ? "open"
          : ["unsubscribe", "bounce", "not_interested"].includes(ex.category) && aiStatus === "skipped"
            ? "closed"
            : "handled";
    const last = messages[messages.length - 1];
    const inbound = messages[1];
    const pending =
      aiStatus === "needs_human" || aiStatus === "drafted" || aiStatus === "scheduled"
        ? { kind: aiStatus, dueAt: due, reason: inbound.aiReason, messageId: inbound.id }
        : null;
    const thread = {
      id: ex.id,
      leadEmail: ex.email,
      leadName: ex.name,
      company: ex.company,
      subject: ex.subject,
      eaccount: ex.mailbox,
      lastMessageAt: last.sentAt,
      lastDirection: last.direction,
      lastPreview: last.replyText.replace(/\s+/g, " ").slice(0, 200),
      unread: last.direction === "in" && ex.minutesAgo < 60 * 8 && status !== "closed",
      status,
      classification: ex.category,
      aiPaused: false,
      autoReplies: sentAlready ? 1 : 0,
      campaignId: "example",
      pending,
    };
    threads.push(thread);

    const events = [
      { id: `${ex.id}-e1`, kind: "reply", level: "info", message: `New reply from ${ex.name}.`, created_at: inAt },
      {
        id: `${ex.id}-e2`,
        kind: aiStatus === "replied" ? "send" : aiStatus === "skipped" ? "reply" : "write",
        level: aiStatus === "needs_human" ? "warn" : aiStatus === "replied" ? "success" : "info",
        message:
          aiStatus === "replied"
            ? `Replied to ${ex.name} from ${ex.mailbox}.`
            : aiStatus === "scheduled"
              ? `Wrote a reply to ${ex.name}; it goes out ${due!.slice(11, 16)} UTC.`
              : `${cat.label} from ${ex.name}: ${d.reason}`,
        created_at: sentAlready ? dueAt : inAt,
      },
    ].reverse();

    details[ex.id] = {
      thread,
      messages,
      lead: {
        name: ex.name,
        email: ex.email,
        title: ex.title || null,
        linkedin: null,
        company: ex.company,
        website: `https://${ex.email.split("@")[1]}`,
        country: ex.country,
        city: ex.city,
        industry: ex.industry,
        phone: null,
        stage: { interested: "interested", negotiation: "interested", unsubscribe: "unsubscribed", out_of_office: "sent" }[ex.category] || "replied",
        fitScore: 70 + ((ex.id.charCodeAt(3) * 7) % 25),
        research: ex.research,
        source: "campaign",
      },
      campaign: { id: "example", name: "Gulf distributors — Q4", kind: "customer", status: "active" },
      mailbox: { email: ex.mailbox, stage: "active", dailyLimit: 30, vendor: ex.mailbox.includes("trydna") ? "mailforge" : "zapmail" },
      events,
    };
  }

  threads.sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)));
  const counts = {
    active: threads.filter((t) => t.status !== "closed").length,
    needs_human: threads.filter((t) => t.status === "needs_human").length,
    scheduled: threads.filter((t) => t.pending?.kind === "scheduled").length,
    unread: threads.filter((t) => t.unread).length,
    closed: threads.filter((t) => t.status === "closed").length,
    all: threads.length,
  };
  return { example: true, threads, counts, details };
}
