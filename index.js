// Import required modules
import fs from "fs";
import dotenv from "dotenv";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder
} from "discord.js";

dotenv.config();

// Load tokens and IDs from environment
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const TORN_API_KEY = process.env.TORN_API_KEY;
const FACTION_ID = process.env.FACTION_ID;
const GUILD_ID = process.env.GUILD_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const POLL_INTERVAL = (parseInt(process.env.POLL_INTERVAL || "60") || 60) * 1000;
const OC_POLL_INTERVAL = 10 * 60 * 1000; // 10 minutes

// File paths for persistence
const CONFIG_FILE = "./config.json";
const STATE_FILE = "./jailstate.json";
const ROLE_REACT_FILE = "./rolereact.json";
const XP_FILE = "./xp.json";
const NOT_OC_CSV = "./not_oc.csv";
const STRIKES_CSV = "./strikes.csv";
const OC_STATE_FILE = "./oc_state.json";

// Validate required environment variables
if (!DISCORD_TOKEN) {
  console.error("YIKES! Missing DISCORD_TOKEN in .env - I can't login without that bestie");
  process.exit(1);
}
if (!TORN_API_KEY) {
  console.error("OOPSIE WOOPSIE! Missing TORN_API_KEY in .env");
  process.exit(1);
}
if (!FACTION_ID) {
  console.error("BRUH! Missing FACTION_ID in .env - who am I even watching???");
  process.exit(1);
}
if (!CLIENT_ID) {
  console.error("Missing CLIENT_ID in .env - need this to register commands!");
  process.exit(1);
}

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.GuildMember,
    Partials.User
  ],
});

// Load persisted data
let config = fs.existsSync(CONFIG_FILE)
  ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))
  : {};

let jailState = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  : {};

let activeRoleReactMessages = fs.existsSync(ROLE_REACT_FILE)
  ? new Map(JSON.parse(fs.readFileSync(ROLE_REACT_FILE, "utf8")))
  : new Map();

let xpData = fs.existsSync(XP_FILE)
  ? JSON.parse(fs.readFileSync(XP_FILE, "utf8"))
  : {};

// OC state: { [player_id]: { name, not_in_oc_since, warned_12h, oc_ready_since, delay_warned, discord_id } }
let ocState = fs.existsSync(OC_STATE_FILE)
  ? JSON.parse(fs.readFileSync(OC_STATE_FILE, "utf8"))
  : {};

const xpCooldowns = new Map();
const messageCounters = new Map();
const crossChannelSpam = new Map();
const XP_MIN = 5;
const XP_MAX = 15;
const COOLDOWN_MS = 2000;
const SPAM_THRESHOLD = 10;
const SPAM_WINDOW_MS = 7000;
const SPAM_WARN_COOLDOWN = 15000;
const SPAM_TIMEOUT_DURATION = 67;
const CROSS_CHANNEL_SPAM_THRESHOLD = 15;
const CROSS_CHANNEL_SPAM_WINDOW = 10000;
const CROSS_CHANNEL_TIMEOUT_DURATION = 12 * 60 * 60;

// OC thresholds
const OC_WARN_12H = 12 * 60 * 60 * 1000;   // 12 hours in ms
const OC_STRIKE_48H = 48 * 60 * 60 * 1000; // 48 hours in ms
const OC_DELAY_WARN = 20 * 60 * 1000;       // 20 minutes in ms
const STRIKE_EXPIRY_DAYS = 30;

// ─── SAVE HELPERS ─────────────────────────────────────────────────────────────

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
  catch (err) { console.error("Oof couldn't save config:", err); }
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(jailState, null, 2)); }
  catch (err) { console.error("Welp, state save failed:", err); }
}

function saveRoleReactMessages() {
  try { fs.writeFileSync(ROLE_REACT_FILE, JSON.stringify([...activeRoleReactMessages], null, 2)); }
  catch (err) { console.error("Couldn't save role react stuff, rip:", err); }
}

function saveXp() {
  try { fs.writeFileSync(XP_FILE, JSON.stringify(xpData, null, 2)); }
  catch (e) { console.error("Couldn't save XP:", e); }
}

function saveOcState() {
  try { fs.writeFileSync(OC_STATE_FILE, JSON.stringify(ocState, null, 2)); }
  catch (e) { console.error("Couldn't save OC state:", e); }
}

// ─── CSV HELPERS ──────────────────────────────────────────────────────────────

function saveNotOcCsv() {
  try {
    const rows = [["player_id", "name", "not_in_oc_since", "last_seen"]];
    for (const [id, rec] of Object.entries(ocState)) {
      if (rec.not_in_oc_since) {
        rows.push([id, `"${String(rec.name).replace(/"/g, '""')}"`, rec.not_in_oc_since, rec.last_seen || ""]);
      }
    }
    fs.writeFileSync(NOT_OC_CSV, rows.map(r => r.join(",")).join("\n"));
  } catch (e) { console.error("Failed to save not_oc CSV:", e); }
}

// strikes.csv: player_id, name, reason, timestamp, expires_at
function loadStrikes() {
  try {
    if (!fs.existsSync(STRIKES_CSV)) return [];
    const raw = fs.readFileSync(STRIKES_CSV, "utf8").trim();
    if (!raw) return [];
    const lines = raw.split(/\r?\n/);
    lines.shift(); // remove header
    return lines
      .filter(Boolean)
      .map(ln => {
        // handle quoted names with commas
        const match = ln.match(/^([^,]+),"?(.*?)"?,([^,]+),([^,]+),([^,]+)$/);
        if (!match) return null;
        return {
          player_id: match[1],
          name: match[2],
          reason: match[3],
          timestamp: Number(match[4]),
          expires_at: Number(match[5])
        };
      })
      .filter(Boolean);
  } catch (e) {
    console.error("Failed to load strikes:", e);
    return [];
  }
}

function saveStrikes(strikes) {
  try {
    const rows = [["player_id", "name", "reason", "timestamp", "expires_at"]];
    for (const s of strikes) {
      rows.push([s.player_id, `"${String(s.name).replace(/"/g, '""')}"`, s.reason, s.timestamp, s.expires_at]);
    }
    fs.writeFileSync(STRIKES_CSV, rows.map(r => r.join(",")).join("\n"));
  } catch (e) { console.error("Failed to save strikes:", e); }
}

function addStrike(playerId, name, reason) {
  const strikes = loadStrikes();
  const now = Date.now();
  const expiresAt = now + STRIKE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  // Prune expired strikes first
  const active = strikes.filter(s => s.expires_at > now);
  active.push({ player_id: String(playerId), name, reason, timestamp: now, expires_at: expiresAt });
  saveStrikes(active);
  console.log(`[STRIKE] Added strike for ${name} (${playerId}): ${reason}`);
  return active.filter(s => s.player_id === String(playerId)).length;
}

function getActiveStrikes(playerId) {
  const strikes = loadStrikes();
  const now = Date.now();
  return strikes.filter(s => s.player_id === String(playerId) && s.expires_at > now);
}

function getAllActiveStrikes() {
  const strikes = loadStrikes();
  const now = Date.now();
  return strikes.filter(s => s.expires_at > now);
}

// ─── UTILITY ──────────────────────────────────────────────────────────────────

function xpToLevel(xp) {
  xp = Number(xp) || 0;
  return Math.floor(0.1 * Math.sqrt(xp));
}

const playerProfileLink = (id) => `https://www.torn.com/profiles.php?XID=${id}`;

function formatJailTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h (yikes)`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s (literally nothing)`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

