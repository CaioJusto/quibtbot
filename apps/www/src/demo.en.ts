import type { DemoBot } from "./demo";

export const DEMO_BOTS_EN: DemoBot[] = [
  {
    id: "chief",
    name: "Lume",
    color: "#DBE2F5",
    shape: "onee",
    time: "Yesterday",
    preview: "studio held, launch plan ready",
    routines: [{ name: "Launch pulse", when: "Tuesdays 8am" }],
    screen: {
      host: "linear.app",
      title: "Aurora launch — command board",
      lines: [
        "Orbit Loft confirmed",
        "18 guests on the list",
        "Run-of-show ready",
      ],
    },
    thread: [
      { type: "time", text: "Yesterday 10:18" },
      { type: "user", text: "set up a small breakfast for the Aurora release" },
      {
        type: "bot",
        text: "I mapped the guest list, three venues, and a two-hour run-of-show. I will hold the best option before anything is paid.",
      },
      {
        type: "card",
        lines: [
          { k: "Held", v: "Orbit Loft · Sep 18" },
          { k: "Budget", v: "$6,900 of $8k" },
          { k: "Pending", v: "menu notes from 3 guests" },
        ],
      },
      {
        type: "user",
        text: "use Orbit Loft and keep fifteen minutes for the live demo",
      },
      {
        type: "bot",
        text: "done. the room is held, the demo slot is on the timeline, and the invitations are ready for your review.",
      },
    ],
    reply:
      "added. I will refresh the guest count and keep the launch board current.",
  },
  {
    id: "sales",
    name: "Prisma",
    color: "#5B7FE5",
    shape: "strobi",
    time: "03:26",
    preview: "28 climate teams mapped, 12 briefs ready",
    routines: [
      { name: "Signal map", when: "Every night 1am" },
      { name: "Founder follow-up", when: "Weekdays 8am" },
    ],
    screen: {
      host: "airtable.com",
      title: "Climate ops — signal map",
      lines: ["28 teams mapped", "16 fresh product signals", "12 briefs ready"],
    },
    thread: [
      { type: "time", text: "Yesterday 21:35" },
      {
        type: "user",
        text: "find climate-software teams launching in Latin America and make a short brief for each",
      },
      {
        type: "bot",
        text: "I will trace launches, hiring signals, and founder interviews. nothing gets contacted; you get one concise review board.",
      },
      { type: "meta", text: "Routine created ◷ Signal map" },
      { type: "time", text: "03:26" },
      {
        type: "card",
        lines: [
          { k: "Mapped", v: "28 teams · 16 with fresh signals" },
          { k: "Briefed", v: "12 launch summaries" },
          { k: "Set aside", v: "5 · outside the target region" },
        ],
      },
      {
        type: "bot",
        text: "three teams opened Brazil roles this month. I put those first and linked every source behind the notes.",
      },
    ],
    reply:
      "on it. I will add the new signals and keep the source links beside each brief.",
  },
  {
    id: "inbox",
    name: "Velo",
    color: "#E65C5C",
    shape: "cubee",
    time: "00:24",
    preview: "quiet inbox, 4 replies ready",
    routines: [
      { name: "Dawn sort", when: "Weekdays 6:30am" },
      { name: "Priority pulse", when: "Every 90 min" },
    ],
    screen: {
      host: "mail.google.com",
      title: "Velo — 4 replies ready",
      lines: [
        "34 conversations sorted",
        "17 bundled · 8 answered",
        "Solara logo request needs review",
      ],
    },
    thread: [
      { type: "time", text: "Yesterday 22:48" },
      {
        type: "user",
        text: "clear the inbox, but keep anything about the launch close",
      },
      {
        type: "bot",
        text: "got it. I am grouping receipts and updates, answering simple logistics, and pulling every Aurora thread into one stack.",
      },
      { type: "time", text: "00:24" },
      {
        type: "card",
        lines: [
          { k: "Bundled", v: "17 updates + receipts" },
          { k: "Answered", v: "8 scheduling notes" },
          { k: "Drafted", v: "4 partner replies for review" },
          { k: "Pinned", v: "1 from Bia at Solara · logo question" },
        ],
      },
      {
        type: "bot",
        text: "Bia wants to place the Aurora mark on their launch page. I drafted approval with the current brand-kit link and left it pinned.",
      },
      {
        type: "user",
        text: "send that one and keep the other drafts for morning",
      },
      {
        type: "bot",
        text: "sent. the inbox is quiet, and four drafts are lined up for your morning pass.",
      },
    ],
    reply:
      "done. I will fold it into the next pass and pin anything that needs your judgment.",
  },
  {
    id: "account",
    name: "Nexo",
    color: "#55B6C3",
    shape: "nova",
    time: "Yesterday",
    preview: "Marea brief refreshed, Lia invited",
    routines: [{ name: "Account compass", when: "Every day 9am" }],
    screen: {
      host: "attio.com",
      title: "Marea Foods — store pilot",
      lines: [
        "Tuesday 3:30pm with Lia",
        "Pilot covers 3 stores",
        "Mateo signs off",
      ],
    },
    thread: [
      { type: "time", text: "Yesterday 15:06" },
      {
        type: "bot",
        text: "Marea asked whether the pilot can start in three stores instead of one. I pulled the decision notes from the last call.",
      },
      { type: "meta", text: "Memory updated · Marea Foods" },
      {
        type: "bot",
        text: "saved for next time: Mateo signs off on scope, and Lia owns the rollout calendar.",
      },
      {
        type: "user",
        text: "book a short pilot review with Lia for Tuesday afternoon",
      },
      {
        type: "bot",
        text: "Lia has Tuesday at 3:30pm, with the three-store proposal and last call notes attached.",
      },
    ],
    reply: "saved. I will keep the account brief and decision owners in sync.",
  },
  {
    id: "talent",
    name: "Mosaico",
    color: "#C9CBCF",
    shape: "cloudee",
    time: "Yesterday",
    preview: "8 support leads shortlisted, 3 notes ready",
    routines: [{ name: "Portfolio window", when: "Tue + Thu" }],
    screen: {
      host: "ashbyhq.com",
      title: "Customer support lead — shortlist",
      lines: [
        "52 profiles reviewed",
        "8 rebuilt a QA process",
        "3 intro notes ready",
      ],
    },
    thread: [
      { type: "time", text: "Yesterday 17:12" },
      {
        type: "user",
        text: "look for support leaders who rebuilt quality review while their team was scaling",
      },
      {
        type: "card",
        lines: [
          { k: "Reviewed", v: "52 profiles" },
          { k: "Shortlisted", v: "8 · hands-on QA redesign" },
          { k: "Prepared", v: "3 personal intro notes" },
        ],
      },
      {
        type: "bot",
        text: "the first three documented the process they built, not just the result. I linked those examples beside each note.",
      },
    ],
    reply:
      "I will compare the new profiles against that bar and prepare only the strongest notes.",
  },
  {
    id: "expense",
    name: "Cifra",
    color: "#E69A5C",
    shape: "sunee",
    time: "Yesterday",
    preview: "workshop closed, 11 receipts matched",
    routines: [{ name: "Workshop close", when: "Last Friday" }],
    screen: {
      host: "app.ramp.com",
      title: "Design workshop — close",
      lines: [
        "11 receipts matched",
        "Two studio passes verified",
        "Report ready · $3,180",
      ],
    },
    thread: [
      { type: "time", text: "Yesterday 09:14" },
      { type: "user", text: "wrap the design workshop expenses before lunch" },
      {
        type: "bot",
        text: "I will pair every charge with its receipt, label it by workshop day, and stop on anything ambiguous.",
      },
      { type: "meta", text: "Routine created ◷ Workshop close" },
      { type: "time", text: "Yesterday 11:42" },
      {
        type: "card",
        lines: [
          { k: "Matched", v: "11 receipts" },
          { k: "Total", v: "$3,180 across 2 days" },
          { k: "Checked", v: "2 Atelier Norte day passes" },
        ],
      },
      {
        type: "bot",
        text: "Atelier Norte billed one pass on each workshop day. both match the attendance sheet, so there is no duplicate.",
      },
      {
        type: "user",
        text: "perfect, attach the attendance sheet and close it",
      },
      {
        type: "bot",
        text: "closed. the report, receipts, and attendance sheet are together in the workshop folder.",
      },
    ],
    reply: "recorded. I will keep it with the next workshop close.",
  },
  {
    id: "bugs",
    name: "Faísca",
    color: "#FFC2E9",
    shape: "kirby",
    time: "Monday",
    preview: "CSV issue isolated, fixture attached",
    routines: [{ name: "Signal scan", when: "Every 2h" }],
    screen: {
      host: "sentry.io",
      title: "CSV export — accented names",
      lines: [
        "7 reports grouped",
        "3 environments reproduced",
        "Windows locale isolated",
      ],
    },
    thread: [
      { type: "time", text: "Monday 08:44" },
      {
        type: "user",
        text: "figure out why some exported names lose their accents",
      },
      {
        type: "card",
        lines: [
          { k: "Grouped", v: "7 reports · one signature" },
          { k: "Reproduced", v: "3 Windows locales" },
          { k: "Isolated", v: "legacy CSV encoding path" },
        ],
      },
      {
        type: "bot",
        text: "the fallback exporter uses the system code page on Windows. I attached a failing fixture and the smallest reproduction.",
      },
    ],
    reply:
      "I will test the new case, attach the evidence, and update the issue with the result.",
  },
];
