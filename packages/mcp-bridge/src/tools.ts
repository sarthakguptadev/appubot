/**
 * Tool definitions shared by the bridge (runtime) and docs. Keep names stable: the agent-runtime
 * maps any tool whose name starts with `computer_` to ToolKind 'computer'.
 */
import { z } from 'zod';
import { BOT_COLORS, BOT_COLOR_NAMES, BotShape, machineName, SpeechLanguage, VOICE_SPEAK_MAX_CHARS } from '@appubot/protocol';

/*
 * Computer use works on app windows and leaves the user's own mouse pointer alone (AppuBot brings the window to the
 * front so the user can watch, unless they chose background mode; a click on a web page borrows the pointer for a
 * moment, since pages only react to real clicks). In background mode the window stays behind the user's, and a step
 * that needs it in front waits until they pause; `front` asks for that when a step did nothing in the background.
 * The fast loop is computer_open_app (returns the app's window:
 * picture + labelled elements) → computer_batch (many steps in one call, aimed by label, element number or x/y pixels
 * of the latest picture; one look back at the end). Single-step tools are there for one-offs. Each element of a
 * snapshot can be aimed at by its label ("Save"), its number [N], its token, or the pixels where it is drawn.
 */
/** macOS's words and examples stay as they are; Windows and Linux get their own (Ctrl shortcuts, their apps). */
const MAC = process.platform === 'darwin';
/** "Mac", "PC" or "computer" in the tools' words */
const MACHINE = machineName(process.platform);
/** a Mac's Cmd shortcuts are Ctrl ones on Windows and Linux */
const CMD = MAC ? 'cmd' : 'ctrl';
/** an AppuBot Cloud computer (the gateway sets APPUBOT_CLOUD=1): its image has Google Chrome, Files, a terminal and Mousepad */
const CLOUD = process.env.APPUBOT_CLOUD === '1';
const APP_EXAMPLES = MAC ? '"Safari", "Numbers", "Zoho Books") or bundle id'
  : process.platform === 'win32' ? '"Microsoft Edge", "Notepad", "Excel") or the path of its .exe'
  : CLOUD ? '"google-chrome", "Files", "Mousepad") or its command' : '"firefox", "Files", "LibreOffice Calc") or its command';

const win = { pid: z.number().int().describe('Process id of the app (from computer_open_app / computer_window / computer_list_windows)'), window_id: z.number().int().describe('Window id (from the same)') };
const optWin = { pid: win.pid.optional(), window_id: win.window_id.optional() };
const target = {
  label: z.string().optional().describe('Aim at the element with this accessibility label in the window ("Save", "7", "Search"): the most reliable aim when the element list shows it'),
  element: z.string().optional().describe('Aim at element [N] of the latest snapshot ("12"), or its element_token'),
  x: z.number().optional().describe('Else: X in pixels of the latest picture of this window, where you see the target'),
  y: z.number().optional().describe('Y in pixels of that same picture'),
};

/** Background mode's escalation: send this one step with the window in front for a moment. */
const front = z.boolean().optional().describe('Background mode only (AppuBot says when it is on): this same step did nothing behind the user\'s windows, so send it with the window briefly in front, once they pause');

const STEP = z.object({
  do: z.enum(['click', 'double_click', 'right_click', 'type', 'key', 'scroll', 'drag', 'wait', 'open_app']),
  ...target,
  text: z.string().optional().describe('type: the text (into the element aimed at, else the focused field)'),
  key: z.string().optional().describe(`key: a key or combo, e.g. "enter", "tab", "${CMD}+s", "${CMD}+shift+n"`),
  direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('scroll'),
  amount: z.number().int().min(1).max(50).optional().describe('scroll: lines (default 5)'),
  to_x: z.number().optional().describe('drag: end X (x/y is the start)'),
  to_y: z.number().optional().describe('drag: end Y'),
  ms: z.number().int().min(50).max(15000).optional().describe('wait: how long (default 1000). Only for slow things (a page or file loading): the batch already lets the app draw after each step and before its final look'),
  app: z.string().optional().describe(MAC ? 'open_app: the app name or bundle id; later steps work in its window' : 'open_app: the app name; later steps work in its window'),
  modifiers: z.array(z.enum(['cmd', 'shift', 'alt', 'ctrl'])).optional().describe('click: modifier keys held'),
  front,
});
export type BatchStep = z.infer<typeof STEP>;