// ─── MEMBER NORMALISATION ────────────────────────────────────────────────────

const normalizeMembers = (apiData) => {
  const members = [];
  if (!apiData) { console.error("normalizeMembers: apiData is null/undefined"); return members; }

  let membersData = apiData.members || apiData.faction?.members || apiData;
  if (!membersData) { console.error("normalizeMembers: No members data found. API structure:", Object.keys(apiData)); return members; }

  if (Array.isArray(membersData)) {
    console.log(`Found ${membersData.length} members (array format)`);
    const normalized = membersData.map(m => {
      let jailTime = 0;
      if (m.status?.state === 'Jailed' || m.status?.state === 'Jail') {
        if (m.status.until) {
          const now = Math.floor(Date.now() / 1000);
          jailTime = Math.max(0, m.status.until - now);
        }
      }
      return { player_id: m.id || m.player_id, name: m.name, jail_time: jailTime, status: m.status, organised_crime: m.organised_crime };
    });
    const jailed = normalized.filter(m => m.jail_time > 0);
    if (jailed.length > 0) console.log(`Found ${jailed.length} jailed members:`, jailed.map(m => `${m.name} (${m.jail_time}s)`));
    return normalized;
  }

  for (const key of Object.keys(membersData)) {
    const m = membersData[key];
    let jailTime = 0;
    if (m.status?.state === 'Jailed' || m.status?.state === 'Jail') {
      if (m.status.until) {
        const now = Math.floor(Date.now() / 1000);
        jailTime = Math.max(0, m.status.until - now);
      }
    } else if (m.jail_time !== undefined) {
      jailTime = m.jail_time;
    }
    members.push({
      player_id: m.player_id || m.id || Number(key),
      name: m.name || m.player_name || "Unknown",
      jail_time: jailTime,
      status: m.status,
      organised_crime: m.organised_crime
    });
  }
  console.log(`Normalized ${members.length} members from object format`);
  return members;
};

// ─── OC STATUS HELPERS ───────────────────────────────────────────────────────

/**
 * Returns OC info for a member:
 *   { inOc: bool, isReady: bool, ocName: string|null }
 *
 * Torn API v2 faction members may include an `organised_crime` field:
 *   { id, name, status, time_left, ... }
 * status values seen in the wild: "planning", "ready", "in_progress", "completed"
 * We treat "planning", "ready", "in_progress" all as "in an OC".
 * "ready" specifically means everyone is ready to go but it hasn't been executed yet.
 */
function getOcInfo(member) {
  const oc = member.organised_crime;
  if (!oc) return { inOc: false, isReady: false, ocName: null };

  // If oc is a boolean true (old detection)
  if (oc === true) return { inOc: true, isReady: false, ocName: null };

  // Object form from v2 API
  if (typeof oc === "object") {
    const status = (oc.status || "").toLowerCase();
    const inOc = ["planning", "ready", "in_progress", "scheduled"].includes(status) || !!oc.id;
    const isReady = status === "ready";
    return { inOc, isReady, ocName: oc.name || oc.crime_name || null };
  }

  // Fallback string check on status field
  const s = member.status || {};
  if (typeof s.state === "string" && /organis/i.test(s.state)) {
    return { inOc: true, isReady: false, ocName: null };
  }

  return { inOc: false, isReady: false, ocName: null };
}

// ─── SEND HELPER ─────────────────────────────────────────────────────────────

async function sendToChannel(channelId, payload) {
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    await channel.send(payload);
  } catch (err) {
    console.error(`Failed to send to channel ${channelId}:`, err);
  }
}

// ─── LEGACY not_oc CSV LOADER (preserves data from previous bot runs) ────────

function loadNotOcCsvLegacy() {
  try {
    if (!fs.existsSync(NOT_OC_CSV)) return;
    const raw = fs.readFileSync(NOT_OC_CSV, "utf8").trim();
    if (!raw) return;
    const lines = raw.split(/\r?\n/);
    lines.shift(); // skip header
    let loaded = 0;
    for (const ln of lines) {
      if (!ln) continue;
      // CSV: player_id,name,last_not_in_oc,lastSeen  (name may be quoted)
      const parts = ln.split(",").map(s => s.replace(/^"|"$/g, ""));
      const [player_id, name, last_not_in_oc, lastSeen] = parts;
      if (!player_id) continue;
      // Only seed into ocState if there's no existing entry
      if (!ocState[String(player_id)]) {
        ocState[String(player_id)] = {
          name: name || "Unknown",
          not_in_oc_since: last_not_in_oc ? Number(last_not_in_oc) : null,
          warned_12h: false,
          struck_48h: false,
          oc_ready_since: null,
          delay_warned: false,
          last_seen: lastSeen ? Number(lastSeen) : Date.now()
        };
        loaded++;
      }
    }
    console.log(`[OC] Seeded ${loaded} entries from legacy not_oc.csv into ocState`);
  } catch (e) {
    console.error("Failed to load legacy not_oc CSV:", e);
  }
}

// Build a plain-text report of players not in OC (used by /notinoc)
function buildNotInOcReportText(maxChars) {
  const now = Date.now();
  const entries = Object.entries(ocState).filter(([_, data]) => data.not_in_oc_since !== null && data.not_in_oc_since !== undefined);

  if (entries.length === 0) {
    return "📊 **Not-in-OC Report**\n\nEveryone's in OC! 🎉";
  }

  // Sort by duration (longest not in OC first)
  entries.sort((a, b) => (a[1].not_in_oc_since || now) - (b[1].not_in_oc_since || now));

  let report = "📊 **Not-in-OC Report**\n\n";
  let charCount = report.length;
  let count = 0;

  for (const [id, data] of entries) {
    const name = data.name || "Unknown";
    const durationMs = data.not_in_oc_since ? now - data.not_in_oc_since : 0;
    const durationStr = formatDuration(durationMs);
    const profileLink = playerProfileLink(id);
    const line = `• [${name}](${profileLink}) - ${durationStr}\n`;

    if (charCount + line.length > maxChars) {
      report += `\n*... and ${entries.length - count} more*`;
      break;
    }

    report += line;
    charCount += line.length;
    count++;
  }

  return report;
}

// ─── OC CHECK (runs every 10 mins) ───────────────────────────────────────────

