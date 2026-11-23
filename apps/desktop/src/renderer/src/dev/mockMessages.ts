/**
 * Dev-only: seed conversations for the mock gateway. Appu's is weeks long (separators, paging older messages in as
 * you scroll up) and ends on the rich invoice turn that exercises every part type; Ledger has a short one and a
 * Telegram chat of its own.
 */
import type { ComputerAction, Message, Part } from '@appubot/protocol';
import type { MockOptions } from './mockData';
import { APPU_WS, DAY, FILM_IDS, FILM_PIXEL_CHAT, HOUR, IDS, MIN, ago } from './mockIds';
import { frameImage } from './mockFrame';

type ToolCallPart = Extract<Part, { type: 'tool_call' }>;

function msg(id: string, threadId: string, role: Message['role'], at: number, parts: Part[], extra: Partial<Message> = {}): Message {
  return { id, threadId, role, parts, status: 'complete', via: 'desktop', createdAt: at, updatedAt: at, ...extra };
}
const text = (t: string): Part => ({ type: 'text', text: t });

/* ---------- main thread content ---------- */
const OLD_CONFIG = `INVOICE_PREFIX = "INV"
NEXT_NUMBER = 41
CURRENCY = "INR"
GST_RATE = 0.18
DUE_DAYS = 30
TEMPLATE = "templates/classic.html"
FOOTER = "Thank you for your business!"
BANK = "HDFC Bank · A/C 50100123456789"
`;
const NEW_CONFIG = `INVOICE_PREFIX = "INV"
NEXT_NUMBER = 42
CURRENCY = "INR"
GST_RATE = 0.18
DUE_DAYS = 15
TEMPLATE = "templates/classic-gst.html"
FOOTER = "Thank you for your business! Pay via UPI or bank transfer."
BANK = "HDFC Bank · A/C 50100123456789"
`;
const TERMINAL = `$ python3 make_invoice.py --client "Acme Corp"
Loading client profile: clients/acme.json
Rendering templates/classic-gst.html …
  • line items: 1
  • subtotal:   ₹1,20,000.00
  • GST (18%):  ₹21,600.00
  • total:      ₹1,41,600.00
Wrote Invoice-Acme-0042.pdf (48.2 KB)
Done in 2.4s`;
const ACME_JSON = `{
  "name": "Acme Corp",
  "gstin": "29ABCDE1234F1Z5",
  "address": "4th Floor, Prestige Tech Park, Bengaluru 560103",
  "billingEmail": "accounts@acme.com",
  "currency": "INR"
}`;

const FENCE = '```';
const ANSWER_MD = `## Invoice ready: Acme Corp - September retainer

I generated **INV-0042** from your usual template and double-checked the totals in Numbers.

- Billed to **Acme Corp**, Bengaluru (GSTIN \`29ABCDE1234F1Z5\`)
- Due date: **27 Oct 2026** (net 15, updated in \`invoice_config.py\`)
- Saved in your workspace as \`Invoice-Acme-0042.pdf\`

| Item | Qty | Rate | Amount |
| --- | ---: | ---: | ---: |
| Retainer - September 2026 | 1 | ₹1,20,000 | ₹1,20,000 |
| GST @ 18% | | | ₹21,600 |
| **Total** | | | **₹1,41,600** |

If you want to regenerate it later, this is what the script does under the hood:

${FENCE}python
from invoices import build_invoice

build_invoice(
    client="Acme Corp",
    items=[("Retainer - September 2026", 1, 120_000)],
    gst_rate=0.18,
    number="INV-0042",
)
${FENCE}`;

/** Computer actions the main thread performed (frames are generated after hello). */
export interface SeedAction { frameId: string; variant: number; ts: number; action: ComputerAction; summary: string }

const AGENT_START = ago(24 * MIN) + 5_000;

export function mainActions(): SeedAction[] {
  const t = AGENT_START + 18_000;
  return [
    { frameId: 'frame_a1', variant: 1, ts: t + 1_500, action: { type: 'open_app', app: 'Numbers' }, summary: 'Opened Numbers' },
    { frameId: 'frame_a2', variant: 2, ts: t + 9_000, action: { type: 'focus_window', app: 'Numbers', detail: 'Invoices.numbers' }, summary: 'Focused “Invoices.numbers”' },
    { frameId: IDS.computerFrame, variant: 3, ts: t + 21_000, action: { type: 'click', x: 412, y: 88 }, summary: 'Clicked the “Invoices” sheet tab' },
    { frameId: 'frame_a4', variant: 4, ts: t + 38_000, action: { type: 'screenshot' }, summary: 'Checked the new INV-0042 row' },
  ];
}