export const computerTools = {
  computer_batch: {
    description:
      'The fast way to use an app: several steps in ONE call (click, type, key, scroll, drag, wait, open_app), done back to back, then one look at the window at the end (its picture, elements and the text it shows). ' +
      'Put every step you can already plan into one batch, e.g. a whole form or a sequence of button presses, instead of one tool call per action. ' +
      'Aim steps by label (e.g. {do:"click", label:"Save"}), by element number from the latest snapshot, or by x/y pixels of the latest picture. ' +
      `Steps go to pid/window_id (or the window an open_app step opened). Prefer keys for text work (${CMD}+a, shift+down, ${CMD}+b): they are instant and exact.` + ' No wait steps after ordinary actions. The first failing step stops the batch and says why.',
    input: z.object({ ...optWin, steps: z.array(STEP).min(1).max(60), look: z.enum(['window', 'picture', 'none']).default('window').describe('What comes back at the end: window = picture + elements (default), picture = picture only, none = nothing') }),
  },
  computer_open_app: { description: `Launch or activate an application by name (e.g. ${APP_EXAMPLES}; optionally open a URL/file in it.` + ' Returns its pid, window_id and a snapshot of its window (picture + labelled elements), ready for computer_batch.', input: z.object({ name: z.string().optional(), bundle_id: z.string().optional(), url: z.string().optional() }) },
  computer_window: {
    description: 'Look at one app window: its picture, a numbered list of its UI elements (role, label, value) and the text it shows. Call it when you start on a window you did not open with computer_open_app, or to refresh the element list (each snapshot replaces the previous one). Works on windows behind others.',
    input: z.object({ ...win, max_elements: z.number().int().min(20).max(1500).default(300).describe('Cap on listed elements') }),
  },
  computer_click: {
    description: 'Click once in an app window, aimed by label, element number or x/y pixels of its latest picture. Returns a fresh picture. For several steps in a row use computer_batch. On web pages AppuBot clicks for real, so page buttons always react.',
    input: z.object({ ...win, ...target, button: z.enum(['left', 'right', 'middle']).default('left'), count: z.number().int().min(1).max(3).default(1).describe('1=click, 2=double, 3=triple'), modifiers: z.array(z.enum(['cmd', 'shift', 'alt', 'ctrl'])).default([]).describe('Modifier keys (briefly brings the window to the front)'), front }),
  },
  computer_type: { description: 'Type text into an app: into the element aimed at by label/element, else the window\'s focused field (pid/window_id), else the frontmost app. For typing plus Enter/Tab and more, use computer_batch.', input: z.object({ text: z.string(), ...optWin, label: target.label, element: target.element, front }) },
  computer_key: { description: `Press a key with optional modifiers in an app window, e.g. {key:"enter"} or {key:"s", modifiers:["${CMD}"]}. Keys: enter, tab, escape, space, backspace, delete, up/down/left/right, home, end, pageup, pagedown, f1-f12, a-z, 0-9, punctuation. Without pid/window_id it goes to the frontmost app.`, input: z.object({ key: z.string(), modifiers: z.array(z.enum(['cmd', 'shift', 'alt', 'ctrl', 'fn'])).default([]), ...optWin, front }) },
  computer_scroll: { description: 'Scroll inside an app window at a label, element or x/y pixels of its latest picture. direction down scrolls content up (like a user flicking down).', input: z.object({ ...win, ...target, direction: z.enum(['up', 'down', 'left', 'right']).default('down'), amount: z.number().int().min(1).max(50).default(5).describe('lines'), front }) },
  computer_drag: { description: MAC
    ? "Drag inside an app window with the left button; from/to are pixels of its latest picture. macOS can only drag with the user's real mouse pointer, so this briefly brings the window to the front, moves their pointer along the path and then switches back to the app they were in: use it when keys, menus or clicks can't do the job."
    : "Drag inside an app window with the left button; from/to are pixels of its latest picture. It drags with the user's real mouse pointer: the window comes to the front and their pointer moves along the path. Use it when keys, menus or clicks can't do the job.", input: z.object({ ...win, from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number(), duration_ms: z.number().int().default(400) }) },
  computer_wait: { description: 'Wait for something slow (a page loading, a download), then return a fresh view of the window (pid/window_id) or the whole screen. Not needed after an ordinary click or keypress.', input: z.object({ ms: z.number().int().min(100).max(15000).default(1000), ...optWin }) },
  computer_screenshot: {
    description: 'See the whole screen (overview only). To act on an app, use computer_open_app or computer_list_windows, then work in its window.',
    input: z.object({ max_width: z.number().int().min(320).max(2560).optional().describe('Downscale width, default 2048') }),
  },
  computer_list_windows: { description: 'List windows with pid, window_id, app name, title and bounds (to pick one for computer_window).', input: z.object({ pid: z.number().int().optional() }) },
  computer_list_apps: { description: 'List running (and installed) applications with pids and bundle ids.', input: z.object({ running_only: z.boolean().default(true) }) },
  computer_clipboard_read: { description: 'Read the clipboard text.', input: z.object({}) },
  computer_clipboard_write: { description: 'Write text to the clipboard.', input: z.object({ text: z.string() }) },
} as const;