async function checkOrganisedCrime() {
  console.log("[OC CHECK] Running organised crime check...");
  try {
    const apiUrl = `https://api.torn.com/v2/faction/${FACTION_ID}?selections=members&key=${TORN_API_KEY}`;
    const res = await fetch(apiUrl);
    if (!res.ok) { console.error(`[OC CHECK] API error: ${res.status}`); return; }
    const data = await res.json();
    if (data.error) { console.error("[OC CHECK] Torn API error:", data.error); return; }

    const members = normalizeMembers(data);
    const now = Date.now();

    const ocAlertChannelId = config.ocAlertChannelId;
    const delayWarningChannelId = config.delayWarningChannelId;

    for (const m of members) {
      const id = String(m.player_id);
      const name = m.name || ocState[id]?.name || "Unknown";
      const { inOc, isReady, ocName } = getOcInfo(m);

      // Initialise state entry if missing
      if (!ocState[id]) {
        ocState[id] = {
          name,
          not_in_oc_since: inOc ? null : now,
          warned_12h: false,
          struck_48h: false,
          oc_ready_since: null,
          delay_warned: false,
          last_seen: now
        };
      } else {
        ocState[id].name = name;
        ocState[id].last_seen = now;
      }

      const state = ocState[id];

      // ── Branch: member IS in an OC ──────────────────────────────────────
      if (inOc) {
        // Reset "not in OC" timers when they join one
        if (state.not_in_oc_since !== null) {
          console.log(`[OC] ${name} joined an OC — resetting not-in-OC timer`);
          state.not_in_oc_since = null;
          state.warned_12h = false;
          state.struck_48h = false;
        }

        // Track OC ready state for delay strike
        if (isReady) {
          if (!state.oc_ready_since) {
            state.oc_ready_since = now;
            state.delay_warned = false;
            console.log(`[OC] ${name}'s OC is ready! Starting delay timer.`);
          }

          // Check if they've delayed more than 20 minutes
          const readyDuration = now - state.oc_ready_since;
          if (readyDuration >= OC_DELAY_WARN && !state.delay_warned) {
            state.delay_warned = true;
            const strikeCount = addStrike(id, name, "OC delay (20+ mins after ready)");
            console.log(`[OC] ${name} delay strike issued. Total strikes: ${strikeCount}`);

            const embed = new EmbedBuilder()
              .setTitle("⏰ OC DELAY STRIKE")
              .setDescription(`<@&${config.roleId || ""}> **${name}** has been in a ready OC for **${formatDuration(readyDuration)}** and still hasn't executed it!`)
              .addFields(
                { name: "OC", value: ocName || "Unknown", inline: true },
                { name: "Total Strikes", value: `${strikeCount}`, inline: true },
                { name: "Profile", value: `[${name}](${playerProfileLink(id)})`, inline: true }
              )
              .setColor(0xFF6B6B)
              .setFooter({ text: `Strike expires in ${STRIKE_EXPIRY_DAYS} days` })
              .setTimestamp();

            await sendToChannel(delayWarningChannelId || ocAlertChannelId, { embeds: [embed] });
          }
        } else {
          // OC no longer in ready state (was executed or reset)
          if (state.oc_ready_since) {
            console.log(`[OC] ${name}'s OC ready state cleared.`);
            state.oc_ready_since = null;
            state.delay_warned = false;
          }
        }
      }

      // ── Branch: member NOT in an OC ─────────────────────────────────────
      else {
        // Clear OC ready timer if they left
        state.oc_ready_since = null;
        state.delay_warned = false;

        // Start "not in OC" timer
        if (!state.not_in_oc_since) {
          state.not_in_oc_since = now;
          state.warned_12h = false;
          state.struck_48h = false;
          console.log(`[OC] ${name} is not in any OC — timer started`);
        }

        const timeOutMs = now - state.not_in_oc_since;

        // 12h warning
        if (timeOutMs >= OC_WARN_12H && !state.warned_12h) {
          state.warned_12h = true;
          console.log(`[OC] 12h warning for ${name}`);

          const embed = new EmbedBuilder()
            .setTitle("⚠️ OC WARNING — 12 Hours Out")
            .setDescription(`**${name}** has not been in an Organised Crime for **${formatDuration(timeOutMs)}**. Get them into one!`)
            .addFields(
              { name: "Profile", value: `[${name}](${playerProfileLink(id)})`, inline: true },
              { name: "Time without OC", value: formatDuration(timeOutMs), inline: true }
            )
            .setColor(0xFEE75C)
            .setTimestamp();

          await sendToChannel(ocAlertChannelId, { embeds: [embed] });
        }

        // 48h strike
        if (timeOutMs >= OC_STRIKE_48H && !state.struck_48h) {
          state.struck_48h = true;
          const strikeCount = addStrike(id, name, "48h without OC");
          console.log(`[OC] 48h strike for ${name}. Total: ${strikeCount}`);

          const embed = new EmbedBuilder()
            .setTitle("🚨 OC STRIKE — 48 Hours Out")
            .setDescription(`**${name}** has not been in an Organised Crime for **${formatDuration(timeOutMs)}**. A strike has been issued.`)
            .addFields(
              { name: "Profile", value: `[${name}](${playerProfileLink(id)})`, inline: true },
              { name: "Total Strikes", value: `${strikeCount}`, inline: true },
              { name: "Time without OC", value: formatDuration(timeOutMs), inline: true }
            )
            .setColor(0xFF0000)
            .setFooter({ text: `Strike expires in ${STRIKE_EXPIRY_DAYS} days` })
            .setTimestamp();

          await sendToChannel(ocAlertChannelId, { embeds: [embed] });
        }
      }
    }

    saveOcState();
    saveNotOcCsv();
    console.log("[OC CHECK] Done.");
  } catch (err) {
    console.error("[OC CHECK] Error:", err);
  }
}

// ─── AUTO-ROLE & WELCOME ─────────────────────────────────────────────────────

let unverifiedRoleId = config.unverifiedRoleId || null;
let welcomeChannelId = config.welcomeChannelId || null;

client.on("guildMemberAdd", async (member) => {
  try {
    if (unverifiedRoleId) await member.roles.add(unverifiedRoleId);
    if (welcomeChannelId) {
      const ch = await member.guild.channels.fetch(welcomeChannelId).catch(() => null);
      if (ch?.isTextBased()) {
        const embed = new EmbedBuilder()
          .setColor(0x9b59b6)
          .setTitle("🎉 NEW FRIEND ALERT!")
          .setDescription(`Heyooo <@${member.id}>!\n\nVerify your Torn account real quick to unlock the whole server and stuff. Click that shiny link above! ✨`)
          .setTimestamp();
        await ch.send({ content: `Everybody say hi to <@${member.id}>! 👋`, embeds: [embed] });
      }
    }
  } catch (err) { console.error(`Uhhhh something broke welcoming ${member.user.tag}:`, err); }
});

// ─── REACTION ROLE HANDLERS ───────────────────────────────────────────────────

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
  const { emoji, message } = reaction;
  const emojiKey = emoji.id ? `<:${emoji.name}:${emoji.id}>` : emoji.name;
  const emojiRoleMap = activeRoleReactMessages.get(message.id);
  if (!emojiRoleMap) return;
  const roleId = emojiRoleMap[emojiKey] || emojiRoleMap[emoji.name];
  if (!roleId) return;
  const member = await message.guild?.members.fetch(user.id).catch(() => null);
  if (member && !member.roles.cache.has(roleId)) await member.roles.add(roleId).catch(console.error);
});

client.on("messageReactionRemove", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
  const { emoji, message } = reaction;
  const emojiKey = emoji.id ? `<:${emoji.name}:${emoji.id}>` : emoji.name;
  const emojiRoleMap = activeRoleReactMessages.get(message.id);
  if (!emojiRoleMap) return;
  const roleId = emojiRoleMap[emojiKey] || emojiRoleMap[emoji.name];
  if (!roleId) return;
  const member = await message.guild?.members.fetch(user.id).catch(() => null);
  if (member?.roles.cache.has(roleId)) await member.roles.remove(roleId).catch(console.error);
});

// ─── CROSS-CHANNEL SPAM ───────────────────────────────────────────────────────