function mainThread(opts: MockOptions): Message[] {
  const th = IDS.main;
  const t0 = AGENT_START;
  const read: ToolCallPart = {
    type: 'tool_call', toolCallId: 'tc_read', title: 'Read clients/acme.json', kind: 'read', status: 'completed',
    content: [{ type: 'text', text: ACME_JSON }], locations: [{ path: `${APPU_WS}/clients/acme.json` }],
    rawInput: { file_path: `${APPU_WS}/clients/acme.json` }, startedAt: t0 + 1_000, endedAt: t0 + 2_200,
  };
  const edit: ToolCallPart = {
    type: 'tool_call', toolCallId: 'tc_edit', title: 'Edit invoice_config.py', kind: 'edit', status: 'completed',
    content: [{ type: 'diff', path: `${APPU_WS}/invoice_config.py`, oldText: OLD_CONFIG, newText: NEW_CONFIG }],
    locations: [{ path: `${APPU_WS}/invoice_config.py`, line: 2 }], startedAt: t0 + 3_000, endedAt: t0 + 4_100,
  };
  const exec: ToolCallPart = {
    type: 'tool_call', toolCallId: 'tc_exec', title: 'python3 make_invoice.py --client "Acme Corp"', kind: 'execute', status: 'completed',
    content: [{ type: 'terminal', terminalId: 'term_1', output: TERMINAL, exitCode: 0 }], locations: [],
    rawInput: { command: 'python3 make_invoice.py --client "Acme Corp"' }, startedAt: t0 + 6_000, endedAt: t0 + 14_000,
  };
  const computer: ToolCallPart = {
    type: 'tool_call', toolCallId: 'tc_computer', title: 'Check the invoice row in Numbers', kind: 'computer', status: 'completed',
    content: [], locations: [], rawInput: { action: 'click', x: 412, y: 88 },
    computer: { action: { type: 'click', x: 412, y: 88 }, frameId: IDS.computerFrame },
    startedAt: t0 + 18_000, endedAt: t0 + 58_000,
  };
  const agentEnd = t0 + 62_000;

  const final: Part[] = opts.approval
    ? [
        text('On it - the templates live in `templates/` and `npm run build` regenerates all of them. The old output has to be cleared first so the new GST line isn\'t cached.'),
        {
          type: 'tool_call', toolCallId: IDS.permissionToolCall, title: 'Run `rm -rf build && npm run build`', kind: 'execute', status: 'pending',
          content: [], locations: [], rawInput: { command: 'rm -rf build && npm run build' }, startedAt: ago(90_000),
        },
        { type: 'system', level: 'warning', text: 'This command deletes the `build/` folder. Waiting for your approval.' },
      ]
    : opts.working ? [
        text('On it - rebuilding the templates now.'),
        {
          type: 'tool_call', toolCallId: 'tc_working', title: 'Run `npm run build`', kind: 'execute', status: 'in_progress',
          content: [], locations: [], rawInput: { command: 'npm run build' }, startedAt: ago(20_000),
        },
      ]
    : [
        text('Done - all 6 invoice templates were rebuilt and now include the GST line. I left the old PDFs untouched.'),
        { type: 'system', level: 'warning', text: 'Build finished with 2 warnings: unused font `Inter-Light.ttf` in templates/minimal.html.' },
      ];

  return [
    msg('m_main_1', th, 'user', ago(24 * MIN), [text('Make an invoice for Acme Corp for the September retainer - ₹1,20,000 plus 18% GST. Use the usual template.')]),
    msg('m_main_2', th, 'agent', t0, [
      { type: 'thought', text: 'The user wants an invoice PDF for Acme Corp. I should read the client profile, bump the invoice number and due date in the config, run the generator script, and then eyeball the row in Numbers before sharing the file.' },
      read, edit, exec, computer,
      text(ANSWER_MD),
      { type: 'file', file: { id: 'f_1', name: 'Invoice-Acme-0042.pdf', mimeType: 'application/pdf', size: 48213, url: '/files/f_1', path: `${APPU_WS}/Invoice-Acme-0042.pdf` } },
      {
        type: 'plan', entries: [
          { content: 'Generate the Acme Corp invoice PDF', priority: 'high', status: 'completed' },
          { content: 'Verify totals in Numbers', priority: 'medium', status: 'in_progress' },
          { content: 'Email the invoice to accounts@acme.com', priority: 'low', status: 'pending' },
        ],
      },
      { type: 'question', questionId: IDS.question, question: 'Should I email it to accounts@acme.com (CC Priya), or just keep it in the workspace?', options: ['Email it', 'Just save it'] },
    ], { updatedAt: agentEnd }),
    msg('m_main_3', th, 'user', ago(3 * MIN), [text('Looks good. Also rebuild the invoice templates so the new GST line shows up everywhere.')]),
    msg('m_main_4', th, 'agent', ago(3 * MIN) + 4_000, final, { status: opts.approval || opts.working ? 'streaming' : 'complete', updatedAt: ago(90_000) }),
    ...(opts.forms ? [
      msg('m_main_5', th, 'user', ago(2 * MIN), [text('Book the Goa trip for the offsite, and file the GST return on the portal.')]),
      msg('m_main_6', th, 'agent', ago(2 * MIN) + 3_000, [
        text('Happy to. A few details first:'),
        {
          type: 'question', questionId: 'q_mock_form', question: 'Details for the Goa offsite', options: [],
          form: {
            kind: 'form', submit: 'Book it', fields: [
              { id: 'check_in', label: 'Check-in', type: 'date', required: true, options: [], value: '2026-12-04' },
              { id: 'arrive', label: 'Arriving at', type: 'time', required: false, options: [], value: '14:30' },
              { id: 'nights', label: 'Nights', type: 'number', required: true, options: [], value: '3' },
              { id: 'room', label: 'Room', type: 'choice', required: true, options: ['Standard', 'Sea view', 'Suite'] },
              { id: 'extras', label: 'Extras', type: 'multichoice', required: false, options: ['Airport pickup', 'Breakfast', 'Late checkout'] },
              { id: 'refundable', label: 'Refundable only', type: 'toggle', required: false, options: [] },
              { id: 'budget_fit', label: 'How firm is the budget?', type: 'rating', required: false, options: [], max: 5, hint: '1 flexible, 5 fixed' },
              { id: 'policy', label: 'Travel policy (PDF)', type: 'file', required: false, options: [], accept: ['pdf'] },
              { id: 'notes', label: 'Anything else', type: 'longtext', required: false, options: [], placeholder: 'Dietary needs, who shares a room…' },
            ],
          },
        },
        {
          type: 'question', questionId: 'q_mock_code', question: 'The GST portal sent a code to your phone', options: [],
          form: {
            kind: 'form', submit: 'Send code',
            fields: [{ id: 'otp', label: 'One-time code', type: 'code', required: true, options: [], max: 6, hint: 'It runs out in a few minutes.' }],
          },
        },
        {
          type: 'question', questionId: 'q_mock_app', question: 'Appu needs Google Calendar', options: [],
          form: {
            kind: 'app', fields: [],
            app: { slug: 'googlecalendar', name: 'Google Calendar', logo: 'https://logos.composio.dev/api/googlecalendar', reason: 'To put the offsite on everyone’s calendar.', state: 'connect' },
          },
        },
        {
          type: 'question', questionId: 'q_mock_telegram', question: 'Appu wants a Telegram bot of its own', options: [],
          form: {
            kind: 'telegram',
            fields: [{ id: 'token', label: 'Bot token', type: 'secret', required: true, options: [], placeholder: '123456789:AAH…', hint: 'From @BotFather on Telegram.' }],
            telegram: { botName: 'Appu', reason: 'So you can send me receipts from your phone while travelling.' },
          },
        },
        {
          type: 'question', questionId: 'q_mock_routine', question: 'Appu wants to set up a routine: Morning expense check (every weekday at 09:00)', options: ['Allow', 'Don’t allow'],
          form: {
            kind: 'routine',
            fields: [
              { id: 'name', label: 'Name', type: 'text', required: true, options: [], value: 'Morning expense check' },
              { id: 'repeat', label: 'Repeat', type: 'choice', required: true, options: ['Every hour', 'Every day', 'Weekdays', 'Certain days', 'Monthly'], value: 'Weekdays' },
              { id: 'time', label: 'At', type: 'time', required: true, options: [], value: '09:00' },
              { id: 'days', label: 'On', type: 'multichoice', required: false, options: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], value: 'Mon,Tue,Wed,Thu,Fri', hint: 'For “Certain days”.' },
              { id: 'day', label: 'Day of the month', type: 'number', required: false, options: [], hint: 'For “Monthly”: 1 to 31.' },
              { id: 'results', label: 'Results', type: 'choice', required: true, options: ['Notify me when done', 'Keep them in the chat'], value: 'Notify me when done' },
            ],
            routine: { prompt: 'Go through yesterday’s receipts in the inbox folder, add them to the expenses sheet and tell me anything over ₹5,000.', schedule: '0 9 * * 1-5', action: 'create', changes: [] },
          },
        },
        {
          type: 'question', questionId: 'q_mock_routine_change', question: 'Appu wants to change the routine Weekly digest:\n\n• When: every Thursday at 17:00 (was every Friday at 18:00)', options: ['Allow', 'Don’t allow'],
          form: {
            kind: 'routine',
            fields: [
              { id: 'name', label: 'Name', type: 'text', required: true, options: [], value: 'Weekly digest' },
              { id: 'repeat', label: 'Repeat', type: 'choice', required: true, options: ['Every hour', 'Every day', 'Weekdays', 'Certain days', 'Monthly'], value: 'Certain days' },
              { id: 'time', label: 'At', type: 'time', required: true, options: [], value: '17:00' },
              { id: 'days', label: 'On', type: 'multichoice', required: false, options: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], value: 'Thu', hint: 'For “Certain days”.' },
              { id: 'day', label: 'Day of the month', type: 'number', required: false, options: [], hint: 'For “Monthly”: 1 to 31.' },
              { id: 'results', label: 'Results', type: 'choice', required: true, options: ['Notify me when done', 'Keep them in the chat'], value: 'Notify me when done' },
            ],
            routine: {
              prompt: 'Summarise the week’s spending in five lines.', schedule: '0 17 * * 4', action: 'update',
              changes: [
                { label: 'It will send', value: 'Summarise the week’s spending in five lines.', was: 'Summarise the week.', grants: false },
                { label: 'When', value: 'Every Thursday at 17:00', was: 'Every Friday at 18:00', grants: false },
              ],
            },
          },
        },
        {
          type: 'question', questionId: 'q_mock_bot_new', question: 'Appu wants to make a new bot, Scout.', options: ['Allow', 'Don’t allow'],
          form: {
            kind: 'bot',
            fields: [{ id: 'name', label: 'Name', type: 'text', required: true, options: [], value: 'Scout' }],
            bot: {
              action: 'create', name: 'Scout', color: '#2E8EFF', shape: 'hex', agent: 'Claude Code', computerUse: true, self: false, changes: [],
              job: 'Finds and qualifies leads for the offsite venue search',
              instructions: 'Search venues near Goa for 40 people in early December. Shortlist five with prices, write them to leads.md and tell Appu when done. Never book anything.',
            },
          },
        },
        {
          type: 'question', questionId: 'q_mock_bot_change', question: 'Appu wants to change itself:\n\n• Permissions: Full access (was Approve for me)\n• Apps: Gmail', options: ['Allow', 'Don’t allow'],
          form: {
            kind: 'bot', fields: [],
            bot: {
              action: 'update', name: 'Appu', color: '#FF7A1F', shape: 'circle', self: true,
              changes: [
                { label: 'Permissions', value: 'Full access: runs everything without asking', was: 'Approve for me', grants: true },
                { label: 'Apps', value: 'Gmail', grants: true },
                { label: 'Job', value: 'Books travel and files the GST returns', was: 'Books travel', grants: false },
              ],
            },
          },
        },
        {
          type: 'question', questionId: 'q_mock_vault', question: 'Appu needs a login: “GST portal”', options: [],
          form: {
            kind: 'vault',
            fields: [
              { id: 'name', label: 'Name in the Vault', type: 'text', required: true, options: [], value: 'GST portal' },
              { id: 'site', label: 'Website or app', type: 'text', required: false, options: [], value: 'gst.gov.in' },
              { id: 'username', label: 'Username or email', type: 'text', required: false, options: [] },
              { id: 'password', label: 'Password', type: 'secret', required: true, options: [] },
            ],
            vault: { kind: 'login', reason: 'To sign in and file this month’s GSTR-3B.', saved: [{ id: 'vlt_mock_1', name: 'Income tax portal', detail: 'AAACA1234B · incometax.gov.in' }] },
          },
        },
      ], { status: 'streaming', updatedAt: ago(MIN) }),
    ] : []),
  ];
}

