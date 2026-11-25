# Contributing to AppuBot

Thanks for helping make AppuBot better. Bug reports, ideas and pull requests are all welcome.

## Ways to help

- **Report a bug:** [open an issue](https://github.com/sarthakguptadev/AppuBot/issues/new/choose) with what happened, what you expected and your AppuBot version (Settings › About).
- **Suggest an idea or ask a question:** start a [discussion](https://github.com/sarthakguptadev/AppuBot/discussions).
- **Send a fix or a feature:** open a pull request. For anything bigger than a small fix, open an issue or a discussion first, so we can agree on the approach before you spend time on it.
- **Found a security problem?** Don't open an issue: follow [SECURITY.md](SECURITY.md).

## Set up

Follow [Build from source](README.md#build-from-source) in the README. You need Node 22 or later and pnpm 11, plus the Xcode Command Line Tools on a Mac.

## Before you send a pull request

- Run `pnpm typecheck && pnpm test`. On a Mac, `pnpm check` runs everything, including a build and a launch test.
- Keep a pull request to one change, and say what it changes and how you checked it.
- Add or update tests when you change how something behaves.
- For a change people will see, add a screenshot or a short recording.
- Match the code around your change: its naming, its style and the libraries it already uses. Ask before adding a new dependency.

You don't have to run the whole suite while you work. For one package, run `pnpm -C packages/chat-core test`. For a single test file, add its path, for example `pnpm -C apps/desktop test src/renderer/src/components/ui/menuKeys.test.ts`. The tests and the typecheck run on a Mac, Windows or Linux without opening the app. If `pnpm install` warns `Failed to create bin ... appubot-mcp-bridge`, that warning is harmless and goes away once you run `pnpm -C packages/mcp-bridge build`.

## Things to keep in mind

- **The shared protocol.** `packages/protocol` is also used by our phone apps, which aren't public. We check a change there against them before merging, so those pull requests can take a little longer.
- **Code from elsewhere.** Only bring in code whose licence allows it, and add it to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with its source and licence. Never copy code from other bot apps.
- **Rare UI.** `apps/desktop/src/renderer/src/components/rare` is Rare UI by Swami Malode, under its own licence. Keep its `LICENSE` file and the credit in Settings › About.
- **Secrets.** Never commit keys, tokens or passwords, not even test ones that look real.

## The agreement

By sending a contribution you agree to the [Contributor Licence Agreement](CLA.md). In short: you keep the copyright in your work, and you give AppuBot a licence to use it, including in paid versions.

AppuBot's code is under the [Apache License 2.0](LICENSE). The AppuBot name, logo and icon are ours: see [TRADEMARKS.md](TRADEMARKS.md).

Questions? Write to [sarthak@appubot.com](mailto:sarthak@appubot.com).