async function checkCrossChannelSpam(message) {
  const now = Date.now();
  const userId = message.author.id;
  const guildId = message.guild.id;
  const channelId = message.channel.id;
  const crossKey = `${guildId}_${userId}`;
  const userCrossSpam = crossChannelSpam.get(crossKey) || [];
  const recentCrossSpam = userCrossSpam.filter(msg => now - msg.timestamp < CROSS_CHANNEL_SPAM_WINDOW);
  recentCrossSpam.push({ timestamp: now, channelId });
  crossChannelSpam.set(crossKey, recentCrossSpam);
  const uniqueChannels = new Set(recentCrossSpam.map(msg => msg.channelId));
  if (recentCrossSpam.length > CROSS_CHANNEL_SPAM_THRESHOLD && uniqueChannels.size > 2) {
    if (message.member?.moderatable) {
      try {
        await message.member.timeout(CROSS_CHANNEL_TIMEOUT_DURATION * 1000, "Cross-channel spam detected");
        try {
          const fetchedMsgs = await message.channel.messages.fetch({ limit: 50 });
          const toDelete = fetchedMsgs.filter(m => m.author.id === userId && now - m.createdTimestamp < CROSS_CHANNEL_SPAM_WINDOW);
          if (toDelete.size > 0) await message.channel.bulkDelete(toDelete, true).catch(() => {});
        } catch {}
        await message.channel.send(`🚨 <@${userId}> has been timed out for **12 hours** due to cross-channel spamming!`).catch(() => {});
        crossChannelSpam.delete(crossKey);
        return true;
      } catch (err) { console.error("Failed to timeout cross-channel spammer:", err); }
    }
  }
  return false;
}

// ─── MESSAGE / XP HANDLER ────────────────────────────────────────────────────

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.channel?.isTextBased()) return;

    if (await checkCrossChannelSpam(message)) return;

    const now = Date.now();
    const userId = message.author.id;
    const guildId = message.guild.id;
    const spamKey = `${guildId}_${userId}`;
    const userMessages = messageCounters.get(spamKey) || [];
    const recentMessages = userMessages.filter(t => now - t < SPAM_WINDOW_MS);
    recentMessages.push(now);
    messageCounters.set(spamKey, recentMessages);

    if (recentMessages.length > SPAM_THRESHOLD) {
      const lastWarn = message.author.lastSpamWarn || 0;
      if (now - lastWarn > SPAM_WARN_COOLDOWN) {
        try {
          if (message.member?.moderatable) {
            await message.member.timeout(SPAM_TIMEOUT_DURATION * 1000, "Spam detected");
            const canManage = message.channel.permissionsFor?.(client.user)?.has?.("ManageMessages");
            if (canManage) {
              const fetched = await message.channel.messages.fetch({ limit: 100 });
              const toDelete = fetched.filter(m => m.author.id === userId && now - m.createdTimestamp < SPAM_WINDOW_MS);
              if (toDelete.size > 0) await message.channel.bulkDelete(toDelete, true).catch(() => {});
            }
            await message.channel.send(`Hey <@${userId}>, you've been timed out for ${SPAM_TIMEOUT_DURATION}s for spamming!`).catch(() => {});
          } else {
            await message.channel.send(`Hey <@${userId}>, slow down! Spam doesn't count for XP 🙄`).catch(() => {});
          }
          message.author.lastSpamWarn = now;
        } catch (err) { console.error("Spam handling error:", err); }
      }
      return;
    }

    const key = `${guildId}_${userId}`;
    const last = xpCooldowns.get(key) || 0;
    if (now - last < COOLDOWN_MS) return;
    xpCooldowns.set(key, now);

    const gained = Math.floor(Math.random() * (XP_MAX - XP_MIN + 1)) + XP_MIN;
    const prevXp = xpData[userId]?.xp || 0;
    const prevLevel = xpToLevel(prevXp);
    xpData[userId] = xpData[userId] || { xp: 0, messages: 0 };
    xpData[userId].xp += gained;
    xpData[userId].messages = (xpData[userId].messages || 0) + 1;
    saveXp();

    const newLevel = xpToLevel(xpData[userId].xp);
    if (newLevel > prevLevel) {
      const levelEmbed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle("🎉 Level Up!")
        .setDescription(`<@${userId}> just reached **Level ${newLevel}**!`)
        .addFields(
          { name: "Total XP", value: `${xpData[userId].xp}`, inline: true },
          { name: "Messages", value: `${xpData[userId].messages}`, inline: true }
        )
        .setThumbnail(message.author.displayAvatarURL?.({ extension: "png", size: 256 }) || "")
        .setTimestamp();
      await message.channel.send({ embeds: [levelEmbed] }).catch(() => {});
    }
  } catch (err) { console.error("messageCreate error:", err); }
});

// ─── JAIL CHECK ───────────────────────────────────────────────────────────────

async function checkFactionJail() {
  if (!config.channelId || !config.roleId) { console.log("Jail check skipped: not configured"); return; }
  try {
    const apiUrl = `https://api.torn.com/v2/faction/${FACTION_ID}?selections=members&key=${TORN_API_KEY}`;
    console.log(`Calling Torn API: ${apiUrl.replace(TORN_API_KEY, "API_KEY_HIDDEN")}`);
    const res = await fetch(apiUrl);
    if (!res.ok) { console.error(`API said nope: ${res.status}`); return; }
    const data = await res.json();
    if (data.error) { console.error("Torn API error:", data.error); return; }

    const members = normalizeMembers(data);
    const channel = await client.channels.fetch(config.channelId).catch(() => null);
    if (!channel?.isTextBased()) { console.error("Channel config wonky"); return; }

    const currentMemberIds = new Set();
    const now = Date.now();

    for (const m of members) {
      const id = String(m.player_id);
      currentMemberIds.add(id);
      if (typeof jailState[id] !== "object") jailState[id] = { time: 0, lastSeen: now, name: m.name };
      const jailTime = Number(m.jail_time || 0);
      const prevTime = Number(jailState[id].time || 0);
      jailState[id].lastSeen = now;
      jailState[id].name = m.name;

      if (jailTime > 0 && prevTime === 0) {
        const embed = new EmbedBuilder()
          .setTitle(`🚨 ${m.name} GOT ARRESTED`)
          .setDescription(`${m.name} just got thrown in the chambers lmaooo`)
          .addFields(
            { name: "Time left", value: formatJailTime(jailTime), inline: true },
            { name: "Profile", value: `[link for visitors](${playerProfileLink(id)})`, inline: true }
          )
          .setColor(0xFF6B6B).setTimestamp();
        await channel.send({ content: `<@&${config.roleId}> ${m.name} got jailed`, embeds: [embed] });
      }

      if (prevTime > 0 && jailTime === 0) {
        const embed = new EmbedBuilder()
          .setTitle("✅ FREEDOM!!!")
          .setDescription(`${m.name} is out of jail!`)
          .setColor(0x57F287).setTimestamp();
        await channel.send({ content: `${m.name} escaped!!! 🎉`, embeds: [embed] });
      }

      if (prevTime > 0 && jailTime > prevTime + 60) {
        const embed = new EmbedBuilder()
          .setTitle(`🔄 LMAO ${m.name} GOT JAILED AGAIN`)
          .setDescription(`${m.name} got bailed but went right back in HAHAHA`)
          .addFields(
            { name: "New sentence", value: formatJailTime(jailTime), inline: true },
            { name: "Profile", value: `[point and laugh](${playerProfileLink(id)})`, inline: true }
          )
          .setColor(0xFEE75C).setTimestamp();
        await channel.send({ content: `<@&${config.roleId}> ${m.name} can't stay out of trouble smh`, embeds: [embed] });
      }

      jailState[id].time = jailTime;
    }

    const RETENTION_DAYS = 7 * 24 * 60 * 60 * 1000;
    for (const id in jailState) {
      if (!currentMemberIds.has(id) && jailState[id].lastSeen && now - jailState[id].lastSeen > RETENTION_DAYS) {
        delete jailState[id];
      }
    }

    saveState();
  } catch (err) { console.error("Jail check went boom:", err); }
}

// ─── CHAIN WATCH ─────────────────────────────────────────────────────────────