/* ---------- a turn shaped like the Synara transcript we compare against (4 days ago) ---------- */
function reviewTurn(th: string): Message[] {
  const t0 = ago(4 * DAY - 2 * HOUR);
  const run = (id: string, command: string, at: number, ms: number, failed = false): ToolCallPart => ({
    type: 'tool_call', toolCallId: id, title: command, kind: 'execute', status: failed ? 'failed' : 'completed',
    content: [{ type: 'terminal', terminalId: `term_${id}`, output: failed ? `$ ${command}\nError: Cannot find module 'electron-vite'` : `$ ${command}\n`, exitCode: failed ? 1 : 0 }],
    locations: [], rawInput: { command }, startedAt: t0 + at, endedAt: t0 + at + ms,
  });
  return [
    msg('m_rv_1', th, 'user', t0 - 2_000, [text('match the desktop man its ui the chat one is not 1:! to synara')]),
    msg('m_rv_2', th, 'agent', t0, [
      text('To get it truly 1:1 I need to compare the two on screen, not just code. First I\'ll check whether the renderer has a mock mode I can screenshot without touching your real app.'),
      run('tc_rv_ls', 'ls apps/desktop/src/renderer/src/dev', 4_000, 300),
      {
        type: 'tool_call', toolCallId: 'tc_rv_read', title: 'Read lib/gateway.ts', kind: 'read', status: 'completed',
        content: [], locations: [{ path: `${APPU_WS}/lib/gateway.ts` }], rawInput: { file_path: `${APPU_WS}/lib/gateway.ts` },
        startedAt: t0 + 5_000, endedAt: t0 + 5_200,
      },
      run('tc_rv_check', 'pnpm -C apps/desktop typecheck', 6_000, 400),
      run('tc_rv_build', 'pnpm exec electron-vite build', 7_000, 2_100, true),
      run('tc_rv_build2', 'npx electron-vite build --outDir /tmp/chat-parity/build', 10_000, 3_200),
      { type: 'thought', text: 'I\'ll use the renderer\'s mock mode (VITE_APPUBOT_MOCK=1) with seeded chats to screenshot our chat offscreen, then compare it against Synara\'s window and iteratively fix differences, re-checking with screenshots each round.' },
      text('Found a pre-existing bug: the user bubble\'s markdown keeps its paragraph margins (specificity tie), making the bubble ~7px taller top and bottom. Let me check Synara\'s user footer metrics too.'),
      {
        type: 'tool_call', toolCallId: 'tc_rv_read2', title: 'Read chat/MessagesTimeline.tsx', kind: 'read', status: 'completed',
        content: [], locations: [{ path: `${APPU_WS}/chat/MessagesTimeline.tsx` }], rawInput: { file_path: `${APPU_WS}/chat/MessagesTimeline.tsx` },
        startedAt: t0 + 30_000, endedAt: t0 + 30_200,
      },
      run('tc_rv_py', `python3 - <<'EOF' p='AgentTurn.tsx'; s=open(p).read() old=\"\"\"<div className="space-y-px">\"\"\" EOF`, 40_000, 300),
      text('Fixed the bubble margins, the user footer metrics and the inherited 1.5 leading on the work-row labels. The chat now matches Synara side by side.'),
    ], { updatedAt: t0 + 52_000 }),
  ];
}

