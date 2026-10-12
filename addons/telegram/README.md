# Telegram integration

Telegram is an **optional secondary channel** for mobile-first chat access.
The web UI remains the primary interface.

Requires Piclaw `>=3.3.2` in single-user mode.

## How it works

- A startup runtime entry long-polls the Bot API from Piclaw boot onwards. Polling does not depend on an open web UI or agent session, and individual session shutdowns do not disconnect it.
- Text from an allowlisted user is queued into one **dedicated web chat** (for example `web:telegram`) through the Piclaw runtime API. The final reply of that agent run is sent back to the sender once the run has settled, including after automatic retries and Piclaw recovery continuations. If a run fails and no recovery follows within ten minutes, the sender gets a short failure notice; the details stay in the web chat.
- One Telegram message is processed at a time. A second message sent while a reply is pending gets a short "still working" notice instead of being queued.
- Other activity in the target chat (web messages, side prompts, scheduled runs) is not mirrored to Telegram.

## Access control (fail closed)

Only these messages are accepted:

- plain text `message` updates (edits, channel posts and other update types are ignored);
- from a non-bot user whose numeric ID is on the allowlist;
- in that user's own private chat (no groups, supergroups, forum topics, anonymous senders or forwarded messages);
- sent after polling started, so nothing sent while Piclaw was down is replayed.

Messages from anyone else are ignored without a reply. An allowlisted user who sends something other than plain text (a photo, sticker or file) gets a short "only plain text" notice. If no user IDs or no dedicated target chat are configured, polling does not start. Slash commands, the `!` shell alias and `@mentions` are refused over Telegram because they would run immediately or route to another chat.

Allowed users get the same agent and tool rights as the target web chat. Only allowlist accounts you control.

## Enable

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. Create a web chat that will be used only for Telegram.
3. Open **Settings → Telegram**, enter the bot token, your numeric Telegram user ID and the target chat, enable the channel and save. Settings apply immediately and are restored at every start.

The token is stored in the Piclaw keychain as `telegram/bot-token`. Non-secret settings are stored in global extension KV.

Environment overrides are also supported:

```bash
PICLAW_TELEGRAM_ENABLED=1
TELEGRAM_BOT_TOKEN=123456789:your_botfather_token
PICLAW_TELEGRAM_ALLOWED_USER_IDS=123456789
PICLAW_TELEGRAM_TARGET_CHAT_JID=web:telegram
PICLAW_TELEGRAM_POLLING_TIMEOUT=30
```

Token lookup order: `TELEGRAM_BOT_TOKEN`, `PICLAW_TELEGRAM_BOT_TOKEN`, keychain `telegram/bot-token`, then a legacy KV-stored token. New secrets are written only to the keychain.

## Upgrading from 0.1.x

Version 0.1.x stored `enabled` and `pollingTimeout` outside the new settings record and accepted messages from anyone. After upgrading, open **Settings → Telegram**, add the allowed user IDs and the target chat, and save. Until then the channel stays off.

## Disable

Disable the channel in **Settings → Telegram** and save; polling stops immediately. Unsetting `PICLAW_TELEGRAM_ENABLED` disables environment-based enablement but does not override an enabled value saved through Settings.

## Settings field appearance (0.1.3)

Text-like fields use the host's shared `settings-addon-*` controls and associated
labels, matching core Settings in Classic and Visual without changing save
payloads, defaults or secret handling. A package-local layered stylesheet keeps
older supported hosts readable; host rules take precedence when available.
Native checkboxes and action buttons retain their own control roles.
