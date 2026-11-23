/**
 * Dev and bench only: a long, deterministic conversation (code blocks, tables, lists, tool calls, thoughts) for the
 * performance benches (apps/desktop/bench). The mock gateway seeds it with `?long=<n>`, and bench/startup.mjs writes
 * it into a test data folder (Node runs this file with its type stripping, so it imports types only).
 */
import type { Message, Part } from '@appubot/protocol';

const CODE_TS = `export async function makeInvoice(client: Client, items: LineItem[]): Promise<Invoice> {
  const subtotal = items.reduce((sum, it) => sum + it.qty * it.rate, 0);
  const gst = Math.round(subtotal * GST_RATE * 100) / 100;
  const number = \`\${PREFIX}-\${String(await nextNumber()).padStart(4, '0')}\`;
  const due = addDays(new Date(), client.dueDays ?? DUE_DAYS);
  const invoice = { number, client: client.id, items, subtotal, gst, total: subtotal + gst, due };
  await db.invoices.insert(invoice);
  log.info('invoice created', { number, total: invoice.total });
  return invoice;
}`;
const CODE_PY = `import csv
from datetime import date

def categorise(rows):
    buckets = {}
    for row in rows:
        cat = RULES.get(row["merchant"].lower(), "Other")
        buckets.setdefault(cat, 0)
        buckets[cat] += float(row["amount"])
    return dict(sorted(buckets.items(), key=lambda kv: -kv[1]))

with open("exports/expenses.csv") as f:
    print(categorise(csv.DictReader(f)))`;
const CODE_SH = `$ git status --short
 M src/invoice.ts
 M src/templates/classic-gst.html
?? exports/expenses-oct.csv
$ pnpm test -- invoice
 ✓ invoice.test.ts (12 tests) 84ms`;
const TABLE = `| Client | Invoices | Paid | Outstanding |
| --- | ---: | ---: | ---: |
| Acme Corp | 12 | ₹4,80,000 | ₹40,000 |
| Ledgerworks | 7 | ₹2,10,000 | - |
| Northwind | 3 | ₹90,000 | ₹30,000 |
| Globex | 9 | ₹3,60,000 | ₹1,20,000 |`;

const USER = [
  'Can you check which invoices are still unpaid and draft reminders for the ones over 30 days?',
  'Categorise last month’s expenses and tell me the three biggest buckets.',
  'Refactor makeInvoice so the GST rate comes from the client profile.',
  'What changed in the repo since yesterday?',
  'Summarise the thread with Priya and list what she still needs from us.',
];

/** The agent's reply for turn `i`: a rotating mix of the markdown a real reply carries. */
function reply(i: number): string {
  switch (i % 5) {
    case 0: return `Here's where things stand (${i}):\n\n${TABLE}\n\n**Two** clients are past 30 days. I drafted reminders for both and saved them as \`drafts/reminder-${i}.md\`.`;
    case 1: return `I categorised **148 transactions**. The biggest buckets:\n\n1. **Software** - ₹42,310\n2. **Travel** - ₹18,900\n3. **Meals** - ₹6,240\n\nThe script I used:\n\n\`\`\`python\n${CODE_PY}\n\`\`\`\n\nWant me to export it to the sheet?`;
    case 2: return `Done - \`makeInvoice\` now reads the rate from the client, falling back to the default:\n\n\`\`\`ts\n${CODE_TS}\n\`\`\`\n\nAll **12 tests** pass. I also updated the [template](https://example.com/templates) so the GST line shows the client's rate.`;
    case 3: return `Since yesterday:\n\n\`\`\`bash\n${CODE_SH}\n\`\`\`\n\n- the GST template was updated\n- an expenses export was added (not committed yet)\n- tests are green\n\nNothing else moved.`;
    default: return `Priya still needs:\n\n- the **September bank statement** (by Wednesday)\n- a signed copy of the *Acme retainer*\n- the TDS certificates for Q2\n\n> She also asked whether we can move the review call to Thursday.\n\nI can reply for you with the statement attached once you confirm.`;
  }
}

/**
 * `n` messages (user and agent alternating, oldest first) in thread `threadId`, ending at `end` (epoch ms), one turn
 * every 7 minutes.
 */
export function benchMessages(threadId: string, n: number, end = Date.now() - 60_000): Message[] {
  const out: Message[] = [];
  const turns = Math.ceil(n / 2);
  for (let t = 0; t < turns; t++) {
    const at = end - (turns - t) * 7 * 60_000;
    const user: Message = {
      id: `m_bench_${t}_u`, threadId, role: 'user', parts: [{ type: 'text', text: USER[t % USER.length]! }],
      status: 'complete', via: 'desktop', createdAt: at, updatedAt: at,
    };
    const parts: Part[] = [];
    if (t % 3 === 0) parts.push({ type: 'thought', text: 'Let me look at the files first, then answer with what I found and what I changed.' });
    if (t % 2 === 0) {
      parts.push({
        type: 'tool_call', toolCallId: `tc_bench_${t}`, title: t % 4 === 0 ? 'Read src/invoice.ts' : 'Search workspace for "invoice"',
        kind: t % 4 === 0 ? 'read' : 'search', status: 'completed', content: [{ type: 'text', text: 'Found 3 matches:\n- src/invoice.ts:14\n- notes/clients.md:2\n- exports/expenses.csv:1' }],
        locations: [{ path: 'src/invoice.ts', line: 14 }], startedAt: at + 2_000, endedAt: at + 3_500,
      });
    }
    if (t % 6 === 1) {
      parts.push({
        type: 'tool_call', toolCallId: `tc_bench_edit_${t}`, title: 'Edit src/invoice.ts', kind: 'edit', status: 'completed',
        content: [{ type: 'diff', path: 'src/invoice.ts', oldText: CODE_TS.replace('GST_RATE', '0.18'), newText: CODE_TS }],
        locations: [{ path: 'src/invoice.ts', line: 3 }], startedAt: at + 4_000, endedAt: at + 5_000,
      });
    }
    parts.push({ type: 'text', text: reply(t) });
    const agent: Message = {
      id: `m_bench_${t}_a`, threadId, role: 'agent', parts, status: 'complete', stopReason: 'end_turn', via: 'desktop',
      createdAt: at + 30_000, updatedAt: at + 30_000,
    };
    out.push(user, agent);
  }
  return out.slice(out.length - n);
}

/**
 * A long streaming reply for the streaming bench: `tokens` word-ish pieces of markdown (paragraphs, a code block, a
 * table, a list), in the order the agent would send them.
 */
export function benchReplyTokens(tokens: number): string[] {
  const text = [reply(2), reply(0), reply(1), reply(3), reply(4)].join('\n\n');
  const pieces = text.match(/\S+\s*|\s+/g) ?? [];
  const out: string[] = [];
  for (let i = 0; out.length < tokens; i++) out.push(pieces[i % pieces.length]!);
  return out;
}