/* ---------- weeks of everyday history (deterministic) ---------- */
type Exchange = [ask: string, reply: Part[]];
const tool = (id: string, title: string, kind: ToolCallPart['kind'], rawInput: unknown, extra: Partial<ToolCallPart> = {}): ToolCallPart => ({
  type: 'tool_call', toolCallId: id, title, kind, status: 'completed', content: [], locations: [], rawInput, ...extra,
});
const EVERYDAY: ((id: string) => Exchange)[] = [
  () => ['What’s on my calendar tomorrow?', [text('Tomorrow you have **3 things**:\n\n- 10:00 - standup with the Acme team\n- 13:30 - lunch with Rahul at Toit\n- 17:00 - GST call with Priya')]],
  (id) => ['Rename the receipts in ~/Downloads/receipts by date', [tool(`${id}_mv`, 'Rename 14 receipts', 'move', { from: '~/Downloads/receipts' }), text('Renamed **14 receipts** to `YYYY-MM-DD-vendor.pdf`.')]],
  (id) => ['Summarise the Razorpay settlement report', [tool(`${id}_rd`, `Read ${APPU_WS}/inbox/settlement-report.pdf`, 'read', { file_path: `${APPU_WS}/inbox/settlement-report.pdf` }), text('Net settlement **₹2,84,310** across 41 payments; 2 refunds (₹6,200). Fees came to 1.9%.')]],
  () => ['Draft a reply to Rahul saying Thursday works', [text('Here’s a draft:\n\n> Hey Rahul, Thursday works - 1pm at Toit? See you there.\n\nWant me to send it from Mail?')]],
  (id) => ['How much did we spend on AWS last month?', [tool(`${id}_aws`, 'aws ce get-cost-and-usage --granularity MONTHLY', 'execute', { command: 'aws ce get-cost-and-usage --granularity MONTHLY' }), text('AWS came to **$412.18** last month, up 6% (mostly CloudFront).')]],
  (id) => ['Convert the Q3 deck to PDF and send it to my phone', [tool(`${id}_pdf`, 'soffice --convert-to pdf Q3-review.key', 'execute', { command: 'soffice --convert-to pdf Q3-review.key' }), tool(`${id}_send`, 'Send file to your phone', 'other', { path: `${APPU_WS}/outbox/Q3-review.pdf` }), text('Sent **Q3-review.pdf** to your phone.')]],
  (id) => ['Is the staging site up?', [tool(`${id}_curl`, 'curl -sI https://staging.appgrowthkit.com', 'execute', { command: 'curl -sI https://staging.appgrowthkit.com' }), text('Yes: staging answers **200 OK** in 180 ms.')]],
  (id) => ['Add “renew the domain” to my todo list', [tool(`${id}_todo`, 'Edit todo.md', 'edit', {}, { content: [{ type: 'diff', path: `${APPU_WS}/todo.md`, oldText: '- [ ] file GST\n', newText: '- [ ] file GST\n- [ ] renew the domain\n' }], locations: [{ path: `${APPU_WS}/todo.md` }] }), text('Added it to `todo.md`.')]],
  (id) => ['What’s the weather in Bengaluru this weekend?', [tool(`${id}_wx`, 'Fetch wttr.in/Bengaluru', 'fetch', { url: 'https://wttr.in/Bengaluru?format=3' }), text('Saturday 27° and cloudy, Sunday light rain in the afternoon. Take an umbrella.')]],
  (id) => ['Find the contract we signed with Acme', [tool(`${id}_find`, 'Search contracts', 'search', { pattern: 'Acme*.pdf' }), text('It’s `contracts/2026/Acme-MSA-signed.pdf` (signed 12 Mar).')]],
  (id) => ['Zip the invoices folder for Priya', [tool(`${id}_zip`, 'zip -r invoices-2026.zip invoices/2026', 'execute', { command: 'zip -r invoices-2026.zip invoices/2026' }), text('Made `outbox/invoices-2026.zip` (2.1 MB, 38 files).')]],
  () => ['thanks!', [text('Anytime.')]],
  () => ['Remind me what Priya needs this week', [text('Priya asked for the **September bank statement** and the signed **GSTR-1 summary** by Wednesday.')]],
  (id) => ['Clean up old node_modules folders in ~/Dev', [tool(`${id}_nm`, 'find ~/Dev -name node_modules -type d -prune -mtime +30', 'execute', { command: 'find ~/Dev -name node_modules -type d -prune -mtime +30' }), text('Found 9 stale `node_modules` folders (6.4 GB). Delete them?')]],
];