export const userTools = {
  show_page: {
    description: 'Show the user a visual answer drawn right in their chat: a self-contained HTML page (a chart, a table, a diagram, a photo collage, a mockup). Use it when a picture says it better than text ("show my spending as a chart"), then add a short message of your own. The chat shows the page inside one card of its own, with nothing else round it: start straight with the content and never draw a card, panel, frame, shadow or background round the whole page, nor a title bar (a short heading is fine, and so are boxes for parts of it, like tiles in a grid). It already looks like the app: the font, text sizes, headings, tables, buttons and the space round the page are set, so add only what your content needs and keep it calm (no gradients, glows or emoji decoration; one accent colour). The page has no internet: put all CSS and JavaScript inline (draw charts with inline SVG or <canvas>, no libraries from the web); local images can be referenced by absolute path (src="/Users/…/photo.jpg", home or temp folder) and are built in. Use the chat\'s theme variables so it fits light and dark mode, never a hard-coded text or background colour: var(--fg) text, var(--muted) secondary text, var(--surface) and var(--surface-2) for tiles and panels inside the page, var(--border) lines, var(--radius) corners, var(--accent), var(--c1)…var(--c6) for chart series, var(--font) and var(--mono). Links open in the user\'s browser. On Telegram it arrives as an HTML file.',
    input: z.object({
      title: z.string().min(1).max(120).describe('A short title, e.g. "Spending by month"'),
      html: z.string().min(1).describe('The whole page: HTML with inline <style> and <script>'),
    }),
  },
  send_file: { description: 'Deliver a file on this computer to the user (shows in their chat and on their phone with a download button, and in Telegram when they wrote from there). Use for PDFs, exports, screenshots, images, songs or recordings, videos you were asked to produce. On Telegram, images arrive as photos, MP3/M4A as playable audio, OGG/Opus as a voice note and MP4 as a video (Telegram takes up to 50 MB).', input: z.object({ path: z.string().describe('Absolute path'), caption: z.string().optional() }) },
  start_goal: {
    description: 'Propose a goal to work on by yourself, step after step across many turns, without the user prompting each one: for work that takes many steps (research and write a report, clean up a folder, build and test something, go through an inbox). The user sees it on a card with the goal and how many turns you may take, may sharpen either, and taps Allow; then after each of your turns AppuBot sends you on to the next step until you call finish_goal, or the turns or time run out. Use it when you judge a task needs many steps of your own; not for quick answers or anything that needs the user at every step. One goal at a time per chat. In a group, the lead sets the group\'s goal from its group conversation: then the whole group works on it, the budget counts the bots\' messages (40 if left out), and AppuBot sends the lead on whenever the room goes quiet before it is done.',
    input: z.object({
      objective: z.string().min(1).max(2000).describe('What done looks like, in a sentence or two the user can check, e.g. "Every invoice in ~/Invoices is renamed by date and client, and a summary table is in invoices.md"'),
      max_turns: z.number().int().min(1).max(100).optional().describe('How many turns you think it takes, with a little room (20 if left out)'),
      hours: z.number().positive().max(24).optional().describe('A time limit in hours, if it should stop by then'),
    }),
  },
  finish_goal: {
    description: 'End the goal you are working on in this chat: status "done" once it is achieved (note: what you did, in a line or two), or "blocked" when you can\'t go on without the user (note: exactly what you need from them). Call it as soon as either is true; while the goal is on, AppuBot keeps sending you on after every turn.',
    input: z.object({
      status: z.enum(['done', 'blocked']),
      note: z.string().max(2000).optional().describe('Done: what you did. Blocked: what you need from the user.'),
    }),
  },
  send_message: {
    description: 'Send the user a short chat message right now, while you are still working: a bubble of its own in their chat, and the only thing they see from you before your turn ends. When a job will take a while (more than a few steps, or anything slow), send one line before you start saying what you are about to do, then a line at each real milestone, and at once when something blocks you. When the user writes to you mid-job, answer here in a line or two and carry on. Never for a quick task, and never a running commentary of your steps. Also for separate messages when the user asks for them. Write in the user\'s language, 500 characters at most; AppuBot turns down a repeat of your last message and more than a few in a row. It is not your answer: your reply at the end must be complete on its own, as if none of these had been sent.',
    input: z.object({ text: z.string().min(1).max(4000).describe('One to three plain sentences, 500 characters at most') }),
  },
  transcribe_audio: {
    description: 'Hear an audio or video file on this computer (a voice message or audio clip the user sent, saved in your inbox; a recording; a video\'s sound) and get its words. Use it whenever the user sends audio, before answering. Up to 3 minutes of sound, heard on this computer (nothing is uploaded).',
    input: z.object({
      path: z.string().describe('Absolute path of the file (in your home folder or the temp folder)'),
      language: z.string().optional().describe('The language spoken, as a code like "en" or "hi", if you know it; else it is detected'),
    }),
  },
  send_voice: {
    description: 'Send the user a voice message now, your text read aloud on this computer (their chat and Telegram). Use when they ask for a voice reply or a voice note, or when they talked to you by voice and a spoken answer fits. Plain sentences, no Markdown, under ~600 words. Your final text reply still arrives as usual: don\'t repeat it word for word.',
    input: z.object({
      text: z.string().min(1).max(VOICE_SPEAK_MAX_CHARS).describe('What to say, as plain spoken sentences'),
      caption: z.string().max(1000).optional().describe('A short line shown with the voice message'),
      language: z.enum(SpeechLanguage.options).optional().describe('The language of the text; else it is detected'),
    }),
  },
  notify_user: { description: `Show the user a notification on their ${MACHINE} and phone (short title + body). Use sparingly for important completions or when you are blocked.`, input: z.object({ title: z.string(), body: z.string().default('') }) },
  ask_user: { description: `Ask the user a question and wait for the answer (they may be away from the ${MACHINE}, e.g. on their phone or Telegram). Optionally provide choices. Blocks up to 10 minutes.`, input: z.object({ question: z.string(), options: z.array(z.string()).default([]) }) },
  ask_form: {
    description: `Ask the user to fill in a form: a card in their chat with the fields you list (text, a longer text, number, email, url, phone, date, time, a choice or several from options, an on/off toggle, a 1-to-N rating, a one-time code, a file they pick from their ${MACHINE} or phone), which they fill in and send (or decline), on the ${MACHINE} or their phone. Use it when you need several details at once (a booking's dates and guests, an invoice's fields, a profile), instead of asking one question after another; ask_user for a single question. A file field's value comes back as a path on this computer you can read. A code field is for a one-time code a site just sent the user (by text, email or their authenticator app): ask for it the moment the site wants it, since such codes run out in minutes. Never for passwords, card numbers or keys: use vault_request. Blocks up to 15 minutes.`,
    input: z.object({
      question: z.string().min(1).max(2000).describe('What the form is for, as a short title or question ("Details for the hotel booking")'),
      fields: z.array(z.object({
        id: z.string().min(1).max(40).describe('The key its value comes back under (e.g. "check_in")'),
        label: z.string().min(1).max(120),
        type: z.enum(['text', 'longtext', 'number', 'email', 'url', 'phone', 'date', 'time', 'choice', 'multichoice', 'toggle', 'rating', 'code', 'file']).default('text'),
        required: z.boolean().default(false),
        options: z.array(z.string().max(200)).max(20).optional().describe('For choice / multichoice'),
        placeholder: z.string().max(200).optional(),
        hint: z.string().max(300).optional().describe('A short line under the field'),
        value: z.string().max(4000).optional().describe('Filled in to start with (your best guess); dates as YYYY-MM-DD, times as HH:MM, a toggle "true", a rating "4"; never for a file'),
        max: z.number().int().min(2).max(10).optional().describe('rating: the top mark (5 when left out); code: how many characters the code has, 4 to 8 (6 when left out)'),
        accept: z.array(z.string().max(20)).max(20).optional().describe('file: the extensions it takes, like ["pdf", "csv"]; any file when left out'),
      })).min(1).max(20),
      submit: z.string().max(40).optional().describe('The send button\'s words, e.g. "Book it"'),
    }),
  },
  telegram_request: {
    description: 'Ask the user to connect a Telegram bot to you, on a card in the chat: they paste the bot token from @BotFather there (on their computer; it never reaches you), AppuBot starts the Telegram bot, and you get its @handle and the pairing code the user sends it as /pair <code> to be let in. Use it when the user wants to talk to you from Telegram and you have no Telegram bot yet. Blocks up to 15 minutes.',
    input: z.object({ reason: z.string().max(500).optional().describe('One line on why, shown on the card') }),
  },
  apps_request: {
    description: 'Ask the user to connect an app (Gmail, Slack, Notion… by its slug) to AppuBot, or to turn one already connected on for you, on a card in the chat with the button that does it: they sign in to the app in their browser, and the card settles once the app is yours. Use it when a task needs an app you don\'t have (apps_search says so, or you have no apps_ tools), instead of telling them to find it in settings. Blocks up to 15 minutes.',
    input: z.object({
      slug: z.string().min(1).max(80).describe('The app\'s slug: gmail, googlecalendar, slack, notion, github, googledrive, linear, googlesheets, outlook, hubspot, jira, discord… (as apps_search names them)'),
      reason: z.string().max(500).optional().describe('One line on what you need it for, shown on the card'),
    }),
  },
  remember: {
    description: "Save one durable fact to your long-term memory (MEMORY.md): about the user, how they like things done, their accounts, folders, people or ongoing projects. Every new thread starts with your memory, so this is how something outlives the current thread. One short fact per call (it is dated for you); never secrets. If an older entry says something else, change it with update_memory instead.",
    input: z.object({ text: z.string().describe('The fact, one short line, e.g. "Invoices go out from the ACME Ltd account in INR"') }),
  },
  update_memory: {
    description: 'Change one entry of your memory: the line containing `find` becomes `text` (dated today), or is removed when `text` is empty. Use it when a fact changed, to keep your memory short and free of contradictions.',
    input: z.object({
      find: z.string().min(1).describe('Words from the one entry to change, as it reads in your memory'),
      text: z.string().describe('The entry\'s new wording (one line); empty to remove it'),
    }),
  },
  forget: {
    description: 'Remove every entry of your memory that contains `text` (when the user asks you to forget something, or a project is over).',
    input: z.object({ text: z.string().min(1).describe('Words the entries to remove contain') }),
  },
  read_memory: {
    description: 'Read your whole memory (MEMORY.md). A new thread already starts with it (only its newest part when it is long), so you rarely need this.',
    input: z.object({}),
  },
  save_skill: { description: 'Save a reusable skill (markdown instructions for a repeatable task) so future sessions can follow it. Body is the SKILL.md content without frontmatter.', input: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/), description: z.string(), body: z.string() }) },
} as const;

