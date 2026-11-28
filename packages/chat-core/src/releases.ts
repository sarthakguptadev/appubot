import type { ReleaseNotes } from './whatsNew';

/**
 * What's new, newest first: shown once after an update (the desktop's sidebar card, then the dialog), listed in
 * Settings › What's new, and on the website's /releases page (only versions already published there). Add the next
 * release's notes under the date it should ship (or earlier: an installed version shows the newest notes at or below
 * it), in plain words for users, like the release page's `Changelog:` lines.
 * The first feature is the one the card shows.
 */
export const RELEASES: readonly ReleaseNotes[] = [
  {
    version: '2026.1128.4',
    features: [
      {
        id: 'chief-star-badge',
        title: 'A gold star for your chief',
        description: 'Your chief bot wears a small gold badge with a white star on the corner of its avatar, in the app, on its cursor and as its Telegram picture. It replaces the crown.',
      },
      {
        id: 'flat-bots',
        title: 'A cleaner look for your bots',
        description: 'Bots are now one flat colour, with no shading, and still turn, nod and move in 3D as before. New bots’ orange is a slightly deeper shade.',
      },
    ],
  },
  {
    version: '2026.1128.3',
    features: [
      {
        id: 'chief-crown',
        title: 'A crown for your chief',
        description: 'Your chief bot wears a gold crown on its avatar, in the app, on its cursor and as its Telegram picture. In the app the crown turns with the bot’s head.',
      },
      {
        id: 'settings-own-pages',
        title: 'Settings pages of their own',
        description: 'Vault, Usage, Instructions, Permissions and What’s new each have their own entry in the Settings sidebar instead of sitting behind tabs on another page.',
      },
      {
        id: 'side-panel-per-bot',
        title: 'The side panel stays where you left it',
        description: 'Opening the side panel on one bot no longer opens it on every bot. Switching bots closes it, and it stays closed when you come back.',
      },
      {
        id: 'phone-app-code',
        title: 'Get AppuBot on your phone',
        description: 'Get AppuBot for mobile in the account menu shows a code to scan with your phone’s camera, with the App Store and Google Play buttons under it.',
      },
      {
        id: 'tidier-menus',
        title: 'A tidier account menu, chat and About',
        description: 'The account menu no longer shows your plan’s usage (Settings › Usage has it), the “is using an app” bar above the message box is gone, and Settings › About shows the app’s name, version and update status in a cleaner card.',
      },
    ],
  },
  {
    version: '2026.1128.2',
    features: [
      {
        id: 'bot-screen-desktop',
        title: 'Every bot’s screen is a full desktop',
        description: 'On AppuBot Cloud, each bot’s own screen now shows the same desktop as your cloud computer, with the wallpaper and the dock at the bottom, instead of a black screen.',
      },
      {
        id: 'simpler-screen-view',
        title: 'A simpler screen view',
        description: 'A bot’s Computer tab shows just its screen. Expand opens it straight to full size, with Take control under the screen and Esc to go back, and Watch in a chat opens that bot’s own screen.',
      },
      {
        id: 'screen-try-again',
        title: 'Try again when a screen can’t start',
        description: 'If a bot’s screen can’t start, the viewer says so and offers Try again, instead of reconnecting over and over.',
      },
    ],
  },
  {
    version: '2026.1128.1',
    features: [
      {
        id: 'new-look-1127',
        title: 'A fresh new look',
        description: 'AppuBot has a cleaner, roomier look: pinned bots are tiles in the sidebar, chats are wider and a bot’s messages group together, the message box is slimmer, and search, menus and dialogs open the moment you ask for them.',
      },
      {
        id: 'avatars-3d',
        title: 'Bots in 3D',
        description: 'Bot avatars are now 3D characters. The round bot is a shaded ball that turns to look at your pointer, glances about, spins and flips while it works, and does a little happy dance when it’s done.',
      },
      {
        id: 'new-settings',
        title: 'A new Settings',
        description: 'Settings opens over your chats as its own window, with one search box that finds any setting, rounded cards, larger text and blue switches. Esc or a click outside closes it.',
      },
      {
        id: 'custom-connectors',
        title: 'Add your own connectors',
        description: 'In Settings › Apps you can add your own MCP servers, remote or on this computer, or paste a config from another app. Your bots can use their tools, and you choose which bots get each one and which tools are on.',
      },
      {
        id: 'bot-screens',
        title: 'A screen for each bot',
        description: 'On AppuBot Cloud every bot gets a screen of its own, so several bots can use the cloud computer at once. A bot’s Computer tab shows its screen live, with Take control and Full size.',
      },
      {
        id: 'media-in-chat',
        title: 'Audio, video and pictures in chat',
        description: 'Songs, recordings and clips play right in the chat in AppuBot’s own player, with their real length, a scrubber and Open or Download. Pictures show as themselves in a rounded box, and the ones you send sit right over your message.',
      },
      {
        id: 'what-its-doing',
        title: 'See what a bot is doing',
        description: 'While a bot works, its chat says what it is doing right now, like “Reading report.md” or “Searching the web”, and “Working” shows the moment you send.',
      },
      {
        id: 'new-replies',
        title: 'New replies stand out',
        description: 'Pinned bots show a blue dot when they have a reply for you, and a chat marks where its new replies begin.',
      },
      {
        id: 'clearer-questions',
        title: 'Clearer questions',
        description: 'When a bot asks you something, its options are lettered A, B, C and fold to the one you pick, and the message box tells you that typing answers it.',
      },
      {
        id: 'several-messages',
        title: 'Several messages in a row',
        description: 'Bots can send as many separate messages in a row as you ask for.',
      },
    ],
  },
  {
    version: '2026.1126.2',
    features: [
      {
        id: 'add-account',
        title: 'Add another account',
        description: 'Connect apps now shows the account each app is signed in with, and an Add another account button under it. Adding a second Gmail, or a second account of any app, now opens its sign-in instead of doing nothing.',
      },
      {
        id: 'apps-search',
        title: 'Better app search',
        description: 'Search in Connect apps finds an app by several words at once, such as “send email”, and by its category, such as “CRM”.',
      },
    ],
  },
  {
    version: '2026.1126.1',
    features: [
      {
        id: 'mid-job-notes',
        title: 'Bots keep you posted',
        description: 'During a long job a bot now tells you what it is doing in a short line or two, and answers a question you ask mid-job without dropping the job. Where an AI can’t read a message mid-job, yours waits until it finishes instead of cutting the job short, and the chat says so.',
      },
      {
        id: 'follow-ups',
        title: 'Next steps under a reply',
        description: 'The suggestions under a bot’s reply are no longer the same five every time: you get two to five that still apply. A bot can add next steps of its own too, such as “Email it to the team”. Tap one to send it.',
      },
      {
        id: 'several-accounts',
        title: 'Several accounts of one app',
        description: 'Connect two Gmails, or a second account of any app, and the first one stays. Both are listed under Connect apps, you choose which is the default, and you can tell a bot which account to use.',
      },
      {
        id: 'apps-popup',
        title: 'Connect apps opens over your chat',
        description: 'Connect apps is now a popup instead of a separate page, so your chat stays where it was. Your connected apps are inside it, one click away.',
      },
      {
        id: 'opencode-tools',
        title: 'OpenCode bots get AppuBot’s tools',
        description: 'Bots on OpenCode 2.2 or later can now use the computer, send files and pages to the chat, ask you questions, and reach your connected apps, the vault, memory and goals. OpenCode 2 had hidden these from the bot.',
      },
      {
        id: 'round-rows',
        title: 'Rows and menus are round too',
        description: 'Rows, menus and icon tiles now match the round buttons: pills and circles with Shape set to Round, and as before with Squircle. Small boxes with tight corners now have the same corner as cards.',
      },
      {
        id: 'segmented-keys',
        title: 'Arrow keys in Settings',
        description: 'In Settings, the arrow keys move between the choices of a setting, and Home and End jump to the first and the last.',
      },
      {
        id: 'steadier-connect',
        title: 'Quicker to notice a lost connection',
        description: 'After your computer wakes or changes network, AppuBot Connect notices a dead connection within seconds instead of sometimes taking most of a minute. When bots hand a task back and forth quickly, their messages stay in the order they were written.',
      },
      {
        id: 'cloud-payment-day',
        title: 'A payment that didn’t go through',
        description: 'When a payment for AppuBot Cloud doesn’t go through, the app now says your bots and files are kept for one day and then deleted, with the date.',
      },
      {
        id: 'clearer-words',
        title: 'Clearer words',
        description: 'Thirteen apps under Connect apps have new descriptions, and the note for a thread that has grown too long for its model says more plainly what to do.',
      },
      {
        id: 'apache-licence',
        title: 'Open source under Apache 2.0',
        description: 'AppuBot’s code, every version from the first release on, is now available under the Apache License 2.0.',
      },
    ],
  },
  {
    version: '2026.1124.2',
    features: [
      {
        id: 'bot-handoff',
        title: 'Hand a task to another bot',
        description: 'In any chat, write @Ledger and the task goes to Ledger, which answers right there in the same chat. Bots can pass work on to each other too, and stop after a few hand-offs until you write again.',
      },
      {
        id: 'mention-menu',
        title: 'Pick a bot with @',
        description: 'Type @ in a chat or a group and a list of your bots opens where you are typing. Keep typing to narrow it, and press Enter to pick one.',
      },
      {
        id: 'smarter-palette',
        title: 'A smarter ⌘K',
        description: 'The ⌘K palette finds what you mean from the start of each word, forgives a typo, shows what matched in bold and remembers what you picked. It also searches your open chats’ messages, and lets you switch theme, model or reasoning effort without leaving it.',
      },
      {
        id: 'round-controls',
        title: 'Round all over',
        description: 'Buttons, fields and chips across the app are now fully round. Prefer the old corners? Pick Squircle in Settings › Appearance.',
      },
      {
        id: 'agents-anywhere',
        title: 'Every agent, one click',
        description: 'Codex, Copilot and OpenCode now install without Node.js, and Claude Code, Cursor and Grok with their makers’ own installers, on Mac, Windows and Linux. Sign in with your Claude, ChatGPT, GitHub, Cursor or Grok account right inside AppuBot.',
      },
      {
        id: 'windows-fixes',
        title: 'Better on Windows',
        description: 'Lending folders to another computer now works on Windows, and the usage page counts your bots’ requests as theirs.',
      },
      {
        id: 'quick-motion',
        title: 'Quicker, quieter motion',
        description: 'Menus and the side panel open at once. Settings, dialogs, popovers and tooltips fade in quickly, and tabs and lists change in place without sliding.',
      },
      {
        id: 'computer-menu',
        title: 'A tidier computer menu',
        description: 'The computer menu at the top of the sidebar now lists just your computers. Settings is still at the bottom of the sidebar.',
      },
      {
        id: 'cloud-one-day',
        title: 'An ended cloud plan',
        description: 'When a cloud plan ends, its computer is now kept for one day before it is deleted, so download anything you need right away.',
      },
    ],
  },
  {
    version: '2026.1124.1',
    features: [
      {
        id: 'apps-at-once',
        title: 'Apps open at once',
        description: 'The Apps page shows your connected apps and the catalog straight away, then checks for changes behind them. The Connect apps button’s logos come with AppuBot, so they show without waiting.',
      },
      {
        id: 'connect-after-wake',
        title: 'Back in touch after a wake',
        description: 'After your computer wakes or changes network, AppuBot reconnects to AppuBot Connect right away when the link went quiet, so your phone reaches it sooner.',
      },
    ],
  },
  {
    version: '2026.1123.1',
    features: [
      {
        id: 'voice-call-card',
        title: 'A simpler voice call',
        description: 'The menu bar voice call is now one small card: your bot, what it is doing, a level meter for whoever speaks, and Mute, Transcript, Settings and End.',
      },
      {
        id: 'device-room',
        title: 'Make room for a new device',
        description: 'When your AppuBot computer has no free place for another device, you can remove one right there instead of getting stuck.',
      },
      {
        id: 'calm-launch',
        title: 'A calmer start',
        description: 'AppuBot no longer flashes the wrong computer for a moment when it opens.',
      },
    ],
  },
  {
    version: '2026.1118.1',
    features: [
      {
        id: 'new-look',
        title: 'A fresh new look',
        description: 'Chats read like text messages, the app is set in Geist, and Settings › Appearance has eight backgrounds and round or squircle buttons. The window opens at a comfortable size and comes back the way you left it.',
      },
      {
        id: 'bot-panel',
        title: 'Set up a bot from its side panel',
        description: 'Click a bot’s name at the top of the chat for its threads, its computer and everything else under Advanced. Change its look, name and job in place; memory and instructions save as you type. New bots get a name to start with, 18 shapes, and a look made from your own image or drawn for you, then set themselves up in a short first chat.',
      },
      {
        id: 'fixes-in-place',
        title: 'Problems you can fix in place',
        description: 'When a reply can’t finish, you get a card that says why, with the fix right there: pick another model, sign in or try again. A free model that has been retired is swapped for one that works and your message is answered anyway.',
      },
      {
        id: 'files-inside',
        title: 'Files open inside AppuBot',
        description: 'Pictures, clips, sounds, documents, tables and your bots’ pages open in the app, the Files tab sorts them by kind, and files you attach show what they are before you send.',
      },
      {
        id: 'more-apps',
        title: 'More apps to connect',
        description: 'PayPal, Zapier, Fastmail, WordPress.com, Help Scout and more now connect on this computer: you sign in with your own account there, nothing else needed.',
      },
      {
        id: 'chat-extras',
        title: 'A new thread starts with a hello',
        description: 'Your bot opens each new thread itself, ideas to try show under its replies, and a mic beside the send button types what you say.',
      },
      {
        id: 'update-card',
        title: 'Updates show in the sidebar',
        description: 'When a new version of AppuBot is downloading or ready, a small card above Settings says so, with Restart right there.',
      },
    ],
  },
  {
    version: '2026.1116.2',
    features: [
      {
        id: 'app-own-on-cloud',
        title: 'Updates and notifications work on a cloud computer too',
        description: 'With your cloud computer on screen, Settings › About now shows AppuBot’s own update and lets you check for one, and Settings › General has this Mac’s desktop notifications and Open at login again. Your colour scheme no longer changes when you switch computers.',
      },
      {
        id: 'update-waits',
        title: 'An update waits while you use a cloud computer',
        description: 'A downloaded update used to restart AppuBot moments after you looked away, even if you had just written to a bot on your cloud computer. It now waits until you have left the app alone for a couple of minutes.',
      },
    ],
  },
  {
    version: '2026.1116.1',
    features: [
      {
        id: 'faster',
        title: 'A faster, lighter AppuBot',
        description: 'AppuBot opens sooner, chats open and switch faster, and a reply that is streaming in takes about half the work to draw. Scrolling up through a long chat now loads older messages as you go, without stopping at the top or jumping.',
      },
      {
        id: 'cloud-card-art',
        title: 'A painting on the cloud card',
        description: 'The AppuBot Cloud card in the sidebar now carries a small twilight painting of a river under a cloud with AppuBot’s face.',
      },
    ],
  },
  {
    version: '2026.1115.2',
    features: [
      {
        id: 'cloud-only',
        title: 'Let your bots work only in the cloud',
        description: 'If you have a cloud computer, Settings › Account › Where your bots work lets you choose “Only in the cloud”. This Mac then stops running routines and Telegram for its bots, and AppuBot opens on your cloud computer. Nothing is deleted, and you can switch back any time.',
      },
      {
        id: 'transfer-more',
        title: 'Transfer brings your groups, and fits bigger bots',
        description: 'Settings › Transfer now brings your groups over with their members, lead and model. A bot too big to send in one go leaves its heaviest part out by itself and tells you which, instead of failing with “request too large”.',
      },
      {
        id: 'mac-save',
        title: 'Bots on your cloud computer can save to your Mac',
        description: 'Each folder you lend from this Mac has a new switch, “Bots can save changes here”. With it on, a bot on your cloud computer can add or replace files there; the version it replaces goes to the Trash. It is off until you turn it on.',
      },
      {
        id: 'routine-lines',
        title: 'Routines no longer fill the chat',
        description: 'A routine’s run is now one small line you can open, not a message bubble. Runs with nothing new fold into a single line, don’t notify you and don’t mark the chat unread.',
      },
      {
        id: 'work-trail',
        title: 'See what your bot is doing',
        description: 'Settings › Appearance › Chat shows › Everything adds a trail above each reply: the files it read, the commands it ran and what it thought, folded away once the reply is done.',
      },
      {
        id: 'pin-groups',
        title: 'Pin your groups',
        description: 'Right-click a group and choose Pin to top to keep it with your pinned bots. The + button offers New bot and New group straight away.',
      },
      {
        id: 'reactions-answered',
        title: 'A reaction always gets an answer',
        description: 'React to a reply and your bot answers with a short line or a reaction of its own, even when it was asleep or busy.',
      },
      {
        id: 'github-known',
        title: 'Bots use the GitHub sign-in you brought over',
        description: 'Bots on your cloud computer know git is already signed in to GitHub there and no longer ask you for a token.',
      },
      {
        id: 'tidier-look',
        title: 'A tidier look',
        description: 'The chat’s title sits in a small box centred over the message box, Settings › Storage shows what takes the space at a glance, an empty chat has a dotted backdrop, Settings has “Back to app” at its bottom left, and Settings › About lists the credits.',
      },
    ],
  },
  {
    version: '2026.1115.1',
    features: [
      {
        id: 'cloud-vault',
        title: 'Bring your logins and keys to your cloud computer',
        description: 'Your cloud computer now locks its Vault with a key of its own that its bots can’t reach. Settings › Transfer can bring over the logins, API keys and contact info saved on this Mac, and Settings › Vault there can import the passwords saved in your browser.',
      },
      {
        id: 'quiet-working',
        title: 'A quieter working line',
        description: 'While a bot works, the chat shows just “Working” and how long it has been, not the commands it runs.',
      },
      {
        id: 'same-corners',
        title: 'The same soft corners everywhere',
        description: 'The lines above the message box, the find bar, tags and chips now have the same soft square corners as the rest of the app.',
      },
    ],
  },
  {
    version: '2026.1114.4',
    features: [
      {
        id: 'import-bots',
        title: 'Bring your bots from another assistant',
        description: 'Settings › Import brings over the bots you keep in Grok Bot, dots, Muse, OpenBot, MausBot, OpenClaw, Hermes Agent or Manus. Pick where they are now, send that assistant the message AppuBot gives you, and choose the file it answers with. Each bot arrives with its instructions, what it remembers and its skills, and its routines come along switched off so you can turn on the ones you want.',
      },
      {
        id: 'fresh-look',
        title: 'A fresh, softer look',
        description: 'Buttons and controls have soft square corners, presses and menus move more smoothly, and code blocks, memory, instructions and skills now sit in the same clear card with colours that follow your bot. Pictures fade in, voice notes glow while they play, and while a bot works you can see what it is doing right now.',
      },
      {
        id: 'settings-full-window',
        title: 'Settings, simpler',
        description: 'Settings now fills the window, with Back at the top left, one list without headings, a search button and the computer switcher right at the top.',
      },
      {
        id: 'cloud-first-visit',
        title: 'Move your bots to your cloud computer',
        description: 'The first time you open your cloud computer, AppuBot asks whether your bots should work only there or on both, and moves or copies them over with their memory, skills, files, chats and routines. Nothing is deleted from your Mac.',
      },
      {
        id: 'cloud-carry',
        title: 'Your GitHub and your files on your cloud computer',
        description: 'Settings › Transfer can now also set up git with your GitHub sign-in on your cloud computer, and let the bots there read folders you choose on this Mac while it is on, without moving your files.',
      },
      {
        id: 'import-passwords',
        title: 'Import your passwords',
        description: 'Settings › Vault can import the passwords you export from Chrome, Safari, Firefox, 1Password, Bitwarden, LastPass or Dashlane, so your bots can sign in for you without ever seeing them.',
      },
      {
        id: 'group-bubbles',
        title: 'Group chats look like your other chats',
        description: 'Messages in a group now sit in the same bubbles as a chat with one bot, each bot\'s name in its colour above its first message.',
      },
      {
        id: 'quit-normally',
        title: 'Quit like any other app',
        description: 'Cmd+Q now quits AppuBot straight away. It only asks first while a bot is still working.',
      },
    ],
  },
  {
    version: '2026.1114.3',
    features: [
      {
        id: 'voice-whole-sentences',
        title: 'A voice that finishes its sentences',
        description: 'In voice mode, a long sentence was cut in two before it was read, so you heard a line end, a pause, and a new line start in the middle of a thought. A sentence is now read whole, or paused only where there is a comma. You will notice it most with the free models, which write longer sentences.',
      },
      {
        id: 'voice-just-answers',
        title: 'Bots just answer when you speak',
        description: 'On the free models, a bot sometimes replied by talking about voice mode itself, like "your voice message came through". It now simply answers what you said.',
      },
    ],
  },
  {
    version: '2026.1114.2',
    features: [
      {
        id: 'cloud-computer-tidier',
        title: 'A tidier cloud computer',
        description: 'Groups from this computer no longer show up on your cloud computer, and the yellow dot on Settings no longer appears every time you open AppuBot there. It now shows only when the connection has really been down for a while.',
      },
      {
        id: 'cloud-name-fits',
        title: 'The computer name always fits',
        description: 'When there is little room at the top of the sidebar, your cloud computer now reads "Cloud" instead of a name cut off with dots. The menu still shows the full name.',
      },
      {
        id: 'control-says-you',
        title: 'Giving control back reads right',
        description: 'After you give the cloud computer\'s screen back to your bots, AppuBot no longer says for a moment that your email address has control. Other people watching see your name, not your email.',
      },
    ],
  },
  {
    version: '2026.1114.1',
    features: [
      {
        id: 'free-models',
        title: 'Bots that work with no account',
        description: 'AppuBot now sets up OpenCode by itself, an agent with free models that needs no account and no key. A new AppuBot starts on it, so your first bot answers straight away. If your own agent is not installed or signed in, your bots move to it. Signed in to Claude Code or Codex? Nothing changes for you, and OpenCode is there to pick.',
      },
      {
        id: 'free-models-labelled',
        title: 'Free models are easy to find',
        description: 'In the model picker, OpenCode\'s free models now say "(Free)" and come first in the list.',
      },
      {
        id: 'new-setup',
        title: 'A simpler setup',
        description: 'Setup now asks one thing first: where your bots should work. Start a cloud computer that is always on, with a 3-day free trial, or use this computer. Each choice then shows only the steps it needs.',
      },
      {
        id: 'apps-that-connect',
        title: 'Apps that connect, and long results',
        description: 'Apps that could never connect (X, Shopify, PayPal and others) are no longer listed, and a connection that fails says why. Bots can now read long results from your apps, like full emails and big lists, and the apps that need no sign-in work for every bot.',
      },
    ],
  },
  {
    version: '2026.1113.1',
    features: [
      {
        id: 'voice-on-cloud',
        title: 'Talk to the bots on your cloud computer',
        description: 'Voice mode and dictation now work while your AppuBot cloud computer is on screen. Your Mac or PC hears you, and the bot answers out loud. Settings, under Voice, shows the voice your cloud computer reads with.',
      },
      {
        id: 'phone-voice',
        title: 'Voice on the phone, with any computer',
        description: 'In the phone app you can now talk with the bots on your cloud computer too. Where the phone knows your language it can hear you by itself, so your computer has less to load before a conversation starts.',
      },
      {
        id: 'phone-steadier',
        title: 'A steadier phone app',
        description: 'Fixed a crash when opening Settings, then Account, on the phone. The phone app now opens on the computer you used last, and a cloud computer you just bought is ready on it straight away.',
      },
      {
        id: 'agent-timeout-reason',
        title: 'Clearer errors when an agent does not answer',
        description: 'When an agent takes too long to start, AppuBot now shows what the agent itself said, so it is easier to see what went wrong.',
      },
      {
        id: 'app-store-codes',
        title: 'The iPhone app is on the App Store',
        description: 'The codes for getting the phone app, in setup and in Settings under Devices, now open the App Store.',
      },
    ],
  },
  {
    version: '2026.1112.1',
    features: [
      {
        id: 'free-trial',
        title: 'Try AppuBot Cloud free for 3 days',
        description: 'Every AppuBot Cloud plan now starts with a 3-day free trial. Pick any plan and your bots get a cloud computer of their own that keeps working around the clock. Nothing is charged until the trial ends, and cancelling before then costs nothing.',
      },
      {
        id: 'trial-in-billing',
        title: 'See where your trial stands',
        description: 'While a trial runs, Settings, under Billing, shows "Free trial" on your plan and the date of the first charge, and we email you the day before.',
      },
    ],
  },
  {
    version: '2026.1111.1',
    features: [
      {
        id: 'cleaner-look',
        title: 'A cleaner, calmer look',
        description: 'AppuBot has a fresh look: a darker sidebar, flat bots without the shine, and your bots and groups in one tidy list. Pinned bots are bigger, and the one + at the top makes a new bot or a new group.',
      },
      {
        id: 'search-button',
        title: 'Search from one button',
        description: 'The search field in the sidebar is now a button. It opens one search for everything: bots, groups, chats, actions and settings.',
      },
      {
        id: 'quiet-tooltips',
        title: 'No more labels popping up',
        description: 'The little labels that appeared when the pointer rested on a button are off now. If you like them, turn them back on in Settings, under Appearance.',
      },
      {
        id: 'cloud-card-close',
        title: 'Close the cloud card',
        description: 'The AppuBot Cloud card in the sidebar now has a close button.',
      },
    ],
  },
  {
    version: '2026.1110.1',
    features: [
      {
        id: 'launch-gift',
        title: 'A launch gift: unlimited Claude, free for 24 hours',
        description: 'AppuBot is live on Product Hunt, and to celebrate everyone gets unlimited Claude in AppuBot, free for 24 hours. Open the gift when AppuBot offers it, sign in, and choose which bots use it: nothing to pay and no key to enter. When the gift ends, your bots go back to what they used before.',
      },
    ],
  },
  {
    version: '2026.1109.2',
    features: [
      {
        id: 'goals',
        title: 'Bots that keep going',
        description: 'When a job needs many steps, a bot can now propose a goal: you see it on a card, adjust it if you like and tap Allow, and the bot carries on by itself, step after step, until it’s done or needs you. A bar above the message box shows how far it got, with Pause, Resume and Stop, and you’re told when it finishes.',
      },
      {
        id: 'group-goals',
        title: 'Groups that work on their own',
        description: 'A group’s lead can set the whole group a goal: the bots hand out the parts and keep the work moving until it’s done, within the number of messages you allow, and the room tells you when it’s finished or stuck.',
      },
      {
        id: 'group-rooms',
        title: 'Group chats, all grown up',
        description: 'Groups read like a group chat now, with each bot’s name and picture, @mentions as chips and the time in every bubble. Start a new thread in a group, pick one model for every bot in it, speak a message with the voice button, attach files, and answer the bots’ questions and cards right in the room.',
      },
      {
        id: 'device-language',
        title: 'Bots speak your language',
        description: 'Bots now write in your computer’s language by default, unless you write to them in another one. Your own instructions still come first.',
      },
      {
        id: 'cloud-time-zone',
        title: 'Your cloud computer, on your time',
        description: 'Your AppuBot computer now runs on your own time zone, so a routine set for 9:00 runs at your 9:00.',
      },
    ],
  },
  {
    version: '2026.1109.1',
    features: [
      {
        id: 'bots-together',
        title: 'Bots that work together',
        description: 'Put a few bots in a group and give them something to do: they talk it through in a room of their own, hand each other parts with @Name and report back, while you read along and chime in. Mark a bot as chief and it leads its groups and can message every bot at once. Any bot can also message another one directly and get its answer.',
      },
      {
        id: 'request-cards',
        title: 'Bots ask with a card',
        description: 'When a bot needs an app connected, a Telegram bot linked, a routine approved or changed, or wants to make or change a bot, it asks on a card right in the chat: connect, paste the token, check the schedule or see each change laid out there, no trip to Settings. Forms can now take a star rating and a file too.',
      },
      {
        id: 'interface-language',
        title: 'AppuBot in your language',
        description: 'Settings › General › Language offers 19 languages: Spanish, French, German, Italian, Portuguese, Dutch, Polish, Turkish, Ukrainian, Russian, Arabic, Hindi, Bengali, Indonesian, Vietnamese, Thai, Japanese, Chinese and Korean, or it follows your computer’s language by itself. Settings, the sidebar and the message box come first; the rest follows. The phone app has the same setting.',
      },
      {
        id: 'global-instructions',
        title: 'Instructions for every bot',
        description: 'Write once what every bot should know about you and how you like things done, in Settings › Agents › Instructions (on the phone, Settings › Instructions). Each bot’s own instructions add to it.',
      },
      {
        id: 'phone-pushes-always',
        title: 'Phone notifications every time',
        description: 'Your phone now hears of every finished task, question and approval, even while you were just at your Mac, so a routine’s notice is never missed.',
      },
      {
        id: 'cloud-chats-open',
        title: 'Chats on your AppuBot computer open at once',
        description: 'A long computer-use chat no longer keeps the other chats from being kept on this Mac, so every bot opens to its conversation instead of a spinner.',
      },
      {
        id: 'telegram-cloud',
        title: 'Telegram bots connect again on your AppuBot computer',
        description: 'Telegram bots on your AppuBot computer connect again, and a Telegram bot that couldn’t start now says why and tries again by itself.',
      },
    ],
  },
  {
    version: '2026.1108.2',
    features: [
      {
        id: 'no-blank-chats',
        title: 'No more blank chats',
        description: 'A chat on your AppuBot computer that AppuBot has nothing saved for yet shows that it’s loading from the moment it opens, instead of a blank page while the computer wakes. What you last saw is also kept right up to the moment AppuBot quits.',
      },
      {
        id: 'cloud-welcome',
        title: 'What your AppuBot computer is',
        description: 'The first time your AppuBot computer comes on screen, AppuBot says what it is: a second, fresh computer in the cloud, with your Mac’s bots untouched and the computer menu to switch between them, and how to copy bots over from Settings › Transfer.',
      },
      {
        id: 'phone-app-codes',
        title: 'The phone app, one scan away',
        description: 'Pairing a phone now shows the codes for the iPhone and Android apps: point the phone’s camera at one and the store opens. In onboarding and in Settings › Devices.',
      },
    ],
  },
  {
    version: '2026.1108.1',
    features: [
      {
        id: 'chats-open-at-once',
        title: 'Chats open at once',
        description: 'Each bot’s latest chat is read ahead as soon as AppuBot connects, so opening it shows the conversation right away instead of a spinner. What was already there stays on screen while the newest messages come in.',
      },
      {
        id: 'more-chats-kept',
        title: 'Earlier chats stay ready',
        description: 'Going back to a chat you looked at a while ago shows its latest messages straight away, then catches up.',
      },
    ],
  },
  {
    version: '2026.1107.2',
    features: [
      {
        id: 'sign-in-from-here',
        title: 'Sign your AppuBot computer’s agents in from here',
        description: 'Claude Code, Google’s agents and most others now sign in on your AppuBot computer through your own browser on this Mac, where you’re already signed in. No more doing it on its screen; Codex still takes a one-time code.',
      },
      {
        id: 'steady-pickers',
        title: 'Steadier model picker',
        description: 'The thinking slider no longer turns into “Set by the model” for a moment after you switch models, and the picker keeps one size on every tab.',
      },
      {
        id: 'quieter-errors',
        title: 'Fewer false alarms',
        description: 'A chat cut off by a dropped connection reloads by itself when the connection is back, instead of showing an error.',
      },
      {
        id: 'no-slash-menu',
        title: 'A plain message box',
        description: 'Typing “/” no longer opens a list of commands. A command you type in full still reaches the bot.',
      },
    ],
  },
  {
    version: '2026.1107.1',
    features: [
      {
        id: 'quiet-connecting',
        title: 'Your chats open at once',
        description: 'Opening AppuBot, or switching to your AppuBot computer, shows your chats straight away and brings them up to date behind. No more “Waking up” or “Connecting”: AppuBot only says something if it can’t reach the computer for 30 seconds.',
      },
      {
        id: 'form-cards',
        title: 'Bots can ask with a form',
        description: 'When a bot needs a few details, it asks with a short form you fill in right in the chat. For a login or a card it asks for a Vault item, which you pick or add without the bot ever seeing the secret.',
      },
      {
        id: 'stop-button',
        title: 'Stop is back',
        description: 'While a bot works, the send button turns into Stop. Start typing and it becomes Send again, and your message reaches the bot mid-task.',
      },
      {
        id: 'agent-update-notice',
        title: 'Know when your agents can update',
        description: 'When a newer Claude Code, Codex or other agent your bots use is out, AppuBot tells you once and updates it with one click.',
      },
      {
        id: 'cloud-clipboard',
        title: 'Copy and paste with your AppuBot computer',
        description: 'While you’re in control of its screen, what you copy there lands on this Mac and what you copy here pastes there, and ⌘C, ⌘V and the other shortcuts work as you’d expect.',
      },
      {
        id: 'short-names',
        title: 'Computer names that fit',
        description: 'A long computer name shortens to “Sarthak’s Cloud” or “MacBook Pro” in the switcher instead of being cut off; the menu still shows it in full.',
      },
    ],
  },
  {
    version: '2026.11.07',
    features: [
      {
        id: 'plans-signed-out',
        title: 'See the plans before you sign in',
        description: 'Settings › Billing now shows every AppuBot computer plan right away. Pick one and AppuBot signs you in, then opens its checkout.',
      },
      {
        id: 'telegram-group',
        title: 'Join the AppuBot Users group',
        description: 'Settings › About now links our Telegram group, where you can ask questions, share what your bots do and hear first what’s new. Both X accounts sit in one row.',
      },
      {
        id: 'live-view-phones',
        title: 'Live view works from every phone again',
        description: 'If the AppuBot app on your phone hasn’t updated yet, you can click and type on this computer from its live view again.',
      },
    ],
  },
  {
    version: '2026.11.06',
    features: [
      {
        id: 'cloud-computer',
        title: 'Your own computer in the cloud',
        description: 'Get an AppuBot computer that keeps your bots working all day, even with your Mac closed. Pick a plan in Settings › Billing, bring your bots over with Settings › Transfer, and watch or take over its screen from the Computer tab. Paid plans come with a Claude launch bonus.',
      },
      {
        id: 'work-plans',
        title: 'Work plans for teams',
        description: 'Share one AppuBot computer with your team. Invite several people at once, make admins, and choose whether everyone signs in to their own AI accounts or uses the team’s.',
      },
      {
        id: 'instant',
        title: 'Everything happens at once',
        description: 'Messages you send show up instantly with the bot already working on them, and renaming, pinning, reacting and changing the model, effort or permissions never wait or jump back.',
      },
      {
        id: 'plan-limits',
        title: 'See what’s left of your AI plans',
        description: 'The model picker and Settings › Usage show how much of your Claude, ChatGPT, OpenCode Go, Grok, Cursor, Kimi and Google Antigravity plans is left, per model.',
      },
      {
        id: 'pair-sign-in',
        title: 'Sign in to pair a phone',
        description: 'Pairing a new phone now asks you to sign in to AppuBot first. Phones you’ve already paired keep working as before.',
      },
      {
        id: 'lighter',
        title: 'Faster and lighter',
        description: 'AppuBot opens faster, uses less power while it sits open, and reopens chats at once. Empty chats get a subtle animated background, which you can turn off in Settings › Appearance.',
      },
    ],
  },
  {
    version: '2026.11.04',
    features: [
      {
        id: 'support-bubble',
        title: 'Chat with me from a bubble',
        description: 'The support chat is now a chat bubble at the bottom right of the window. Click it to write to me, and close it to get back to your bots. It also opens from the Help menu, the menu bar and Settings › About.',
      },
      {
        id: 'connect-apps-button',
        title: 'A bigger Connect apps button',
        description: 'With the chat button gone from the sidebar, Connect apps now fills the bottom row, so it’s easier to find and click.',
      },
    ],
  },
  {
    version: '2026.11.03',
    features: [
      {
        id: 'voice-models',
        title: 'Pick the voice models you like',
        description: 'Settings › Voice now lets you choose the model that hears you, from 11 that run on your Mac (Parakeet, Whisper, Qwen3-ASR, SenseVoice, Hindi and more), and the voice that reads replies: Supertonic, or Kokoro with 28 English voices.',
      },
      {
        id: 'dialogs',
        title: 'A calmer look for dialogs and menus',
        description: 'New bot, routines, skills, pairing and every other dialog now look like Settings: solid, clear and easy to read in light and dark.',
      },
      {
        id: 'small-windows',
        title: 'Better in a small window',
        description: 'With the side panel open in a narrow window, the chat keeps its room, and the model picker keeps the model’s name in view.',
      },
      {
        id: 'keyboard',
        title: 'Menus work from the keyboard',
        description: 'Open a menu and use the arrow keys, Home, End and Esc. Dialogs and ⌘K also work better with VoiceOver.',
      },
      {
        id: 'fixes-2026-11-03',
        title: 'Fixes',
        description: 'Chat dates follow your 12- or 24-hour setting, “Find in chat” shows on your own messages, previews of tables read cleanly, Teach a task names the bot you picked, and checking your OpenCode sign-in no longer leaves it running.',
      },
    ],
  },
  {
    version: '2026.11.01',
    features: [
      {
        id: 'characters',
        title: 'Make your own bot characters',
        description: 'Describe a look, like “a sprout in a pot”, and your own Claude Code, Codex or other agent draws a few to pick from. Every character blinks, thinks and cheers like the rest, on Telegram and on the bot’s cursor too.',
      },
      {
        id: 'vault',
        title: 'Vault',
        description: 'Keep logins, cards, contact details and API keys in Settings › Vault. Bots can use them to fill forms and sign in without ever seeing the passwords, and they ask you first.',
      },
      {
        id: 'custom-models',
        title: 'Use your own models',
        description: 'Add Ollama, LM Studio or any OpenAI-compatible server under Settings › Providers › Add custom, and pick its models for your bots.',
      },
      {
        id: 'context-ring',
        title: 'See how full a chat is',
        description: 'A small ring next to the model shows how much of the chat’s memory is used, with Compact now when it gets full.',
      },
      {
        id: 'new-setup',
        title: 'A friendlier start',
        description: 'Setting up AppuBot now walks you through each step and shows exactly which switch to turn on for each permission.',
      },
      {
        id: 'fixes-2026-11-01',
        title: 'Fixes',
        description: 'Charts and pages no longer show a scroll bar when they fit, Usage shows only what your bots used, and Chat with Sarthak keeps one conversation.',
      },
    ],
  },
  {
    version: '2026.10.28',
    features: [
      {
        id: 'voice-mode',
        title: 'Talk to your bots',
        description: 'Press the round voice button in the chat and just talk. Your bot answers out loud, and you can cut in whenever you like.',
      },
      {
        id: 'menu-bar-call',
        title: 'Talk from the menu bar',
        description: 'Choose a bot under Talk to in the AppuBot menu bar icon for a voice call in a small bar over your work, without opening the app.',
      },
      {
        id: 'dictation',
        title: 'Dictate your messages',
        description: 'Press the mic in the chat box to speak a message instead of typing it.',
      },
      {
        id: 'private-voice',
        title: 'Voice stays on your computer',
        description: 'Hearing and speaking run on your own computer, so nothing you say is sent anywhere. Pick the models and the voice in Settings › Voice. Hindi speakers get a model of their own.',
      },
      {
        id: 'telegram-voice',
        title: 'Voice messages on Telegram',
        description: 'Send your bot a voice message on Telegram and it answers with one, with the text underneath. Turn it off with /voice off.',
      },
      {
        id: 'bot-voice',
        title: 'Bots can listen and speak',
        description: 'Bots can listen to audio files you give them and send you voice messages of their own.',
      },
      {
        id: 'visual-replies',
        title: 'Charts and pages in the chat',
        description: 'Bots can answer with a chart, a table or a diagram drawn right in the chat. Expand it to see it bigger.',
      },
      {
        id: 'steer',
        title: 'Message a bot while it works',
        description: 'Send a message while your bot is busy: Claude Code bots take it into the task they’re doing, other bots get it right after.',
      },
      {
        id: 'quick-messages',
        title: 'Quick updates from your bot',
        description: 'Bots can send a short message of their own mid-task, like “On it”, and on Telegram it arrives right away.',
      },
      {
        id: 'find',
        title: 'Find in a chat',
        description: 'Press ⌘F to search the chat you’re in and jump between matches.',
      },
      {
        id: 'quote',
        title: 'Quote a reply',
        description: 'Select part of a reply and press Quote, so your bot knows exactly what you mean.',
      },
      {
        id: 'recall',
        title: 'Bring back what you sent',
        description: 'Press ↑ in an empty chat box to bring back a message you sent before.',
      },
      {
        id: 'palette',
        title: 'Jump anywhere with ⌘K',
        description: 'Press ⌘K to go to any bot or chat, start voice, switch the theme or open a setting.',
      },
      {
        id: 'math',
        title: 'Diagrams and maths',
        description: 'Diagrams and maths formulas in replies now show properly.',
      },
      {
        id: 'gallery',
        title: 'Photo gallery',
        description: 'Click any picture in a chat to see all of its pictures.',
      },
      {
        id: 'photos',
        title: 'Big photos just work',
        description: 'Large photos are shrunk to fit and iPhone photos are converted, so your bot can always see them.',
      },
      {
        id: 'chats',
        title: 'Chats in the sidebar',
        description: 'Each bot’s chats are listed under it. Right-click one to rename it.',
      },
      {
        id: 'apps-sign-in',
        title: 'Connect apps by signing in',
        description: 'Connect Gmail, GitHub, Notion and more by signing in once in the browser, with no keys to copy. Apps you already connected elsewhere show up by themselves.',
      },
      {
        id: 'settings',
        title: 'A new Settings window',
        description: 'Settings opens over the app with a search, and Permissions has a tab of its own.',
      },
      {
        id: 'appearance',
        title: 'Appearance',
        description: 'Pick light or dark, how see-through the app is, Enter or ⌘Enter to send, and a 12- or 24-hour clock in Settings › Appearance.',
      },
      {
        id: 'usage',
        title: 'See your AI usage',
        description: 'Settings › Usage shows how much your AI agents were used and roughly what it cost, read only on your computer.',
      },
      {
        id: 'storage',
        title: 'Free up space',
        description: 'Settings › Storage shows what AppuBot keeps and can clean up old chat files by itself.',
      },
      {
        id: 'notifications',
        title: 'Know when a reply is ready',
        description: 'You get a notification when a bot finishes, and notices inside the app now stack neatly in the corner.',
      },
      {
        id: 'menu-bar',
        title: 'A tidier menu bar menu',
        description: 'The AppuBot menu bar icon now groups Talk to, Quick Settings, Settings, About and Feedback & Support.',
      },
      {
        id: 'auto-restart',
        title: 'Updates restart by themselves',
        description: 'When an update has downloaded, AppuBot restarts by itself once your bots are idle, and anything they were doing carries on where it left off.',
      },
      {
        id: 'whats-new',
        title: 'See what’s new',
        description: 'After an update a card in the sidebar shows what changed, and Settings › What’s new lists every release.',
      },
      {
        id: 'look',
        title: 'A fresh look',
        description: 'A cleaner design, slightly larger text and a new round app icon.',
      },
      {
        id: 'claude-models',
        title: 'Older Claude models',
        description: 'The model picker also lists earlier Claude versions, for when a bot works better on one of them.',
      },
      {
        id: 'support',
        title: 'Chat with Sarthak',
        description: 'The chat button next to Connect apps reaches me, the maker of AppuBot, directly.',
      },
      {
        id: 'private',
        title: 'Bots keep their setup private',
        description: 'Bots no longer share their own setup instructions when asked; your instructions and memory stay yours to see.',
      },
    ],
  },
  {
    version: '2026.10.21',
    features: [
      {
        id: 'background',
        title: 'Work in the background',
        description: 'Bots can use the apps on your computer while you keep working. Their windows stay behind yours, and when a step needs the screen they wait until you pause.',
      },
      {
        id: 'more-agents',
        title: 'More AI agents',
        description: 'Add Google Antigravity and many others from Settings › Providers › More agents, and AppuBot installs them for you.',
      },
      {
        id: 'agent-sign-in',
        title: 'Sign in to any agent',
        description: 'Sign in the way each agent supports, in your browser or with an API key, right from AppuBot.',
      },
      {
        id: 'approvals',
        title: 'Approve for me, on every agent',
        description: '"Approve for me" and "Full access" now work for bots on every agent, not just Claude Code and Codex.',
      },
      {
        id: 'telegram-commands',
        title: 'Telegram commands',
        description: 'Switch chats, pick the model, effort, permissions or agent, check status, see what a bot remembers and run its routines, all with buttons.',
      },
      {
        id: 'support-chat',
        title: 'Chat with Sarthak',
        description: 'Ask me, the maker of AppuBot, anything from inside the app, with the chat button next to Connect apps.',
      },
      {
        id: 'pinned-bots',
        title: 'Pin your favourite bots',
        description: 'Right-click a bot and choose Pin to top to keep it at the top of the sidebar.',
      },
      {
        id: 'smaller',
        title: 'A smaller download',
        description: 'AppuBot now uses the Claude Code and Codex already on your computer, and shows how to install them if you don’t have them.',
      },
    ],
  },
  {
    version: '2026.10.19',
    features: [
      { id: 'bots', title: 'Bots that work for you', description: 'Make bots that work for you on your own computer, each with its own name, look and job.' },
      { id: 'agents', title: 'On the AI you already use', description: 'Bots run on Claude Code, Codex, Cursor, GitHub Copilot, OpenCode and more.' },
      { id: 'computer-use', title: 'Bots use your apps', description: 'A bot opens an app, clicks, types and finishes the task while you watch its cursor.' },
      { id: 'telegram', title: 'Telegram', description: 'Chat with your bots from Telegram, from anywhere.' },
      { id: 'memory', title: 'Memory', description: 'Bots remember what matters to you across chats.' },
      { id: 'routines', title: 'Routines', description: 'Have a bot do a task on a schedule, every day or week.' },
      { id: 'teach', title: 'Teach a task', description: 'Show a bot a task once, and it can do it again.' },
      { id: 'apps', title: 'Connect apps', description: 'Connect apps like Gmail, GitHub and Notion once, and choose which bots can use them.' },
      { id: 'models', title: 'Model and effort', description: 'Pick the model and how hard it thinks, per bot or per chat.' },
      { id: 'awake', title: 'Stays awake', description: 'Keep your Mac awake, even with the lid closed, while bots work.' },
      { id: 'platforms', title: 'Mac, Windows and Linux', description: 'Available for Mac (Apple silicon and Intel), Windows and Linux, and updates install by themselves.' },
    ],
  },
];