/** mulberry32: the same history every load */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weeks of sittings (mornings, lunch, evenings) before the recent turns: a few hundred messages. */
function everydayHistory(threadId: string, fromDay: number, toDay: number): Message[] {
  const out: Message[] = [];
  const rnd = seeded(42);
  let last = -1;
  for (let day = fromDay; day >= toDay; day--) {
    const date = new Date(ago(day * DAY));
    // a quiet day now and then
    if (rnd() < 0.15) continue;
    const sittings = [9, 13, 20].filter(() => rnd() < 0.65);
    for (const hour of sittings) {
      let at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, Math.floor(rnd() * 50)).getTime();
      const turns = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < turns; k++) {
        const id = `m_h${day}_${hour}_${k}`;
        // never the same exchange twice in a row
        const pick = (Math.floor(rnd() * (EVERYDAY.length - 1)) + last + 1) % EVERYDAY.length;
        last = pick;
        const [ask, reply] = EVERYDAY[pick]!(id);
        const via: Message['via'] = rnd() < 0.3 ? 'mobile' : 'desktop';
        out.push(msg(`${id}_u`, threadId, 'user', at, [text(ask)], { via }));
        const took = 8_000 + Math.floor(rnd() * 40_000);
        out.push(msg(`${id}_a`, threadId, 'agent', at + 2_000, structuredClone(reply), { via, updatedAt: at + 2_000 + took }));
        at += took + 60_000 + Math.floor(rnd() * 6 * MIN);
      }
    }
  }
  return out;
}

/* ---------- `?thread=media`: the parts the other threads don't have, and very long text ---------- */
function mediaThread(id: string): Message[] {
  const t = ago(5 * DAY);
  const shot = frameImage(1);
  const file = (fid: string, name: string, mimeType: string, size: number) => ({ id: fid, name, mimeType, size, url: `/files/${fid}`, path: `${APPU_WS}/inbox/${name}` });
  const LONG_URL = 'https://docs.example.com/receipts/2026/october/a-very-long-link-without-any-spaces-that-has-to-wrap-somewhere-inside-the-bubble?ref=appubot&utm=none';
  return [
    msg('m_med_1', id, 'user', t, [
      text(`Here are this month's receipts and a photo of the bill. Can you chart where the money went? ${LONG_URL}`),
      { type: 'image', mimeType: shot.mimeType, data: shot.data },
      { type: 'file', file: file('f_med_csv', 'card-statement-october-2026-final-final-v2.csv', 'text/csv', 18_400) },
    ]),
    msg('m_med_2', id, 'agent', t + 40_000, [
      text('Here is October at a glance. Software is the biggest bucket again:\n\n```mermaid\npie title October spending\n  "Software" : 42310\n  "Travel" : 18900\n  "Meals" : 6240\n  "Other" : 3100\n```\n\n| Category | Sep | Oct | Change | Share | Biggest item | Card | Note |\n| --- | ---: | ---: | ---: | ---: | --- | --- | --- |\n| Software | ₹39,800 | ₹42,310 | +6% | 60% | Figma annual | HDFC | renews in March |\n| Travel | ₹9,200 | ₹18,900 | +105% | 27% | Goa flights | Amex | trip in December |\n| Meals | ₹7,100 | ₹6,240 | -12% | 9% | Toit | HDFC | |'),
      { type: 'image', mimeType: shot.mimeType, data: shot.data },
      { type: 'page', title: 'October spending by week', file: file('f_med_page', 'october-spending.html', 'text/html', 6_200) },
      { type: 'voice', file: file('f_med_voice', 'reply.ogg', 'audio/ogg', 41_000), durationMs: 14_000, kind: 'reply', transcript: 'October came to seventy thousand rupees, mostly software.' },
    ], { reactions: [{ emoji: '👍', by: 'user', at: t + 60_000 }] }),
    msg('m_med_3', id, 'user', t + 2 * MIN, [
      { type: 'voice', file: file('f_med_rec', 'recording.ogg', 'audio/ogg', 22_000), durationMs: 6_500, kind: 'recording', transcript: 'Nice. Can you also send it to Priya?' },
      text('Nice. Can you also send it to Priya?'),
    ], { reactions: [{ emoji: '🙌', by: 'bot', at: t + 2 * MIN + 5_000 }] }),
    msg('m_med_4', id, 'agent', t + 2 * MIN + 20_000, [], { status: 'error', error: 'The agent stopped: you have reached your usage limit until 3 PM.' }),
    msg('m_med_5', id, 'user', t + 3 * MIN, [text('Thisisaverylongwordwithoutanyspacesthatsomeonepastedfromaspreadsheetcellanditkeepsgoingandgoingpasttheedge\n\nAnd a second paragraph, so the bubble has to wrap over several lines and still read well at every width of the window.')]),
    msg('m_med_6', id, 'agent', t + 3 * MIN + 15_000, [
      text('Sent to Priya.'),
      { type: 'text', text: 'One more thing: the Figma renewal is due in March.', said: true },
    ]),
  ];
}