/** The user's Vault: saved logins, cards, contact info and API keys a bot uses without seeing the secrets. */
export const vaultTools = {
  vault_list: {
    description: 'List what the user saved in their Vault: logins (site, username), cards (name, last 4 digits, expiry), contact info (in full) and API keys (variable name). Secrets never show here. Look here before asking the user for a login, a card, their address or an API key, and never ask them to type a password or card number into the chat.',
    input: z.object({ kind: z.enum(['login', 'card', 'contact', 'apiKey']).optional().describe('Only this kind') }),
  },
  vault_fill: {
    description: 'Type a field of a Vault item into an app window, as computer_type would, without you seeing it: a login\'s password or username, a card\'s number, security code (cvc), expiry or cardholder, or a contact field. Aim at the field by label or element (else the window\'s focused field). The first time an item\'s secret is used in a chat, the user is asked to allow it. Nothing of the window comes back: look at it afterwards if you need to.',
    input: z.object({
      id: z.string().describe('Item id from vault_list'),
      field: z.enum(['username', 'password', 'number', 'cvc', 'expiry', 'cardholder', 'fullName', 'email', 'phone', 'company', 'address1', 'address2', 'city', 'region', 'postalCode', 'country']),
      pid: z.number().int().describe('Process id of the app'),
      window_id: z.number().int().describe('Window id'),
      label: z.string().optional().describe('The field\'s accessibility label in the window'),
      element: z.string().optional().describe('Element [N] of the latest snapshot ("12")'),
    }),
  },
  vault_request: {
    description: 'Ask the user to add a login, card, API key or contact info to their Vault, on a card in the chat they fill in (or pick one they saved before). Use it when you need a password, card or key that vault_list doesn\'t have, instead of asking for it in the chat: what they type goes straight into the Vault, you never see a secret, and this chat may then use the item (vault_fill, vault_key) without asking again. You get the saved item back (its id and what isn\'t secret). Blocks up to 15 minutes.',
    input: z.object({
      kind: z.enum(['login', 'card', 'contact', 'apiKey']),
      name: z.string().min(1).max(80).describe('What to call it in the Vault ("GitHub", "Company Visa", "OpenAI")'),
      reason: z.string().max(500).optional().describe('One line on why you need it, shown on the card'),
      site: z.string().max(200).optional().describe('login: the site or app it is for'),
      username: z.string().max(200).optional().describe('login: the username, if you know it'),
      env_name: z.string().max(80).optional().describe('apiKey: the environment variable it goes in (OPENAI_API_KEY)'),
    }),
  },
  vault_key: {
    description: 'Get a saved API key into your private keys file (KEY=value lines, readable only on this computer): returns the file and the variable name. Load it where you need it (e.g. `set -a; . <file>; set +a` before a command, or dotenv in code) instead of printing it; never paste a key into the chat or into files you send. The first use in a chat asks the user.',
    input: z.object({ id: z.string().describe('API key id from vault_list') }),
  },
};