const CHAIN_WATCH_CHANNEL_ID = "1168943503544418354";
const chainWatchSchedule = [
  { userId: "1029159689612689448", datetime: "2025-10-25 10:40", name: "TEST" },
  { userId: "1277971252023263312", datetime: "2025-10-25 18:25", name: "Pooboi" }
];
let sentChainWatch = {};

function parseDateTime(dateTimeStr) {
  const [date, time] = dateTimeStr.split(" ");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

async function processChainWatchSchedule() {
  const now = new Date();
  for (const entry of chainWatchSchedule) {
    const targetTime = parseDateTime(entry.datetime);
    const key = `${entry.userId}_${entry.datetime}_${entry.name}`;
    if (Math.abs(now - targetTime) <= 60000 && !sentChainWatch[key]) {
      const channel = await client.channels.fetch(CHAIN_WATCH_CHANNEL_ID).catch(() => null);
      if (channel?.isTextBased()) {
        await channel.send(`⏰ <@${entry.userId}>\n**Reminder:** ${entry.name} your chain watching starts now! 📺`).catch(() => {});
        sentChainWatch[key] = true;
      }
    }
  }
}

// ─── COMMAND HANDLER ─────────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ── /jail ──────────────────────────────────────────────────────────────────
  if (interaction.commandName === "jail") {
    if (!interaction.member.permissions.has("Administrator"))
      return interaction.reply({ content: "❌ nah you need admin perms for this one chief", ephemeral: true });
    const channel = interaction.options.getChannel("channel");
    const role = interaction.options.getRole("role");
    config.channelId = channel.id;
    config.roleId = role.id;
    saveConfig();
    await interaction.reply(`✅ Jail alerts configured! Channel: ${channel.name}, Role: ${role.name}`);
  }

  // ── /testjail ──────────────────────────────────────────────────────────────
  if (interaction.commandName === "testjail") {
    if (!config.channelId || !config.roleId)
      return interaction.reply("❌ gotta use /jail first to set things up my dude");
    try {
      const channel = await client.channels.fetch(config.channelId);
      if (!channel?.isTextBased()) return interaction.reply("❌ channel doesn't exist anymore lol, reconfigure with /jail");
      const embed = new EmbedBuilder()
        .setTitle("🚨 OH NO THEY GOT ARRESTED (test)")
        .setDescription("TestyMcTest just got thrown in the chambers lmaooo")
        .addFields(
          { name: "When", value: "69m (nice)", inline: true },
          { name: "Profile", value: "[go laugh at them](https://www.torn.com/profiles.php?XID=12345)", inline: true }
        )
        .setColor(0xFF6B6B).setTimestamp();
      await channel.send({ content: `<@&${config.roleId}> yo TestyMcTestFace got jailed (this is a test btw)`, embeds: [embed] });
      await interaction.reply("✅ Test alert sent!");
    } catch (err) {
      console.error("Test alert failed:", err);
      await interaction.reply("❌ something broke, check the logs");
    }
  }

  // ── /testapi ───────────────────────────────────────────────────────────────
  if (interaction.commandName === "testapi") {
    if (!interaction.member.permissions.has("Administrator"))
      return interaction.reply({ content: "❌ need admin perms", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const res = await fetch(`https://api.torn.com/v2/faction/${FACTION_ID}?selections=members&key=${TORN_API_KEY}`);
      const data = await res.json();
      if (data.error) return interaction.editReply(`❌ API Error: ${JSON.stringify(data.error)}`);
      const members = normalizeMembers(data);
      const jailed = members.filter(m => m.jail_time > 0);
      let response = `✅ API is working!\n\n**Total members:** ${members.length}\n**Currently jailed:** ${jailed.length}\n\n`;
      if (jailed.length > 0) response += `**Jailed:**\n` + jailed.map(m => `• ${m.name}: ${formatJailTime(m.jail_time)}`).join("\n");
      else response += "*No jailed members.*";
      await interaction.editReply(response.substring(0, 2000));
    } catch (err) {
      await interaction.editReply(`❌ API test failed: ${err.message}`);
    }
  }

  // ── /debugapi ──────────────────────────────────────────────────────────────
  if (interaction.commandName === "debugapi") {
    if (!interaction.member.permissions.has("Administrator"))
      return interaction.reply({ content: "❌ need admin perms", ephemeral: true });
    const playerName = interaction.options.getString("name");
    await interaction.deferReply({ ephemeral: true });
    try {
      const res = await fetch(`https://api.torn.com/v2/faction/${FACTION_ID}?selections=members&key=${TORN_API_KEY}`);
      const data = await res.json();
      if (data.error) return interaction.editReply(`❌ API Error: ${JSON.stringify(data.error)}`);
      const members = normalizeMembers(data);
      const member = members.find(m => m.name.toLowerCase().includes(playerName.toLowerCase()));
      if (!member) return interaction.editReply(`❌ Could not find member containing "${playerName}"`);
      await interaction.editReply((`**Debug for ${member.name}:**\n\`\`\`json\n${JSON.stringify(member, null, 2)}\n\`\`\``).substring(0, 2000));
    } catch (err) {
      await interaction.editReply(`❌ Debug failed: ${err.message}`);
    }
  }

  // ── /jailstatus ────────────────────────────────────────────────────────────
  if (interaction.commandName === "jailstatus") {
    const jailed = Object.entries(jailState)
      .filter(([_, d]) => d.time > 0)
      .map(([id, d]) => `• [${d.name || "Unknown"}](${playerProfileLink(id)}): ${formatJailTime(d.time)}`)
      .join("\n");
    const embed = new EmbedBuilder()
      .setTitle("🚨 Current Jail Status")
      .setDescription(jailed || "Nobody's in the chambers rn! Everyone's being good :)")
      .setColor(jailed ? 0xFF6B6B : 0x57F287)
      .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /rolereact ─────────────────────────────────────────────────────────────
  if (interaction.commandName === "rolereact") {
    if (!interaction.member.permissions.has("Administrator"))
      return interaction.reply({ content: "❌ admins only", ephemeral: true });
    const pairs = [];
    for (let i = 1; i <= 5; i++) {
      const role = interaction.options.getRole(`role${i}`);
      const emoji = interaction.options.getString(`emoji${i}`);
      if (role && emoji) pairs.push({ role, emoji });
    }
    if (pairs.length === 0) return interaction.reply({ content: "❌ need at least one role/emoji combo", ephemeral: true });
    const embed = new EmbedBuilder()
      .setTitle("🎭 GRAB YOUR ROLES HERE!")
      .setDescription("React below to snag some sick roles!\n")
      .setColor(0x9b59b6)
      .addFields(pairs.map(({ role, emoji }) => ({ name: `${emoji} → ${role.name}`, value: "React to get this one!", inline: true })))
      .setFooter({ text: "unreact to lose the role" })
      .setTimestamp();
    await interaction.reply({ content: "Creating...", ephemeral: true });
    const msg = await interaction.channel.send({ embeds: [embed] });
    for (const { emoji } of pairs) { await msg.react(emoji).catch(console.error); await new Promise(r => setTimeout(r, 500)); }
    const emojiRoleMap = {};
    for (const { role, emoji } of pairs) emojiRoleMap[emoji] = role.id;
    activeRoleReactMessages.set(msg.id, emojiRoleMap);
    saveRoleReactMessages();
    await interaction.editReply({ content: "✅ Role react message is live!", ephemeral: true });
  }

  // ── /setwelcome ────────────────────────────────────────────────────────────
  if (interaction.commandName === "setwelcome") {
    if (!interaction.member.permissions.has("Administrator"))
      return interaction.reply({ content: "❌ admins only", ephemeral: true });
    const channel = interaction.options.getChannel("channel");
    if (!channel.isTextBased()) return interaction.reply({ content: "❌ pick a text channel", ephemeral: true });
    welcomeChannelId = channel.id;
    config.welcomeChannelId = channel.id;
    saveConfig();
    await interaction.reply({ content: `✅ Welcome messages will go to ${channel}`, ephemeral: true });
  }

  // ── /setunverified ─────────────────────────────────────────────────────────
  if (interaction.commandName === "setunverified") {
    if (!interaction.member.permissions.has("Administrator"))
      return interaction.reply({ content: "❌ admins only", ephemeral: true });
    const role = interaction.options.getRole("role");
    unverifiedRoleId = role.id;
    config.unverifiedRoleId = role.id;
    saveConfig();
    await interaction.reply({ content: `✅ New members will get ${role.name}`, ephemeral: true });
  }

  // ── /setocalert ────────────────────────────────────────────────────────────
  if (interaction.commandName === "setocalert") {
    if (!interaction.member.permissions.has("Administrator"))
      return interaction.reply({ content: "❌ admins only", ephemeral: true });
    const channel = interaction.options.getChannel("channel");
    if (!channel.isTextBased()) return interaction.reply({ content: "❌ pick a text channel", ephemeral: true });
    config.ocAlertChannelId = channel.id;
    saveConfig();
    await interaction.reply({ content: `✅ OC warnings (12h + 48h strikes) will post to ${channel}`, ephemeral: true });
  }

  // ── /delaywarning ──────────────────────────────────────────────────────────
  if (interaction.commandName === "delaywarning") {
    if (!interaction.member.permissions.has("Administrator"))
      return interaction.reply({ content: "❌ admins only", ephemeral: true });
    const channel = interaction.options.getChannel("channel");
    if (!channel.isTextBased()) return interaction.reply({ content: "❌ pick a text channel", ephemeral: true });
    config.delayWarningChannelId = channel.id;
    saveConfig();
    await interaction.reply({ content: `✅ OC delay strike warnings will post to ${channel}`, ephemeral: true });
  }

  // ── /oc ────────────────────────────────────────────────────────────────────
  if (interaction.commandName === "oc") {
    const now = Date.now();
    const entries = Object.entries(ocState).filter(([_, d]) => d.not_in_oc_since !== null && d.not_in_oc_since !== undefined);
    if (entries.length === 0) return interaction.reply({ content: "Everyone's in OC or no data yet! 🎉" });
    entries.sort((a, b) => (a[1].not_in_oc_since || now) - (b[1].not_in_oc_since || now));
    const lines = entries.map(([id, d]) => {
      const dur = formatDuration(now - (d.not_in_oc_since || now));
      return `• [${d.name || "Unknown"}](${playerProfileLink(id)}) — out for **${dur}**`;
    });
    let description = lines.join("\n");
    if (description.length > 4000) description = lines.slice(0, 40).join("\n") + `\n\n*...and ${entries.length - 40} more*`;
    const embed = new EmbedBuilder()
      .setTitle("🚨 Players Not in Organised Crime")
      .setDescription(description)
      .setColor(0xFF6B6B)
      .setFooter({ text: `${entries.length} player(s) without OC` })
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }

  // ── /setnotoc ──────────────────────────────────────────────────────────────
  if (interaction.commandName === "setnotoc") {
    if (!interaction.member.permissions.has("Administrator"))
      return interaction.reply({ content: "❌ admins only", ephemeral: true });
    const channel = interaction.options.getChannel("channel");
    if (!channel || !channel.isTextBased())
      return interaction.reply({ content: "❌ pick a text channel", ephemeral: true });
    config.notOcChannelId = channel.id;
    saveConfig();
    await interaction.reply({ content: `✅ Daily Not-in-OC reports will be posted to ${channel} (ID: ${channel.id})`, ephemeral: true });
  }

  // ── /getnotoc ──────────────────────────────────────────────────────────────
  if (interaction.commandName === "getnotoc") {
    const id = config.notOcChannelId || "(not set)";
    await interaction.reply({ content: `Configured Not-in-OC channel id: \`${id}\``, ephemeral: true });
  }

  // ── /notinoc ───────────────────────────────────────────────────────────────
  if (interaction.commandName === "notinoc") {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    try {
      const report = buildNotInOcReportText(1900);
      await interaction.editReply({ content: report });
    } catch (err) {
      console.error("Failed to build/send not-in-OC report:", err);
      await interaction.editReply({ content: "❌ Failed to generate report, check logs." });
    }
  }

  // ── /strikes ───────────────────────────────────────────────────────────────
  if (interaction.commandName === "strikes") {
    const targetName = interaction.options.getString("name");
    const now = Date.now();
    const all = getAllActiveStrikes();

    if (targetName) {
      // Show strikes for specific player
      const playerStrikes = all.filter(s => s.name.toLowerCase().includes(targetName.toLowerCase()));
      if (playerStrikes.length === 0) {
        return interaction.reply({ content: `✅ No active strikes found for **${targetName}**`, ephemeral: true });
      }
      const lines = playerStrikes.map((s, i) => {
        const expiresIn = formatDuration(s.expires_at - now);
        return `**${i + 1}.** ${s.reason}\n  *Issued: <t:${Math.floor(s.timestamp / 1000)}:R> — Expires in ${expiresIn}*`;
      }).join("\n\n");
      const embed = new EmbedBuilder()
        .setTitle(`⚠️ Strikes for ${playerStrikes[0].name}`)
        .setDescription(lines)
        .setColor(0xFF6B6B)
        .setFooter({ text: `${playerStrikes.length} active strike(s) — expire after ${STRIKE_EXPIRY_DAYS} days` })
        .setTimestamp();
      await interaction.reply({ embeds: [embed], ephemeral: true });
    } else {
      // Show all players with strikes
      const grouped = {};
      for (const s of all) {
        if (!grouped[s.player_id]) grouped[s.player_id] = { name: s.name, count: 0 };
        grouped[s.player_id].count++;
      }
      if (Object.keys(grouped).length === 0) {
        return interaction.reply({ content: "✅ No active strikes! Everyone's behaving.", ephemeral: true });
      }
      const sortedEntries = Object.entries(grouped).sort((a, b) => b[1].count - a[1].count);
      const lines = sortedEntries.map(([id, { name, count }]) =>
        `• [${name}](${playerProfileLink(id)}) — **${count}** strike${count !== 1 ? "s" : ""}`
      ).join("\n");
      const embed = new EmbedBuilder()
        .setTitle("⚠️ Active Strikes — All Players")
        .setDescription(lines)
        .setColor(0xFEE75C)
        .setFooter({ text: `Strikes expire ${STRIKE_EXPIRY_DAYS} days after issue` })
        .setTimestamp();
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  // ── /clearstrike ───────────────────────────────────────────────────────────
  if (interaction.commandName === "clearstrike") {
    if (!interaction.member.permissions.has("Administrator"))
      return interaction.reply({ content: "❌ admins only", ephemeral: true });
    const targetName = interaction.options.getString("name");
    const indexArg = interaction.options.getInteger("index");
    const all = loadStrikes();
    const now = Date.now();
    const active = all.filter(s => s.expires_at > now);
    const playerStrikes = active.filter(s => s.name.toLowerCase().includes(targetName.toLowerCase()));

    if (playerStrikes.length === 0)
      return interaction.reply({ content: `❌ No active strikes found for **${targetName}**`, ephemeral: true });

    if (indexArg !== null) {
      // Remove specific strike by 1-based index
      const toRemove = playerStrikes[indexArg - 1];
      if (!toRemove) return interaction.reply({ content: `❌ Strike #${indexArg} not found for ${targetName}`, ephemeral: true });
      const newStrikes = active.filter(s => !(s.player_id === toRemove.player_id && s.timestamp === toRemove.timestamp));
      saveStrikes(newStrikes);
      await interaction.reply({ content: `✅ Removed strike #${indexArg} from **${toRemove.name}** (${toRemove.reason})`, ephemeral: true });
    } else {
      // Remove all strikes for player
      const newStrikes = active.filter(s => !s.name.toLowerCase().includes(targetName.toLowerCase()));
      saveStrikes(newStrikes);
      await interaction.reply({ content: `✅ Cleared **${playerStrikes.length}** strike(s) for **${playerStrikes[0].name}**`, ephemeral: true });
    }
  }

  // ── /profile ───────────────────────────────────────────────────────────────
  if (interaction.commandName === "profile") {
    const user = interaction.options.getUser("user") || interaction.user;
    const data = xpData[user.id] || { xp: 0, messages: 0 };
    const level = xpToLevel(data.xp);
    const xpForLevel = (lvl) => 100 * lvl * lvl;
    const progress = data.xp - xpForLevel(level);
    const needed = xpForLevel(level + 1) - xpForLevel(level);
    const embed = new EmbedBuilder()
      .setTitle(`${user.username}'s Profile`)
      .addFields(
        { name: "Level", value: `${level}`, inline: true },
        { name: "XP", value: `${data.xp} (+${progress}/${needed} to next)`, inline: true },
        { name: "Messages", value: `${data.messages}`, inline: true }
      )
      .setColor(0x5865F2).setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /leaderboard ───────────────────────────────────────────────────────────
  if (interaction.commandName === "leaderboard") {
    const top = Object.entries(xpData).sort((a, b) => (b[1].xp || 0) - (a[1].xp || 0)).slice(0, 10);
    const desc = top.map(([id, d], i) => `${i + 1}. <@${id}> — Level ${xpToLevel(d.xp || 0)} (${d.xp || 0} XP)`).join("\n") || "No data yet.";
    const embed = new EmbedBuilder().setTitle("🏆 XP Leaderboard").setDescription(desc).setColor(0xFFD700).setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /event ─────────────────────────────────────────────────────────────────
  if (interaction.commandName === "event") {
    const title = interaction.options.getString("title");
    const description = interaction.options.getString("description") || "No description provided";
    const timeStr = interaction.options.getString("time");
    const role = interaction.options.getRole("role");
    if (role && !interaction.member.permissions.has("ManageMessages"))
      return interaction.reply({ content: "❌ You need Manage Messages to ping roles with events", ephemeral: true });
    let eventTime;
    try { eventTime = new Date(timeStr); if (isNaN(eventTime.getTime())) throw new Error(); }
    catch { return interaction.reply({ content: "❌ Invalid time format. Use `YYYY-MM-DDTHH:MM:SSZ`", ephemeral: true }); }
    const now = new Date();
    if (eventTime <= now) return interaction.reply({ content: "❌ Event must be in the future!", ephemeral: true });
    const unixTimestamp = Math.floor(eventTime.getTime() / 1000);
    const embed = new EmbedBuilder()
      .setTitle(`📅 ${title}`).setDescription(description)
      .addFields(
        { name: "When", value: `<t:${unixTimestamp}:F>\n(<t:${unixTimestamp}:R>)`, inline: false },
        { name: "RSVP", value: "✅ Going\n❌ Not going\n❓ Maybe", inline: false }
      )
      .setColor(0x5865F2).setFooter({ text: `Created by ${interaction.user.tag}` }).setTimestamp();
    await interaction.reply({ content: "Creating event...", ephemeral: true });
    const msg = await interaction.channel.send({ content: role ? `<@&${role.id}> 📅 New event!` : "📅 New event!", embeds: [embed] });
    await msg.react("✅"); await msg.react("❌"); await msg.react("❓");
    const going = new Set(), notGoing = new Set(), maybe = new Set();
    const collector = msg.createReactionCollector({ filter: (r, u) => ["✅","❌","❓"].includes(r.emoji.name) && !u.bot, time: eventTime - now });
    const updateEmbed = () => {
      const updated = EmbedBuilder.from(msg.embeds[0]).spliceFields(1, 1, { name: "RSVP", value: `✅ Going (${going.size})\n❌ Not going (${notGoing.size})\n❓ Maybe (${maybe.size})`, inline: false });
      msg.edit({ embeds: [updated] }).catch(() => {});
    };
    collector.on("collect", (r, u) => { going.delete(u.id); notGoing.delete(u.id); maybe.delete(u.id); if (r.emoji.name === "✅") going.add(u.id); else if (r.emoji.name === "❌") notGoing.add(u.id); else maybe.add(u.id); updateEmbed(); });
    collector.on("remove", (r, u) => { if (r.emoji.name === "✅") going.delete(u.id); else if (r.emoji.name === "❌") notGoing.delete(u.id); else maybe.delete(u.id); updateEmbed(); });
    setTimeout(async () => {
      if (going.size === 0) { await msg.reply("Event is starting, but nobody RSVP'd! 😢"); return; }
      await msg.reply(`⏰ **${title} is starting now!** ${Array.from(going).map(id => `<@${id}>`).join(" ")}`);
    }, eventTime - now);
    await interaction.editReply({ content: "✅ Event created!", ephemeral: true });
  }

  // ── /vote ──────────────────────────────────────────────────────────────────
  if (interaction.commandName === "vote") {
    const text = interaction.options.getString("text");
    const emojis = [];
    for (let i = 1; i <= 5; i++) { const e = interaction.options.getString(`emoji${i}`); if (e) emojis.push(e); }
    if (emojis.length < 2) return interaction.reply({ content: "❌ Need at least 2 emoji choices.", ephemeral: true });
    const embed = new EmbedBuilder()
      .setTitle("🗳️ Poll").setDescription(text)
      .addFields(emojis.map((e, i) => ({ name: `Choice ${i + 1}`, value: `${e} — **0** votes`, inline: false })))
      .setColor(0x5865F2).setFooter({ text: `Poll by ${interaction.user.tag}` }).setTimestamp();
    await interaction.reply({ content: "Poll created!", ephemeral: true });
    const msg = await interaction.channel.send({ embeds: [embed] });
    for (const e of emojis) { try { await msg.react(e); } catch {} await new Promise(r => setTimeout(r, 300)); }
    const voteCounts = new Map(emojis.map(e => [e, new Set()]));
    const collector = msg.createReactionCollector({ filter: (r, u) => !u.bot && emojis.includes(r.emoji.name || r.emoji.id), time: 60 * 60 * 1000 });
    const updatePoll = () => {
      const updated = EmbedBuilder.from(msg.embeds[0]).setFields(emojis.map((e, i) => ({ name: `Choice ${i + 1}`, value: `${e} — **${voteCounts.get(e)?.size || 0}** votes`, inline: false })));
      msg.edit({ embeds: [updated] }).catch(() => {});
    };
    collector.on("collect", async (r, u) => {
      const e = r.emoji.name || r.emoji.id;
      for (const [k, set] of voteCounts) { if (k !== e) { set.delete(u.id); const rx = msg.reactions.cache.get(k); if (rx) await rx.users.remove(u.id).catch(() => {}); } }
      voteCounts.get(e)?.add(u.id); updatePoll();
    });
    collector.on("remove", (r, u) => { voteCounts.get(r.emoji.name || r.emoji.id)?.delete(u.id); updatePoll(); });
    collector.on("end", () => {
      const final = EmbedBuilder.from(msg.embeds[0]).setTitle("🗳️ Poll (Closed)").setFields(emojis.map((e, i) => ({ name: `Choice ${i + 1}`, value: `${e} — **${voteCounts.get(e)?.size || 0}** final votes`, inline: false })));
      msg.edit({ embeds: [final] }).catch(() => {});
    });
  }
});

// ─── COMMAND REGISTRATION ────────────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  const commands = [
    new SlashCommandBuilder()
      .setName("jail").setDescription("Configure jail alert notifications")
      .addChannelOption(o => o.setName("channel").setDescription("Channel for jail alerts").setRequired(true))
      .addRoleOption(o => o.setName("role").setDescription("Role to ping").setRequired(true)),
    new SlashCommandBuilder().setName("testjail").setDescription("Send a test jail alert"),
    new SlashCommandBuilder().setName("testapi").setDescription("Test the Torn API connection"),
    new SlashCommandBuilder()
      .setName("debugapi").setDescription("Show raw API data for a specific member")
      .addStringOption(o => o.setName("name").setDescription("Player name").setRequired(true)),
    new SlashCommandBuilder().setName("jailstatus").setDescription("Check who's currently in jail"),
    new SlashCommandBuilder()
      .setName("rolereact").setDescription("Create a role reaction message")
      .addRoleOption(o => o.setName("role1").setDescription("Role 1").setRequired(true))
      .addStringOption(o => o.setName("emoji1").setDescription("Emoji 1").setRequired(true))
      .addRoleOption(o => o.setName("role2").setDescription("Role 2").setRequired(false))
      .addStringOption(o => o.setName("emoji2").setDescription("Emoji 2").setRequired(false))
      .addRoleOption(o => o.setName("role3").setDescription("Role 3").setRequired(false))
      .addStringOption(o => o.setName("emoji3").setDescription("Emoji 3").setRequired(false))
      .addRoleOption(o => o.setName("role4").setDescription("Role 4").setRequired(false))
      .addStringOption(o => o.setName("emoji4").setDescription("Emoji 4").setRequired(false))
      .addRoleOption(o => o.setName("role5").setDescription("Role 5").setRequired(false))
      .addStringOption(o => o.setName("emoji5").setDescription("Emoji 5").setRequired(false)),
    new SlashCommandBuilder()
      .setName("setwelcome").setDescription("Set the welcome message channel")
      .addChannelOption(o => o.setName("channel").setDescription("Channel for welcome messages").setRequired(true)),
    new SlashCommandBuilder()
      .setName("setunverified").setDescription("Set the unverified role for new members")
      .addRoleOption(o => o.setName("role").setDescription("Role for new members").setRequired(true)),
    new SlashCommandBuilder()
      .setName("setnotoc").setDescription("Configure daily Not-in-OC report channel")
      .addChannelOption(o => o.setName("channel").setDescription("Channel for Not-in-OC reports").setRequired(true)),
    new SlashCommandBuilder()
      .setName("getnotoc").setDescription("Show configured Not-in-OC report channel"),
    new SlashCommandBuilder()
      .setName("notinoc").setDescription("Post the not-in-OC report (ephemeral)"),
    new SlashCommandBuilder()
      .setName("setocalert").setDescription("Set channel for OC 12h warnings and 48h strikes")
      .addChannelOption(o => o.setName("channel").setDescription("OC alert channel").setRequired(true)),
    new SlashCommandBuilder()
      .setName("delaywarning").setDescription("Set channel for OC delay strike alerts (20+ min after ready)")
      .addChannelOption(o => o.setName("channel").setDescription("Delay warning channel").setRequired(true)),
    new SlashCommandBuilder()
      .setName("oc").setDescription("Show all players currently not in an Organised Crime"),
    new SlashCommandBuilder()
      .setName("strikes").setDescription("View active strikes")
      .addStringOption(o => o.setName("name").setDescription("Player name to look up (leave blank for all)").setRequired(false)),
    new SlashCommandBuilder()
      .setName("clearstrike").setDescription("Admin: clear strikes for a player")
      .addStringOption(o => o.setName("name").setDescription("Player name").setRequired(true))
      .addIntegerOption(o => o.setName("index").setDescription("Strike number to remove (leave blank to clear all)").setRequired(false)),
    new SlashCommandBuilder()
      .setName("event").setDescription("Create an event with RSVP tracking")
      .addStringOption(o => o.setName("title").setDescription("Event title").setRequired(true))
      .addStringOption(o => o.setName("time").setDescription("Event time (YYYY-MM-DDTHH:MM:SSZ)").setRequired(true))
      .addStringOption(o => o.setName("description").setDescription("Event description").setRequired(false))
      .addRoleOption(o => o.setName("role").setDescription("Role to ping").setRequired(false)),
    new SlashCommandBuilder()
      .setName("profile").setDescription("View XP profile")
      .addUserOption(o => o.setName("user").setDescription("User to check").setRequired(false)),
    new SlashCommandBuilder().setName("leaderboard").setDescription("View the XP leaderboard"),
    new SlashCommandBuilder()
      .setName("vote").setDescription("Start a poll")
      .addStringOption(o => o.setName("text").setDescription("Poll question").setRequired(true))
      .addStringOption(o => o.setName("emoji1").setDescription("Choice 1").setRequired(true))
      .addStringOption(o => o.setName("emoji2").setDescription("Choice 2").setRequired(true))
      .addStringOption(o => o.setName("emoji3").setDescription("Choice 3").setRequired(false))
      .addStringOption(o => o.setName("emoji4").setDescription("Choice 4").setRequired(false))
      .addStringOption(o => o.setName("emoji5").setDescription("Choice 5").setRequired(false)),
  ].map(cmd => cmd.toJSON());

  try {
    console.log("Registering slash commands globally...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ All commands registered!");
  } catch (err) { console.error("Failed to register commands:", err); }
}

// Load any existing not_oc.csv data into ocState on startup
loadNotOcCsvLegacy();

// ─── STARTUP ─────────────────────────────────────────────────────────────────

let _readyHandled = false;
async function handleClientReady() {
  if (_readyHandled) return;
  _readyHandled = true;
  try {
    console.log(`Logged in as ${client.user?.tag || "unknown user"}!`);
    client.user.setActivity("mommy ASMR", { type: 2 });
    unverifiedRoleId = config.unverifiedRoleId || null;
    welcomeChannelId = config.welcomeChannelId || null;

    await registerCommands();

    // Initial checks
    try { await checkFactionJail(); } catch (err) { console.error("Initial jail check error:", err); }
    try { await checkOrganisedCrime(); } catch (err) { console.error("Initial OC check error:", err); }

    processChainWatchSchedule();

    // Jail check every POLL_INTERVAL (default 60s)
    setInterval(async () => {
      try { await checkFactionJail(); } catch (err) { console.error("Jail check error:", err); }
      processChainWatchSchedule();
    }, POLL_INTERVAL);

    // OC check every 10 minutes
    setInterval(async () => {
      try { await checkOrganisedCrime(); } catch (err) { console.error("OC check error:", err); }
    }, OC_POLL_INTERVAL);

  } catch (err) { console.error("Error in ready handler:", err); }
}

client.once("clientReady", handleClientReady);
client.login(DISCORD_TOKEN);