/* ---------- `?thread=routines`: a routine every 10 minutes that mostly has nothing to say ---------- */
const ASANA_PROMPT = 'Check my Asana notifications (get_notifications, story.text): @-mentions, new tasks assigned to me, mentions of me. Compare them with asana-seen.json in the workspace. Only send a push notification (notify_user) when there is something new for me: briefly, which task, what it asks, the link. Then write them into the file. When there is nothing new, send no notification and answer only ✓.';
function routinesThread(id: string): Message[] {
  const out: Message[] = [];
  const routine = { id: IDS.routineAsana, name: 'Asana check' };
  let n = 0;
  const call = (at: number, status: ToolCallPart['status'] = 'completed'): ToolCallPart => ({
    type: 'tool_call', toolCallId: `tc_rt_${n}`, title: 'get_notifications', kind: 'fetch', status, content: [], locations: [], startedAt: at + 3_000, ...(status === 'completed' ? { endedAt: at + 9_000 } : {}),
  });
  const run = (at: number, reply: Part[], extra: Partial<Message> = {}) => {
    n++;
    out.push(msg(`m_rt_${n}_p`, id, 'user', at, [text(ASANA_PROMPT)], { via: 'routine', routine }));
    out.push(msg(`m_rt_${n}_a`, id, 'agent', at + 1_000, reply, { via: 'routine', updatedAt: at + 14_000, ...extra }));
  };
  const nothing = (at: number) => run(at, [text('I’ll check your Asana notifications.'), call(at), text('✓')]);
  // yesterday, before the routine was named on its messages (an older computer): they fold as "Routine"
  const yesterday = ago(DAY + 3 * HOUR);
  out.push(msg('m_rt_hi_u', id, 'user', yesterday - 20 * MIN, [text('Can you keep an eye on Asana for me? Every 10 minutes is fine.')]));
  out.push(msg('m_rt_hi_a', id, 'agent', yesterday - 19 * MIN, [text('Done: I made a routine, “Asana check”, every 10 minutes. You only hear from me when something is new.')]));
  for (let k = 0; k < 9; k++) {
    n++;
    const at = yesterday + k * 10 * MIN;
    out.push(msg(`m_rt_${n}_p`, id, 'user', at, [text(ASANA_PROMPT)], { via: 'routine' }));
    out.push(msg(`m_rt_${n}_a`, id, 'agent', at + 1_000, [text('✓')], { via: 'routine', updatedAt: at + 12_000 }));
  }
  // today: 14 quiet runs, one with news, a message of yours, more quiet runs, one that failed, one running now
  const today = ago(200 * MIN);
  for (let k = 0; k < 14; k++) nothing(today + k * 10 * MIN);
  run(today + 14 * 10 * MIN, [call(today + 140 * MIN), text('2 new tasks for you:\n\n- **Logo review** (due Friday): Anna wants two directions by Thursday. [Open](https://app.asana.com/0/1/2)\n- A comment from Anna on **Budget 2027**: “Can you check the Q2 numbers?”\n\nI sent you a notification and noted both as seen.')]);
  out.push(msg('m_rt_thanks', id, 'user', today + 145 * MIN, [text('Thanks! Tell Anna I’ll send the logos tomorrow.')]));
  out.push(msg('m_rt_thanks_a', id, 'agent', today + 145 * MIN + 2_000, [text('Replied on the task: “Sarthak will send the logo directions tomorrow.”')]));
  for (let k = 15; k < 17; k++) nothing(today + k * 10 * MIN);
  run(today + 17 * 10 * MIN, [call(today + 170 * MIN, 'failed')], { status: 'error', error: 'Asana answered 503: Service Unavailable.' });
  nothing(today + 18 * 10 * MIN);
  nothing(today + 19 * 10 * MIN);
  // the run going on now
  const now = ago(2 * MIN);
  n++;
  out.push(msg(`m_rt_${n}_p`, id, 'user', now, [text(ASANA_PROMPT)], { via: 'routine', routine }));
  out.push(msg(`m_rt_${n}_a`, id, 'agent', now + 1_000, [call(now, 'in_progress')], { via: 'routine', status: 'streaming' }));
  return out;
}

/* ---------- `?thread=work`: a long working turn for the work trail (`&work=1`), then one still running ---------- */
const STATEMENT_CSV = `date,merchant,amount,category
2026-10-02,Figma,4500,Software
2026-10-04,IndiGo,12400,Travel
2026-10-09,Toit Brewpub,2100,Meals
2026-10-11,Notion Labs,1600,Other
2026-10-18,Uber India,840,Other`;
const OLD_RULES = `Software:
  - Figma
  - Linear
Travel:
  - IndiGo
  - Uber India
Meals:
  - Toit Brewpub
`;
const NEW_RULES = `Software:
  - Figma
  - Linear
  - Notion Labs
Travel:
  - IndiGo
  - Uber India
  - Uber
Meals:
  - Toit Brewpub
`;
const BUILD_FAIL = `Traceback (most recent call last):
  File "build_report.py", line 3, in <module>
    from reportlab.lib.pagesizes import A4
ModuleNotFoundError: No module named 'reportlab'
Exit code 1`;
const BUILD_OK = `Reading inbox/card-statement-october.csv (38 rows)
Categorised 38 transactions with rules/categories.yaml
  Software  ₹42,310
  Travel    ₹18,900
  Meals      ₹6,240
  Other      ₹3,100
Wrote reports/expenses-2026-10.pdf (61.4 KB)`;

