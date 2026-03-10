# crappleV2

A Discord bot for monitoring Torn faction members' jail status and community utilities.

This repository contains a bot that provides:

- **Jail monitoring**: Checks the Torn API v2 for faction members and announces when they're jailed/released/re-jailed
- **Role reaction messages**: Create messages where users react to receive/remove roles
- **Auto-role for new members**: Automatically add an "unverified" role to new members
- **Welcome messages**: Customizable welcome messages with verification instructions
- **Event announcements**: Create events with RSVP tracking and automatic reminders
- **XP system**: Message-based XP gain with levels, leaderboards, and profiles
- **Chain watch reminders**: Scheduled reminders for chain watching duties
- **OC monitoring**: Shows anyone who isn't in an OC and for how longs

---

## Quickstart

### Requirements
- Node.js 18+ (native fetch support required)
- A Discord bot application with a bot token
- Torn API key (v2 compatible) and target faction ID

### 1. Install dependencies

```bash
npm install
```

### 2. Create a `.env` file in the project root with the following variables:

```env
DISCORD_TOKEN=your_discord_bot_token
TORN_API_KEY=your_torn_api_key
FACTION_ID=your_torn_faction_id
CLIENT_ID=your_discord_application_client_id
GUILD_ID=your_discord_guild_id

# Optional
POLL_INTERVAL=60  # seconds between Torn API polls (default: 60)
```

### 3. Enable privileged intents in the Discord Developer Portal

The bot requires the following Gateway intents (two are privileged):

- **SERVER MEMBERS INTENT** (Guild Members) — Required for member join events and role management
- **MESSAGE CONTENT INTENT** — Required for XP system and message-based features

Enable both at: https://discord.com/developers/applications → your app → Bot → Privileged Gateway Intents

### 4. Set bot permissions

Ensure your bot has these permissions in your Discord server:
- **Manage Roles** — To assign/remove roles
- **Send Messages** — To send alerts and notifications
- **Add Reactions** — To add reaction options to messages
- **Read Message History** — For reaction role functionality
- **Embed Links** — For rich embeds

### 5. Start the bot

```bash
npm start
# or
node index.js
```

The bot will automatically register all slash commands on startup.

---

## Commands

All commands are slash commands and are automatically registered on bot startup.

### Jail Monitoring Commands (Admin Only)
- `/jail channel:#channel role:@role` — Configure jail alert notifications
- `/testjail` — Send a test jail alert to verify configuration
- `/testapi` — Test Torn API connection and show currently jailed members
- `/debugapi name:PlayerName` — Show raw API data for a specific faction member
- `/jailstatus` — View all currently jailed faction members (ephemeral)

### Server Configuration Commands (Admin Only)
- `/setwelcome channel:#channel` — Set welcome message channel for new members
- `/setunverified role:@role` — Set auto-role for new members
- `/rolereact role1:@role emoji1:emoji [...]` — Create role reaction message (up to 5 roles)

### Event Commands
- `/event title:"Event Name" time:"YYYY-MM-DDTHH:MM:SSZ" [description:"..."] [role:@role]` — Create event with RSVP tracking

### XP System Commands
- `/profile [user:@user]` — View your XP profile or someone else's
- `/leaderboard` — View the top 10 XP earners

---

## Configuration & Persistence

The bot automatically saves all configuration and state to JSON files:

- **`config.json`** — Jail alerts, welcome channel, unverified role settings
- **`jailstate.json`** — Tracked jail status for all faction members
- **`rolereact.json`** — Role reaction message mappings
- **`xp.json`** — User XP and level data

**All settings persist across bot restarts!** You only need to run configuration commands once.

---

## How It Works

### Jail Monitoring System
The bot polls the Torn API v2 every 60 seconds (configurable via `POLL_INTERVAL`):

1. **API Call**: `GET https://api.torn.com/v2/faction/{FACTION_ID}?selections=members`
2. **Status Detection**: Checks each member's `status.state` and `status.until` fields
3. **State Tracking**: Compares current jail time against previous state stored in `jailstate.json`
4. **Alerts**: Sends notifications for three scenarios:
   - 🚨 **Newly Jailed** — Member goes from free to jailed
   - ✅ **Released** — Member is freed from jail
   - 🔄 **Re-jailed** — Member gets jailed again (with 60s buffer to avoid false positives)

### XP System
- Users gain 5-15 XP per message (60-second cooldown per user)
- Level formula: `Level = floor(0.1 * sqrt(XP))`
- Level-up notifications are sent automatically
- XP data persists in `xp.json`

### Role Reactions
- Users react to messages to receive roles
- Removing reaction removes the role
- Mappings persist across restarts in `rolereact.json`

### Event System
- Create events with RSVP tracking (✅ Going, ❌ Not Going, ❓ Maybe)
- Automatic reminders sent at event time
- Mentions all users who RSVP'd as "Going"

### Welcome System
- Automatically assigns configured role to new members
- Sends welcome message to configured channel
- Settings persist in `config.json`

---

## Troubleshooting

### Common Issues

**"Used disallowed intents" error on login**
- Enable both privileged intents in the Discord Developer Portal (see setup step 3)

**Jail monitoring not working**
1. Run `/testapi` to verify API connection
2. Run `/debugapi name:YourName` to check if your data is being parsed correctly
3. Ensure you've run `/jail` to configure the channel and role
4. Check console logs for detailed debugging information

**Commands not showing up**
- Make sure `CLIENT_ID` and `GUILD_ID` are set in `.env`
- Commands are registered automatically on bot startup
- Guild commands appear instantly; global commands take up to 1 hour

**Bot can't assign roles**
- Ensure the bot's role is higher than the roles it's trying to assign
- Verify the bot has "Manage Roles" permission

**Deprecation warnings**
- The bot uses `clientReady` event (Discord.js v14+)
- Node.js 18+ native fetch is used (no `node-fetch` dependency needed)

### Debug Commands

Use these admin-only commands to troubleshoot:
- `/testapi` — Verify Torn API connection and see current jail status
- `/debugapi name:PlayerName` — View raw API data for a specific member
- `/testjail` — Send a test jail alert to verify channel configuration

---

## Technical Details

- **Discord.js**: v14.22.1+
- **Node.js**: 18+ (native fetch support required)
- **Torn API**: v2 with `members` selection
- **Event System**: Uses `clientReady` event (not deprecated `ready`)
- **Persistence**: All data stored in JSON files (no database required)

---

## License

ISC

---