/**
 * Files on the user's own computer, for a bot on their AppuBot computer (the gateway sets APPUBOT_MAC_FILES to that
 * computer's name while one is linked): the folders the user lent there, read-only except those the user switched to
 * take changes (`mac_files_put`). What may be read or saved is decided on that computer; these only ask.
 */
export function macFilesTools(mac: string) {
  return {
    mac_files_list: {
      description: `Look at the files on the user's own computer, ${mac}: with no path, the folders they lent you there (and which of them take your changes: the rest are read-only); with a path, what is in that folder (name, full path, size, when it changed). Only inside those folders. It answers only while ${mac} is on with AppuBot open: if it doesn't, tell the user rather than guessing.`,
      input: z.object({ path: z.string().max(2048).optional().describe('A folder\'s full path, as an earlier listing showed it. Leave out to see the lent folders.') }),
    },
    mac_files_find: {
      description: `Find files or folders on ${mac} by name: every one whose name has the words in it, under a folder or under everything lent. Use it when you know roughly what a file is called but not where it is.`,
      input: z.object({
        query: z.string().min(1).max(200).describe('Part of the name, e.g. "invoice" or ".xlsx"'),
        path: z.string().max(2048).optional().describe('Look only under this folder (its full path)'),
      }),
    },
    mac_files_get: {
      description: `Copy one file from ${mac} to this computer so you can read it: it lands in your inbox/mac/ folder and you get its path here. One file at a time, up to 100 MB. The copy is yours to work on; the original on ${mac} only changes if you save it back with mac_files_put.`,
      input: z.object({ path: z.string().min(1).max(2048).describe('The file\'s full path on that computer, as a listing or a search showed it') }),
    },
    mac_files_put: {
      description: `Save a file on ${mac}, only in a folder the user lets bots change there (mac_files_list with no path marks those; every other folder is read-only and refuses). Give the full path on ${mac} and either \`from\`, a file in your own folder here (e.g. the copy mac_files_get brought into inbox/mac/, after you edited it), or \`text\` for a short text file. A new file is made (with any missing folders in it); an existing one is replaced, and its old version goes to the Trash on ${mac}, so the user can put it back. It can't delete, rename or move anything, nor touch hidden files (.git, .env). Save there only what the user asked you to change, and tell them what you saved.`,
      input: z.object({
        path: z.string().min(1).max(2048).describe('Where on that computer: the full path of the file, inside a folder that takes changes'),
        from: z.string().min(1).max(4096).optional().describe('A file in your own folder here to save there (full path, or relative to your folder)'),
        text: z.string().max(1024 * 1024).optional().describe('Or the whole text of the file, for a short text file'),
      }),
    },
  };
}

