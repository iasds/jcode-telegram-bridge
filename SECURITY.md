# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities. Instead,
report them privately so they can be fixed before disclosure.

- Preferred: GitHub Security Advisory — use the
  ["Report a vulnerability"](https://github.com/iasds/jcode-telegram-bridge/security/advisories/new)
  flow on this repository.
- Alternative: email the repository owner with the subject
  `[jcode-telegram-bridge] security report`.

Please include, when possible:

- Affected version / commit
- Steps to reproduce
- Impact assessment (what an attacker could do)
- Suggested fix, if you have one

## Scope

This bridge runs with your personal jcode agent and Telegram bot credentials.
Treat the following as sensitive:

- `TELEGRAM_BOT_TOKEN` — never commit it; revoke and rotate via BotFather if
  it leaks (a token found in git history must be treated as compromised).
- `state.json` / `poll-offset.txt` — runtime state, git-ignored; do not share.

## Supported versions

Only the `master` branch is actively supported. Releases are not published.