function workThread(id: string): Message[] {
  const t0 = ago(14 * MIN);
  let k = 0;
  const call = (title: string, kind: ToolCallPart['kind'], at: number, took: number, extra: Partial<ToolCallPart> = {}): ToolCallPart => ({
    type: 'tool_call', toolCallId: `tc_work_${++k}`, title, kind, status: 'completed', content: [], locations: [],
    startedAt: at, endedAt: at + took, ...extra,
  });
  const cmd = (command: string, at: number, took: number, output: string, extra: Partial<ToolCallPart> = {}) =>
    call(command, 'execute', at, took, { rawInput: { command }, content: [{ type: 'terminal', terminalId: `term_${k + 1}`, output }], ...extra });
  const settled: Part[] = [
    { type: 'thought', text: 'The statement is the CSV they sent this morning. I should read it, check which merchants the category rules miss, fix the rules, then rebuild the report with the script.\n\nIf the totals look off I can compare them with last month in Numbers before sending anything.' },
    // a run that is a thought and a page fetched: the trail's web group (its globe) with a rail of two steps
    call('Fetch api.frankfurter.app/latest?from=USD&to=INR', 'fetch', t0 + 1_500, 1_200, { rawInput: { url: 'https://api.frankfurter.app/latest?from=USD&to=INR' }, content: [{ type: 'text', text: '{"amount":1.0,"base":"USD","rates":{"INR":88.41}}' }] }),
    text('Let me look at the statement and the category rules first.'),
    call('Read inbox/card-statement-october.csv', 'read', t0 + 4_000, 900, { locations: [{ path: `${APPU_WS}/inbox/card-statement-october.csv` }], content: [{ type: 'text', text: STATEMENT_CSV }] }),
    call('grep', 'search', t0 + 6_000, 700, { rawInput: { pattern: 'Other' }, content: [{ type: 'text', text: 'inbox/card-statement-october.csv:5\ninbox/card-statement-october.csv:6' }] }),
    call('Read rules/categories.yaml', 'read', t0 + 7_500, 600, { locations: [{ path: `${APPU_WS}/rules/categories.yaml` }], content: [{ type: 'text', text: OLD_RULES }] }),
    text('Notion and one Uber ride are filed under Other. Fixing the rules, then rebuilding the PDF.'),
    call('Edit rules/categories.yaml', 'edit', t0 + 12_000, 1_100, { locations: [{ path: `${APPU_WS}/rules/categories.yaml` }], content: [{ type: 'diff', path: `${APPU_WS}/rules/categories.yaml`, oldText: OLD_RULES, newText: NEW_RULES }] }),
    cmd('python3 build_report.py --month 2026-10', t0 + 15_000, 2_400, BUILD_FAIL, { status: 'failed' }),
    cmd('pip install --user reportlab', t0 + 19_000, 9_000, 'Successfully installed reportlab-4.2.5'),
    cmd('python3 build_report.py --month 2026-10', t0 + 30_000, 4_200, BUILD_OK),
    { type: 'thought', text: 'Built. I will check the totals row against last month in Numbers before sending it.' },
    call('Open app', 'computer', t0 + 38_000, 1_400, { computer: { action: { type: 'open_app', app: 'Numbers' }, frameId: 'frame_a1' } }),
    call('Click', 'computer', t0 + 41_000, 900, { computer: { action: { type: 'click', x: 412, y: 88, app: 'Numbers', pid: 501 }, frameId: IDS.computerFrame } }),
    call('Look at the screen', 'computer', t0 + 44_000, 700, { computer: { action: { type: 'screenshot' }, frameId: 'frame_a4' } }),
    call('Send file to you', 'other', t0 + 50_000, 500, { rawInput: { path: `${APPU_WS}/reports/expenses-2026-10.pdf` } }),
    text('Your **October expense report** is ready: ₹70,550 in all, Software the biggest at ₹42,310.\n\nI moved Notion to Software and the Uber ride to Travel, so nothing is left under Other except ₹3,100 of small items. The totals match what Numbers shows.'),
    { type: 'file', file: { id: 'f_work_pdf', name: 'expenses-2026-10.pdf', mimeType: 'application/pdf', size: 62_874, url: '/files/f_work_pdf', path: `${APPU_WS}/reports/expenses-2026-10.pdf` } },
  ];
  const t1 = ago(50_000);
  const running: Part[] = [
    text('On it, same steps for September.'),
    call('Read inbox/card-statement-september.csv', 'read', t1 + 3_000, 800, { locations: [{ path: `${APPU_WS}/inbox/card-statement-september.csv` }], content: [{ type: 'text', text: STATEMENT_CSV }] }),
    call('grep', 'search', t1 + 5_000, 600, { rawInput: { pattern: 'Other' }, content: [{ type: 'text', text: 'inbox/card-statement-september.csv:9' }] }),
    text('The rules already cover September’s merchants. Building the PDF now.'),
    { type: 'thought', text: 'September had the Goa deposit; it should land under Travel.' },
    call('Read rules/categories.yaml', 'read', t1 + 14_000, 500, { locations: [{ path: `${APPU_WS}/rules/categories.yaml` }], content: [{ type: 'text', text: NEW_RULES }] }),
    { ...cmd('python3 build_report.py --month 2026-09', ago(9_000), 0, ''), status: 'in_progress', endedAt: undefined, content: [] },
  ];
  return [
    msg('m_work_1', id, 'user', t0 - 2_000, [text('Pull together the October expense report: check the card statement, fix any wrong categories, rebuild the PDF and send it to me.')]),
    msg('m_work_2', id, 'agent', t0, settled, { updatedAt: t0 + 83_000 }),
    msg('m_work_3', id, 'user', t1 - 2_000, [text('Thanks! Now the same for September.')]),
    msg('m_work_4', id, 'agent', t1, running, { status: 'streaming', updatedAt: ago(9_000) }),
  ];
}