/*
 * The user's connected apps (Gmail, Slack, GitHub…, through their own Composio account), limited to the ones this
 * bot may use: AppuBot checks every call. Connecting apps happens in AppuBot → Apps, never from a chat.
 */
export const appsTools = {
  apps_search: {
    description: 'Find the tools for a task in the user\'s connected apps (Gmail, Slack, GitHub, Notion, Google Calendar…): call it first whenever a request involves one of their apps or online accounts. It lists the apps you may use, then per query the recommended plan, its pitfalls, the tools (tool slugs like GMAIL_SEND_EMAIL) with their input schemas, and whether each app is connected. Split independent actions into separate queries, at most 7 in one call.',
    input: z.object({
      queries: z.array(z.object({
        use_case: z.string().min(1).max(1024).describe('The task in plain English, with the app if the user named one, e.g. "send an email with gmail", "list open issues in a github repo". No personal details here: put them in known_fields'),
        known_fields: z.string().optional().describe('Known inputs as comma-separated key:value pairs, e.g. "channel_name:general" or "repo:acme/web"'),
      })).min(1).max(7),
    }),
  },
  apps_tool_schemas: {
    description: 'The full input schemas of app tools by slug (from apps_search), when apps_search didn\'t include one. Never guess slugs.',
    input: z.object({ tool_slugs: z.array(z.string().min(1)).min(1).max(50) }),
  },
  apps_execute: {
    description: 'Run app tools found with apps_search: up to 50 at once when they don\'t depend on each other (run dependent ones in order, one call after another). Pass each tool\'s arguments exactly as its schema says. Sending, posting, deleting or paying acts in the user\'s real accounts: do it only when the user asked for it, and check the details (recipients, amounts, channels) first. When the user has several accounts of an app, apps_search lists them and says which is the default: a tool runs on the default unless you name another in its `account`. Ask for no more than you need (a limit, only the fields you want): an answer too large to return comes back as a preview plus `full_answer.path`, a JSON file in your folder holding all of it, to read with your own tools.',
    input: z.object({
      tools: z.array(z.object({
        tool_slug: z.string().min(1).describe('A tool slug from apps_search, e.g. GMAIL_SEND_EMAIL'),
        arguments: z.record(z.string(), z.unknown()).describe('The tool\'s arguments, as its input schema says'),
        account: z.string().optional().describe('Which account, when the app has several: its address, name or id as apps_search lists it (e.g. "me@work.com"). Left out, the default account is used'),
      })).min(1).max(50),
      thought: z.string().optional().describe('One sentence: why these tools'),
    }),
  },
} as const;

/*
 * A bot looking after itself and the other bots on this Mac. No bot_id means the calling bot. Ids come from list_bots
 * (names may repeat). The fields a bot may change leave out anything that grants abilities, and another bot's job or
 * instructions change only once the user allows it.
 */
const botId = z.string().optional().describe('Bot id from list_bots; leave it out for yourself');

const SHAPES = BotShape.options.join(', ');
const COLORS = BOT_COLORS.map((c, i) => `${BOT_COLOR_NAMES[i]} ${c}`).join(', ');

