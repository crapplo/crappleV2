# crappleV2

A Discord bot for monitoring Torn faction members' jail status and community utilities.

This repository contains a bot that provides:

- - ~~Jail monitoring: checks the Torn API for faction members and announces when they're jailed/released.~~
- Role reaction messages: create messages where users react to receive/remove roles.
- Auto-role for new members: optionally add an "unverified" role to new members.
- Welcome messages: optional welcome message with verification instructions.
- Event announcements with RSVP tracking.

---

## Quickstart

Requirements
- Node.js 18+ (or the version compatible with discord.js v14+)
- A Discord bot application with a bot token
- Torn API key and target faction ID

1. Install dependencies

```bash
# from repository root
npm install
```

2. Create a `.env` file in the project root with the following variables:

```
DISCORD_TOKEN=your_discord_bot_token
TORN_API_KEY=your_torn_api_key
FACTION_ID=your_torn_faction_id
# Optional
GUILD_ID=your_guild_id_to_register_commands_to (recommended during development)
POLL_INTERVAL=60 # seconds between Torn API polls (default 60)
```

3. Enable privileged intents in the Discord Developer Portal

The bot uses the following Gateway intents. Two of them are privileged and must be enabled on the Bot page in the Developer Portal:

- SERVER MEMBERS INTENT (Guild Members) — required to receive member join events and manage roles
- MESSAGE CONTENT INTENT — required only if you need to read message content (used for some features)

Turn both on under: https://discord.com/developers/applications → your app → Bot → Privileged Gateway Intents

4. Start the bot

```bash
node index.js
```

---

## Configuration & Persistence

The bot stores configuration in `config.json` and state in `jailstate.json` and role-react mappings in `rolereact.json`. Use the slash commands to configure the bot (these commands are registered on startup):

- `/setwelcome channel:#channel` — set which channel receives welcome messages when a member joins
- `/setunverified role:@role` — set the role that is automatically added to new members
- `/jail channel:#channel role:@role` — set the channel and role used for jail alerts
- `/testjail` — send a fake jail alert to the configured jail channel
- `/jailstatus` — shows current tracked jail state (ephemeral)
- `/rolereact role1:@role emoji1:emoji [role2 emoji2 ... role5 emoji5]` — create a role-react message (admins only)
- `/event title:desc time:ISO8601 [role:@role]` — create an event announcement with RSVP reactions

Commands that require admin permissions will reply with an ephemeral error if you don't have permission.

---

## How it works

- The bot polls the Torn API for faction members (`/v2/faction/{FACTION_ID}?selections=members`) on an interval defined by `POLL_INTERVAL`.
- When a member's `jail_time` transitions from 0 to >0 the bot announces the jail event.
- When `jail_time` transitions back to 0 the bot announces the release.
- Role react messages are saved to `rolereact.json` so they survive restarts.
- Auto-role and welcome channel settings are saved to `config.json`.

---

## Notes & Troubleshooting

- If you see `Used disallowed intents` on login, enable the two privileged intents in the Developer Portal (see step 3).
- Make sure the bot has the required permissions in the guild:
	- Manage Roles (to assign/remove roles)
	- Send Messages (to send alerts)
	- Add Reactions (to add reaction options)

- When registering commands for testing, provide `GUILD_ID` in `.env` so commands are available instantly in that guild. Remove `GUILD_ID` to register globally (may take up to an hour).

---