/* ---------- the conversations ---------- */
export function buildMessages(opts: MockOptions): Record<string, Message[]> {
  const appu = IDS.main;
  const daily = IDS.appuDaily;
  const goa = IDS.appuGoa;
  const screens = IDS.appuScreens;
  const ledger = IDS.ledgerChat;
  return {
    [daily]: [...everydayHistory(daily, 40, 5), ...reviewTurn(daily)],
    [IDS.appuMedia]: mediaThread(IDS.appuMedia),
    [IDS.appuRoutines]: routinesThread(IDS.appuRoutines),
    ...(opts.thread === 'work' ? { [IDS.appuWork]: workThread(IDS.appuWork) } : {}),
    ...(opts.thread === 'failed' ? {
      [IDS.appuFailed]: [
        msg('m_failed_1', IDS.appuFailed, 'user', ago(2 * MIN), [text('Plan a two-day offsite for 40 people near Goa in early December.')]),
        msg('m_failed_2', IDS.appuFailed, 'agent', ago(2 * MIN) + 1_000, [{ type: 'system', text: 'The requested model is not supported', level: 'error' }], { status: 'error', error: 'The requested model is not supported', updatedAt: ago(2 * MIN) + 4_000 }),
      ],
    } : {}),
    [goa]: [
      msg('m_trip_1', goa, 'user', ago(3 * DAY + HOUR), [text('Plan a relaxed 4-day Goa trip for early December. Mostly beaches and good food.')], { via: 'mobile' }),
      msg('m_trip_2', goa, 'agent', ago(3 * DAY + HOUR) + 30_000, [
        text('Here\'s a laid-back plan:\n\n- **Day 1** - land, check in near Assagao, sunset at Vagator\n- **Day 2** - Ashwem & Mandrem beaches, dinner at Gunpowder\n- **Day 3** - Panjim walk, Fontainhas, feni tasting\n- **Day 4** - Palolem morning, fly out\n\nI saved it as `trips/goa-itinerary.md`.'),
      ], { via: 'channel' }),
    ],
    [screens]: [
      msg('m_ss_1', screens, 'user', ago(DAY + 2 * HOUR), [text('My Desktop is full of screenshots. Move them into ~/Pictures/Screenshots/<month> folders.')]),
      msg('m_ss_2', screens, 'agent', ago(DAY + 2 * HOUR) + 25_000, [
        { type: 'tool_call', toolCallId: 'tc_ss', title: 'Move 63 screenshots into monthly folders', kind: 'move', status: 'completed', content: [{ type: 'text', text: 'Moved 63 files into 4 folders.' }], locations: [], startedAt: ago(DAY + 2 * HOUR) + 5_000, endedAt: ago(DAY + 2 * HOUR) + 21_000 },
        text('Done - moved **63 screenshots** into `~/Pictures/Screenshots/` (July → October). Your Desktop is clear.'),
      ]),
    ],
    [appu]: [
      msg('m_inbox_1', appu, 'user', ago(3 * HOUR), [text('Check my Mail inbox for anything unread since yesterday. Summarise what needs a reply today and draft short answers for the easy ones.')], { via: 'routine', routine: { id: IDS.routineInbox, name: 'Morning inbox digest' } }),
      msg('m_inbox_2', appu, 'agent', ago(3 * HOUR) + 40_000, [
        text('**4 emails need you today:**\n\n1. **Priya (Ledgerworks)** - needs the September bank statement by Wednesday.\n2. **Acme Corp** - asking for the retainer invoice.\n3. **Razorpay** - settlement report for Oct 9 is ready.\n4. **Rahul** - lunch Thursday? I drafted a “yes, 1pm works”.\n\nThe other 11 are newsletters; I left them unread.'),
      ], { via: 'routine' }),
      ...mainThread(opts),
    ],
    ...(opts.groupsFilm ? {
      [FILM_PIXEL_CHAT]: [
        msg('m_px_1', FILM_PIXEL_CHAT, 'user', ago(6 * MIN), [text('The launch thread goes out Friday at 9:00. Can you make a square version of the graphic for the first post, with the headline a little bigger?')], { via: 'bot', from: { botId: FILM_IDS.echo, name: 'Echo' } }),
        msg('m_px_2', FILM_PIXEL_CHAT, 'agent', ago(5 * MIN), [text('Done: a 1080 × 1080 version with the headline at 72 pt, saved next to the others as `launch-square.png`. I put it on post one of your draft.')]),
      ],
    } : {}),
    [ledger]: [
      msg('m_led_1', ledger, 'user', ago(6 * DAY + 3 * HOUR), [text('What’s due for GST this month?')]),
      msg('m_led_2', ledger, 'agent', ago(6 * DAY + 3 * HOUR) + 20_000, [text('GSTR-1 for September is due on **11 Oct**, GSTR-3B on **20 Oct**.')]),
      msg('m_gst_1', ledger, 'user', ago(5 * HOUR), [text('Prepare the GSTR-1 summary for September.')]),
      msg('m_gst_2', ledger, 'agent', ago(5 * HOUR) + 50_000, [
        text('September GSTR-1 is ready to review:\n\n| | Taxable value | IGST | CGST + SGST |\n| --- | ---: | ---: | ---: |\n| B2B (9 invoices) | ₹8,40,000 | ₹64,800 | ₹86,400 |\n| Exports (2) | ₹3,10,000 | - | - |\n\nFiling is due **11 Oct**.'),
      ]),
    ],
    [IDS.expenses]: [
      msg('m_exp_1', IDS.expenses, 'user', ago(2 * DAY + 3 * HOUR), [text('categorise oct expenses pls')], { via: 'channel' }),
      msg('m_exp_2', IDS.expenses, 'agent', ago(2 * DAY + 3 * HOUR) + 20_000, [
        text('Categorised 38 transactions. Biggest buckets: **Software ₹42,310**, **Travel ₹18,900**, **Meals ₹6,240**. Exported to `exports/expenses-oct.csv`.'),
      ], { via: 'channel' }),
    ],
  };
}