export const botTools = {
  list_bots: {
    description: 'List every bot on this ' + MACHINE + ', you included (isYou): id, name, job, the agent it runs on, and what each is doing now (status, last message). Use the ids with get_bot, update_bot and read_bot_history; names may repeat.',
    input: z.object({}),
  },
  get_bot: {
    description: "Look at a bot's whole setup: name, look (shape and colour, or the character it wears, and the user's characters it could wear), job, instructions, the agent it runs on (Claude Code, Codex, a profile of one…), model, reasoning effort, fast mode, permission mode, computer use and the apps it may use; plus what it could switch to (agents, models, efforts, modes, whether its model offers fast mode) and the agent new bots start on. Leave bot_id out to see your own. Check it before telling the user what you can change: these are the only settings a bot has.",
    input: z.object({ bot_id: botId }),
  },
  update_bot: {
    description: `Change a bot's setup: yourself (leave bot_id out) as you learn what the user wants, or another bot (bot_id from list_bots) when the user asks. Only the fields you send change. A bot's avatar is a small robot: its look is a shape and a colour (no emoji, no picture), or one of the user's own characters (get_bot lists them; only the user makes new ones, in the bot's settings). What gives a bot more power waits for the user's "Allow" on a card in your chat that lays each change out (what it was, what it becomes): turning computer use or an app on, Bypass permissions, running on another agent, and another bot's name, job or instructions (keep a job under 300 characters and instructions under 4000, so they can read all of it). Looks, models, efforts, fast mode, other modes and turning things off apply at once. instructions replace the bot's whole instructions: write them to the bot ("You …"), saying what the user wants, and keep what still applies. The bot's CLAUDE.md is rewritten at once; its agent picks the change up at the start of its next turn (a new agent starts a fresh session; its chats stay).`,
    input: z.object({
      bot_id: botId,
      name: z.string().min(1).max(60).optional(),
      shape: z.enum(BotShape.options).optional().describe(`Avatar shape: ${SHAPES}`),
      character_id: z.string().optional().describe('A character id from get_bot\'s characters, worn instead of the shape; "" takes it off'),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe(`Avatar colour as #RRGGBB: ${COLORS}, or any other`),
      job: z.string().max(300).optional().describe('One line: what the bot is for, e.g. "Keeps the books for the bakery"'),
      instructions: z.string().optional().describe('How the bot should work, written to it ("You …"): the user\'s preferences, tone, accounts, folders, routines'),
      agent_id: z.string().optional().describe('An agent id from get_bot\'s agents: Claude Code, Codex, a profile (another account) of one…'),
      model_id: z.string().optional().describe('One of the model ids get_bot lists for that bot'),
      effort: z.string().optional().describe('One of the reasoning efforts get_bot lists (e.g. low, medium, high)'),
      fast: z.boolean().optional().describe('Fast mode: faster replies, on models that offer it (get_bot\'s fastAvailable; Claude Code only)'),
      mode_id: z.string().optional().describe('One of the permission modes get_bot lists (e.g. default = ask permissions, auto, bypassPermissions)'),
      computer_use: z.boolean().optional().describe(`Let the bot use the ${MACHINE}'s apps (screen, mouse, keyboard)`),
      apps_on: z.array(z.string()).optional().describe('App slugs (from get_bot\'s apps) to let the bot use'),
      apps_off: z.array(z.string()).optional().describe('App slugs to stop the bot using'),
    }),
  },
  create_bot: {
    description: 'Make a new bot on this ' + MACHINE + ' (a teammate with its own job, chats, memory and folder) when the user asks for one. It shows the user a card in your chat with how the bot would look and be set up and waits for their "Allow"; they may rename it there, so use the name the result gives. Give it a clear job and instructions written to it ("You …"); it starts without computer use unless you ask for it, on the agent new bots start on unless you pick one. It does not greet anyone: tell the user it is ready in the sidebar.',
    input: z.object({
      name: z.string().min(1).max(60),
      job: z.string().max(300).optional(),
      instructions: z.string().max(4000).optional(),
      shape: z.enum(BotShape.options).optional().describe(`Avatar shape: ${SHAPES}`),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe(`Avatar colour as #RRGGBB: ${COLORS}`),
      agent_id: z.string().optional().describe('An agent id from get_bot\'s agents'),
      computer_use: z.boolean().optional(),
    }),
  },
  react: {
    description: 'React with an emoji to the user\'s latest message in this chat (or message_id), like in a messaging app: 👍 when you got it, ❤️ for thanks, 😂 for a joke, 🎉 for good news. Use it sparingly and alongside your reply, never instead of one. emoji null takes your reaction back. The user can react to your replies too; you hear about it at the start of your next turn.',
    input: z.object({ emoji: z.string().min(1).max(16).nullable(), message_id: z.string().optional() }),
  },
  read_bot_history: {
    description: "Read a bot's threads with the user as text, all of them as one history, a page at a time from the newest message back (tool calls summarised in one line each, no images or file contents): e.g. an earlier thread of yours the user refers to, or what went wrong before you fix a bot's instructions. Leave bot_id out for your own. To read further back, pass the `before` cursor from the previous result.",
    input: z.object({
      bot_id: botId,
      before: z.string().optional().describe('Cursor from the previous read_bot_history result, to read the messages before it'),
      limit: z.number().int().min(1).max(100).default(30).describe('How many messages'),
    }),
  },
  message_bot: {
    description: 'Send a message to another bot on this ' + MACHINE + ' (by name or id from list_bots) and, by default, wait for its reply: it lands in that bot\'s own chat as a message from you (the user sees it there), it does the work with its own tools and its whole reply comes back to you. Use it to hand a bot work in its area, ask it what it knows, or get a second opinion; write the message as a clear request with everything it needs (it can\'t see your chat). wait=false sends and moves on (the reply stays in its chat for the user). Don\'t message back and forth: after a few exchanges AppuBot stops the loop and asks you to tell the user.',
    input: z.object({
      bot: z.string().min(1).describe("The bot's name or id"),
      text: z.string().min(1).max(20000),
      wait: z.boolean().optional().describe('Wait for the reply (default true); false sends and moves on'),
    }),
  },
  message_bots: {
    description: 'Only for a bot the user marked as chief: send one message to every other bot at once (or to bot_ids) and get all their replies together. Use it for a roll call ("what are you working on?"), a notice everyone needs, or to spread a task; message_bot is for one bot.',
    input: z.object({
      text: z.string().min(1).max(20000),
      bot_ids: z.array(z.string()).optional().describe('Only these bots (ids from list_bots); every other bot when left out'),
      wait: z.boolean().optional().describe('Wait for the replies (default true)'),
    }),
  },
  list_groups: {
    description: 'The groups you are in (every group, for a chief): bots that talk with each other in a room of their own to get work done together, each with its members and who leads it. The user makes groups in AppuBot; a message in a group reaches the bots it names with @Name, else the lead (the user\'s messages) or everyone (the lead\'s).',
    input: z.object({}),
  },
  post_to_group: {
    description: 'Post a message to a group you are in (by name or id from list_groups), from your own chat: to hand the group work, ask a member something (@Name) or tell everyone (a lead\'s message with no @Name reaches every member). In a group conversation you don\'t need this: your reply is posted to the room by itself.',
    input: z.object({ group: z.string().min(1).describe("The group's name or id"), text: z.string().min(1).max(20000) }),
  },
  create_group: {
    description: 'Make a group of bots when the user asks for one ("have Ada, Bo and Cy work on the launch together"): it waits for the user\'s "Allow" in your chat. Pick a lead (a chief bot) when the group needs someone to split the work; the user\'s messages to the group go to the lead, who addresses members with @Name.',
    input: z.object({
      name: z.string().min(1).max(80),
      bot_ids: z.array(z.string()).min(1).max(20).describe('Member ids from list_bots (yourself included, if you should be in it)'),
      lead_id: z.string().optional().describe('The member that leads it (a chief bot); the first chief member when left out'),
    }),
  },
  list_routines: {
    description: "Your routines (or another bot's with bot_id): prompts that run on a schedule in your current chat, as if the user sent them. Each with its id, schedule (cron and in words), whether it is on, and where its results go.",
    input: z.object({ bot_id: botId }),
  },
  create_routine: {
    description: 'Set up a routine when the user wants something done regularly ("every morning summarise my inbox", "remind me on Fridays at 6"). It shows the user a card in the chat with the schedule as fields (they may adjust the time or days there) and waits for their "Allow"; the result tells you the schedule as allowed. The prompt is sent to you on schedule, as if the user wrote it, so write it as their request ("Summarise my unread email from the last day…"). schedule is a cron expression in the ' + MACHINE + '\'s local time: minute hour day-of-month month day-of-week, e.g. "0 9 * * *" every day 9:00, "30 8 * * 1-5" weekdays 8:30, "0 18 * * 5" Fridays 18:00, "0 7 1 * *" the 1st of each month 7:00, "0 * * * *" every hour. deliver_to "notify" (default) pings the user when it is done; "thread" just keeps the result in the chat. Tell the user when it will first run.',
    input: z.object({
      name: z.string().min(1).max(80).describe('Short name shown in the Routines panel'),
      prompt: z.string().min(1).max(4000),
      schedule: z.string().min(9).describe('Cron, local time: minute hour day-of-month month day-of-week'),
      deliver_to: z.enum(['notify', 'thread']).optional(),
      bot_id: botId,
    }),
  },
  update_routine: {
    description: 'Change a routine (id from list_routines): its name, prompt, schedule (cron), on/off, or where results go. A new prompt or schedule, or turning it on, waits for the user\'s "Allow" on a card that lays the change out, where they may adjust the schedule (use what the result says); renaming, turning it off and deliver_to apply at once.',
    input: z.object({
      routine_id: z.string(),
      name: z.string().min(1).max(80).optional(),
      prompt: z.string().min(1).max(4000).optional(),
      schedule: z.string().min(9).optional(),
      enabled: z.boolean().optional(),
      deliver_to: z.enum(['notify', 'thread']).optional(),
    }),
  },
  delete_routine: {
    description: 'Remove a routine (id from list_routines) when the user no longer wants it. It stops running.',
    input: z.object({ routine_id: z.string() }),
  },
} as const;
