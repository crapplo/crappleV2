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

// ─── FEATURE 7: CENTRALISED RUNTIME CONFIG ───────────────────────────────────
// These are loaded from .env but also exposed here for clarity and easy override.
// chainChannelId and ocChannelId are loaded from the persisted config.json at
// startup (set via /setchainchannel and /setocalert slash commands).
const runtimeConfig = {
  tornApiKey: TORN_API_KEY,
  factionId: FACTION_ID,
  // chainChannelId and ocChannelId are read from config.json at runtime
};

// File paths for persistence
const CONFIG_FILE = "./config.json";
const STATE_FILE = "./jailstate.json";
const ROLE_REACT_FILE = "./rolereact.json";
const XP_FILE = "./xp.json";
const NOT_OC_CSV = "./not_oc.csv";
const STRIKES_CSV = "./strikes.csv";
const OC_STATE_FILE = "./oc_state.json";

// ─── FEATURE 1 & 2: NEW DATA FILE PATHS ──────────────────────────────────────
const DATA_DIR = "./data";
const CHAINS_FILE = `${DATA_DIR}/chains.json`;
const MONTHLY_HITS_FILE = `${DATA_DIR}/monthly_hits.json`;
const MONTHLY_REPORTS_FILE = `${DATA_DIR}/monthly_reports.json`;

// Ensure ./data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log("[CHAIN] Created ./data directory");
}

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

// ─── FEATURE 1: LOAD CHAIN DATA ──────────────────────────────────────────────
let chainsData = fs.existsSync(CHAINS_FILE)
  ? JSON.parse(fs.readFileSync(CHAINS_FILE, "utf8"))
  : {};

// ─── FEATURE 2: LOAD MONTHLY HITS DATA ───────────────────────────────────────
let monthlyHitsData = fs.existsSync(MONTHLY_HITS_FILE)
  ? JSON.parse(fs.readFileSync(MONTHLY_HITS_FILE, "utf8"))
  : {};
// ─── MONTHLY REPORTS: LOAD PERSISTED REPORT DATA ─────────────────────────────
let monthlyReportsData = fs.existsSync(MONTHLY_REPORTS_FILE)
  ? JSON.parse(fs.readFileSync(MONTHLY_REPORTS_FILE, "utf8"))
  : {};

// OC state: { [player_id]: { name, not_in_oc_since, warned_12h, struck_48h, oc_ready_since, delay_warned, first_seen } }
// OC thresholds
const OC_WARN_12H = 12 * 60 * 60 * 1000;   // 12 hours in ms
const OC_STRIKE_48H = 48 * 60 * 60 * 1000; // 48 hours in ms
const OC_DELAY_WARN = 10 * 60 * 1000;       // 10 minutes in ms
const STRIKE_EXPIRY_DAYS = 30;

// ─── FEATURE 6: OC SLOT VACANCY TRACKING ─────────────────────────────────────
// Tracks which crimes have been warned about open slots to avoid spam
const ocSlotWarnedCrimes = new Set();

function loadOcState() {
  if (!fs.existsSync(OC_STATE_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(OC_STATE_FILE, "utf8"));
    const now = Date.now();
    for (const [id, s] of Object.entries(raw)) {
      if (s.not_in_oc_since) {
        const elapsed = now - s.not_in_oc_since;
        if (elapsed >= OC_STRIKE_48H) { s.warned_12h = true; s.struck_48h = true; }
        else if (elapsed >= OC_WARN_12H) { s.warned_12h = true; }
      }
      delete s.first_seen;
    }
    return raw;
  } catch (e) {
    console.error("Failed to load oc_state.json:", e);
    return {};
  }
}
let ocState = loadOcState();

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

// ─── CHAIN POLLING STATE ──────────────────────────────────────────────────────
// Tracks the last known chain length to detect when a chain ends
let lastChainLength = 0;
let lastChainActive = false;
const CHAIN_POLL_INTERVAL = 60 * 1000; // 60 seconds


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

// ─── FEATURE 1: SAVE CHAIN DATA ──────────────────────────────────────────────
function saveChainsData() {
  try { fs.writeFileSync(CHAINS_FILE, JSON.stringify(chainsData, null, 2)); }
  catch (e) { console.error("[CHAIN] Couldn't save chains.json:", e); }
}

// ─── FEATURE 2: SAVE MONTHLY HITS DATA ───────────────────────────────────────
function saveMonthlyHitsData() {
  try { fs.writeFileSync(MONTHLY_HITS_FILE, JSON.stringify(monthlyHitsData, null, 2)); }
  catch (e) { console.error("[CHAIN] Couldn't save monthly_hits.json:", e); }
}

// ─── MONTHLY REPORTS: SAVE ───────────────────────────────────────────────────
function saveMonthlyReportsData() {
  try { fs.writeFileSync(MONTHLY_REPORTS_FILE, JSON.stringify(monthlyReportsData, null, 2)); }
  catch (e) { console.error("[REPORT] Couldn't save monthly_reports.json:", e); }
}


// ─── CSV HELPERS ──────────────────────────────────────────────────────────────

function tsToHuman(ms) {
  if (!ms) return "";
  return new Date(ms).toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
}

function saveNotOcCsv() {
  try {
    const rows = [["player_id", "name", "not_in_oc_since_ts", "not_in_oc_since", "last_seen"]];
    for (const [id, rec] of Object.entries(ocState)) {
      if (rec.not_in_oc_since && !rec.first_seen) {
        rows.push([
          id,
          `"${String(rec.name).replace(/"/g, '""')}"`,
          rec.not_in_oc_since,
          `"${tsToHuman(rec.not_in_oc_since)}"`,
          rec.last_seen || ""
        ]);
      }
    }
    fs.writeFileSync(NOT_OC_CSV, rows.map(r => r.join(",")).join("\n"));
  } catch (e) { console.error("Failed to save not_oc CSV:", e); }
}

function loadStrikes() {
  try {
    if (!fs.existsSync(STRIKES_CSV)) return [];
    const raw = fs.readFileSync(STRIKES_CSV, "utf8").trim();
    if (!raw) return [];
    const lines = raw.split(/\r?\n/);
    lines.shift();
    return lines
      .filter(Boolean)
      .map(ln => {
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
    const rows = [["player_id", "name", "reason", "issued_ts", "issued_at", "expires_ts", "expires_at"]];
    for (const s of strikes) {
      rows.push([
        s.player_id,
        `"${String(s.name).replace(/"/g, '""')}"`,
        s.reason,
        s.timestamp,
        `"${tsToHuman(s.timestamp)}"`,
        s.expires_at,
        `"${tsToHuman(s.expires_at)}"`
      ]);
    }
    fs.writeFileSync(STRIKES_CSV, rows.map(r => r.join(",")).join("\n"));
  } catch (e) { console.error("Failed to save strikes:", e); }
}

function addStrike(playerId, name, reason) {
  const strikes = loadStrikes();
  const now = Date.now();
  const expiresAt = now + STRIKE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
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

// ─── FEATURE 2 & 4: GET CURRENT MONTH KEY (YYYY-MM) ──────────────────────────
function getMonthKey(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

// ─── FEATURE 1 & 4: RESOLVE TORN PLAYER NAMES ────────────────────────────────
// Fetches player names from Torn API for a list of player IDs.
// Returns a Map of { id -> name }. Gracefully handles missing/errored entries.
async function resolveTornPlayerNames(playerIds) {
  const nameMap = new Map();
  if (!playerIds || playerIds.length === 0) return nameMap;

  // Torn API allows comma-separated IDs for user lookups
  // We batch in groups of 100 to respect URL length limits
  const BATCH_SIZE = 100;
  for (let i = 0; i < playerIds.length; i += BATCH_SIZE) {
    const batch = playerIds.slice(i, i + BATCH_SIZE);
    try {
      // Use the /v2/user endpoint with multiple IDs for efficiency
      const ids = batch.join(",");
      const url = `https://api.torn.com/user/${ids}?selections=basic&key=${TORN_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[CHAIN] Name lookup HTTP error: ${res.status}`);
        continue;
      }
      const data = await res.json();
      if (data.error) {
        console.warn(`[CHAIN] Name lookup API error:`, data.error);
        continue;
      }
      // Response is either a single user object or a map of {id: userObj}
      if (batch.length === 1) {
        // Single user response
        const id = String(batch[0]);
        if (data.name) nameMap.set(id, data.name);
      } else {
        // Multi-user response: { "12345": { name: "...", ... }, ... }
        for (const [id, userData] of Object.entries(data)) {
          if (userData && userData.name) nameMap.set(String(id), userData.name);
        }
      }
    } catch (err) {
      console.warn(`[CHAIN] Failed to resolve names for batch:`, err.message);
    }
  }
  return nameMap;
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


// ─── LEGACY not_oc CSV LOADER ────────────────────────────────────────────────

function loadNotOcCsvLegacy() {
  try {
    if (!fs.existsSync(NOT_OC_CSV)) return;
    const raw = fs.readFileSync(NOT_OC_CSV, "utf8").trim();
    if (!raw) return;
    const lines = raw.split(/\r?\n/);
    lines.shift();
    let loaded = 0;
    for (const ln of lines) {
      if (!ln) continue;
      const parts = ln.split(",").map(s => s.replace(/^"|"$/g, ""));
      const [player_id, name, last_not_in_oc, lastSeen] = parts;
      if (!player_id) continue;
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

function buildNotInOcReportText(maxChars) {
  const now = Date.now();
  const entries = Object.entries(ocState).filter(([_, data]) => data.not_in_oc_since !== null && data.not_in_oc_since !== undefined);

  if (entries.length === 0) {
    return "📊 **Not-in-OC Report**\n\nEveryone's in OC! 🎉";
  }

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


// ─── FEATURE 1: FETCH AND PROCESS CHAIN REPORT ───────────────────────────────
// Fetches the latest chain report from Torn API and saves it to chains.json.
// Also triggers monthly hit accumulation (Feature 2) and Discord post (Feature 3).
async function fetchAndProcessChainReport(chainLength) {
  console.log(`[CHAIN] Fetching chain report for chain length ~${chainLength}...`);
  try {
    // Torn API v2 chain report endpoint
    const url = `https://api.torn.com/v2/faction/${FACTION_ID}?selections=chainreport&key=${TORN_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[CHAIN] Chain report HTTP error: ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (data.error) {
      console.error("[CHAIN] Chain report API error:", data.error);
      return null;
    }

    // Navigate to chainreport — handle both v1 and v2 response shapes
    const report = data.chainreport || data.faction?.chainreport || data;
    if (!report || !report.chain) {
      console.warn("[CHAIN] Chain report response missing expected structure:", JSON.stringify(data).substring(0, 200));
      return null;
    }

    const actualChainLength = report.chain;
    const respect = report.respect || 0;
    const timestamp = Math.floor(Date.now() / 1000);

    // Build normalised member hit map: { "playerId": attackCount }
    const memberHits = {};
    const rawMembers = report.members || {};
    for (const [userId, memberData] of Object.entries(rawMembers)) {
      const attacks = memberData.attacks || memberData.hits || 0;
      memberHits[String(userId)] = attacks;
    }

    // ── Feature 1: Persist to chains.json ─────────────────────────────────
    const chainKey = String(actualChainLength);
    chainsData[chainKey] = {
      timestamp,
      respect,
      members: memberHits
    };
    saveChainsData();
    console.log(`[CHAIN] Saved chain ${chainKey} with ${Object.keys(memberHits).length} members to chains.json`);

    // ── Feature 2: Accumulate monthly hits ────────────────────────────────
    accumulateMonthlyHits(memberHits);

    // ── Feature 3: Post results to Discord ────────────────────────────────
    await postChainResultsEmbed(actualChainLength, respect, memberHits, timestamp);

    return { chainLength: actualChainLength, respect, memberHits };
  } catch (err) {
    console.error("[CHAIN] Error fetching chain report:", err);
    return null;
  }
}

// ─── FEATURE 2: ACCUMULATE MONTHLY HITS ──────────────────────────────────────
// Adds each member's attack count from a chain to their running monthly total.
function accumulateMonthlyHits(memberHits) {
  const monthKey = getMonthKey();

  // Create month entry if it doesn't exist yet
  if (!monthlyHitsData[monthKey]) {
    monthlyHitsData[monthKey] = {};
    console.log(`[CHAIN] Created new monthly entry for ${monthKey}`);
  }

  for (const [userId, hits] of Object.entries(memberHits)) {
    const prev = monthlyHitsData[monthKey][userId] || 0;
    monthlyHitsData[monthKey][userId] = prev + hits;
  }

  saveMonthlyHitsData();
  console.log(`[CHAIN] Updated monthly hits for ${monthKey} — ${Object.keys(memberHits).length} members updated`);
}

// ─── FEATURE 3: POST CHAIN RESULTS EMBED ─────────────────────────────────────
// Sends a rich embed to the configured chain results channel when a chain ends.
async function postChainResultsEmbed(chainLength, respect, memberHits, timestamp) {
  const channelId = config.chainChannelId;
  if (!channelId) {
    console.log("[CHAIN] No chainChannelId configured, skipping chain results post. Use /setchainchannel to set one.");
    return;
  }

  // Sort members by hits descending
  const sorted = Object.entries(memberHits)
    .sort((a, b) => b[1] - a[1]);

  // Resolve player names from Torn API
  const allIds = sorted.map(([id]) => id);
  const nameMap = await resolveTornPlayerNames(allIds);

  // Build top hitters text (show top 10)
  const medals = ["🥇", "🥈", "🥉"];
  const topHitters = sorted.slice(0, 10).map(([id, hits], i) => {
    const name = nameMap.get(id) || `Player ${id}`;
    const medal = medals[i] || `**${i + 1}.**`;
    return `${medal} [${name}](${playerProfileLink(id)}) — **${hits}** hits`;
  }).join("\n");

  // Count members with 0 hits (those in faction but not in chain report)
  const zeroHitters = sorted.filter(([_, hits]) => hits === 0).length;

  const embed = new EmbedBuilder()
    .setTitle("🔥 Chain Complete!")
    .setColor(0xFF4500)
    .addFields(
      { name: "Chain Length", value: `**${chainLength.toLocaleString()}**`, inline: true },
      { name: "Respect Earned", value: `**${Number(respect).toLocaleString(undefined, { maximumFractionDigits: 2 })}**`, inline: true },
      { name: "Participants", value: `**${sorted.filter(([_, h]) => h > 0).length}** members hit`, inline: true },
      { name: "🏆 Top Hitters", value: topHitters || "No data", inline: false },
      { name: "😴 Members with 0 Hits", value: zeroHitters > 0 ? `${zeroHitters} member(s) contributed nothing` : "Everyone pitched in!", inline: false }
    )
    .setFooter({ text: `Chain ended` })
    .setTimestamp(timestamp * 1000);

  await sendToChannel(channelId, { embeds: [embed] });
  console.log(`[CHAIN] Posted chain results embed to channel ${channelId}`);
}

// ─── FEATURE 1: CHAIN POLL — DETECT CHAIN END ────────────────────────────────
// Polls the Torn API faction chain endpoint every minute.
// When a chain transitions from active to inactive, triggers chain report fetch.
async function checkChainStatus() {
  try {
    const url = `https://api.torn.com/v2/faction/${FACTION_ID}?selections=chain&key=${TORN_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) { console.warn(`[CHAIN] Chain status HTTP error: ${res.status}`); return; }
    const data = await res.json();
    if (data.error) { console.warn("[CHAIN] Chain status API error:", data.error); return; }

    // Navigate chain data — handle both v1 and v2 shapes
    const chainData = data.chain || data.faction?.chain;
    if (!chainData) { return; } // No chain data available

    // The `current` field is the live chain counter; `timeout` is seconds remaining.
    // A chain is "active" if timeout > 0 (it hasn't timed out yet).
    const currentLength = chainData.current || chainData.chain || 0;
    const timeout = chainData.timeout || 0;
    const isActive = timeout > 0 && currentLength > 0;

    console.log(`[CHAIN] Status — length: ${currentLength}, timeout: ${timeout}s, active: ${isActive}`);

    // Detect transition: was active last tick, now inactive → chain just ended
    if (lastChainActive && !isActive && lastChainLength > 0) {
      console.log(`[CHAIN] Chain ended! Last length: ${lastChainLength}. Fetching report in 30s (API delay)...`);
      // Wait 30 seconds for Torn to generate the report before fetching
      setTimeout(() => fetchAndProcessChainReport(lastChainLength), 30 * 1000);
    }

    lastChainLength = currentLength;
    lastChainActive = isActive;

  } catch (err) {
    console.error("[CHAIN] Error checking chain status:", err);
  }
}

// ─── FEATURE 4: MONTHLY LEADERBOARD ──────────────────────────────────────────
// Sends monthly leaderboard on the 1st of each month.
// Also used by the /monthlyleaderboard command.
async function getMonthlyLeaderboardEmbed(monthKey = null) {
  const targetMonth = monthKey || getMonthKey();
  const monthData = monthlyHitsData[targetMonth];

  if (!monthData || Object.keys(monthData).length === 0) {
    return new EmbedBuilder()
      .setTitle("🔥 Monthly Chain Leaderboard")
      .setDescription(`No chain data recorded for **${targetMonth}** yet.`)
      .setColor(0xFF4500)
      .setTimestamp();
  }

  // Sort by hit count descending, take top 10
  const sorted = Object.entries(monthData)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Resolve player names
  const nameMap = await resolveTornPlayerNames(sorted.map(([id]) => id));

  const medals = ["🥇", "🥈", "🥉"];
  const lines = sorted.map(([id, hits], i) => {
    const name = nameMap.get(id) || `Player ${id}`;
    const medal = medals[i] || `**${i + 1}.**`;
    return `${medal} [${name}](${playerProfileLink(id)}) — **${hits.toLocaleString()}** hits`;
  }).join("\n");

  // Calculate total hits this month for context
  const totalHits = Object.values(monthData).reduce((a, b) => a + b, 0);

  return new EmbedBuilder()
    .setTitle(`🔥 Monthly Chain Leaderboard — ${targetMonth}`)
    .setDescription(lines)
    .addFields({ name: "Total Hits This Month", value: totalHits.toLocaleString(), inline: true })
    .setColor(0xFFD700)
    .setTimestamp();
}

// Check on 1st of month at noon UTC (runs inside the OC poll interval)
async function checkMonthlyLeaderboardTrigger() {
  const now = new Date();
  const day = now.getUTCDate();
  const hour = now.getUTCHours();
  const today = now.toDateString();

  if (day === 1 && hour === 12 && config.lastMonthlyLeaderboardSent !== today && config.chainChannelId) {
    try {
      // Get the previous month's leaderboard
      const prevDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const prevMonthKey = getMonthKey(prevDate);
      const embed = await getMonthlyLeaderboardEmbed(prevMonthKey);
      await sendToChannel(config.chainChannelId, { embeds: [embed] });
      config.lastMonthlyLeaderboardSent = today;
      saveConfig();
      console.log("[CHAIN] Monthly leaderboard posted for", prevMonthKey);
    } catch (err) {
      console.error("[CHAIN] Failed to send monthly leaderboard:", err);
    }
  }
}

// ─── FEATURE 5: CHAIN STATS HELPER FOR /chainstats ───────────────────────────
// Returns stats for a specific Torn player ID across all recorded chains.
function getPlayerChainStats(tornPlayerId) {
  const idStr = String(tornPlayerId);
  const monthKey = getMonthKey();
  const monthlyHits = (monthlyHitsData[monthKey] || {})[idStr] || 0;

  // Count chains participated in and total hits across all recorded chains
  let chainsParticipated = 0;
  let totalHitsAllTime = 0;

  for (const [, chainRecord] of Object.entries(chainsData)) {
    const hits = chainRecord.members?.[idStr];
    if (hits !== undefined) {
      chainsParticipated++;
      totalHitsAllTime += hits;
    }
  }

  const avgHitsPerChain = chainsParticipated > 0
    ? Math.round(totalHitsAllTime / chainsParticipated)
    : 0;

  return { monthlyHits, chainsParticipated, totalHitsAllTime, avgHitsPerChain };
}


// ─── MONTHLY FACTION REPORT: AGGREGATION ────────────────────────────────────
// Aggregates all chains stored in chainsData for a given month (YYYY-MM).
// Returns { chainsCompleted, totalHits, totalRespect, memberHits }
function aggregateChainDataForMonth(monthKey) {
  let chainsCompleted = 0;
  let totalHits = 0;
  let totalRespect = 0;
  const memberHits = {}; // { tornId: totalHits }

  for (const [chainLengthKey, record] of Object.entries(chainsData)) {
    // Determine which month this chain belongs to via its timestamp
    if (!record.timestamp) continue;
    const chainMonth = getMonthKey(new Date(record.timestamp * 1000));
    if (chainMonth !== monthKey) continue;

    chainsCompleted++;
    totalRespect += record.respect || 0;
    totalHits += record.chain || Number(chainLengthKey) || 0;

    // Accumulate per-member hits
    for (const [uid, hits] of Object.entries(record.members || {})) {
      memberHits[uid] = (memberHits[uid] || 0) + hits;
    }
  }

  return { chainsCompleted, totalHits, totalRespect, memberHits };
}

// ─── MONTHLY FACTION REPORT: FETCH TRAINING STATS ────────────────────────────
// Fetches faction contributor stats for all four gym stats from Torn API.
// Returns { [tornId]: { name, totalTraining, estimatedEnergy } }
// Torn API: GET /faction/?selections=contributors&stat=gymX
// Each stat entry: { contributors: { [id]: { name, value } } }
async function fetchTrainingStats() {
  const GYM_STATS = ["gymstrength", "gymdefense", "gymspeed", "gymdexterity"];
  const ENERGY_PER_TRAIN = 5; // 1 gym train costs 5 energy (Torn standard)
  const memberTraining = {}; // { tornId: { name, totalTraining } }

  for (const stat of GYM_STATS) {
    try {
      const url = `https://api.torn.com/faction/${FACTION_ID}?selections=contributors&stat=${stat}&key=${TORN_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) { console.warn(`[REPORT] Training fetch HTTP error for ${stat}: ${res.status}`); continue; }
      const data = await res.json();
      if (data.error) { console.warn(`[REPORT] Training API error for ${stat}:`, data.error); continue; }

      // Response shape: { contributors: { [id]: { name, value, contributed, in_faction } } }
      // "contributed" is the amount added to faction total — closest proxy for monthly activity.
      // "value" is the member's current personal stat total.
      // We use "contributed" as the training delta for this billing cycle.
      const contributors = data.contributors?.contributors || data.contributors || {};

      for (const [id, memberData] of Object.entries(contributors)) {
        const uid = String(id);
        const contributed = memberData.contributed || memberData.value || 0;
        if (!memberTraining[uid]) {
          memberTraining[uid] = { name: memberData.name || `Player ${uid}`, totalTraining: 0 };
        }
        memberTraining[uid].totalTraining += contributed;
      }

      // Rate-limit courtesy pause between stat fetches (Torn API: ~100 req/min)
      await new Promise(r => setTimeout(r, 700));
    } catch (err) {
      console.error(`[REPORT] Error fetching ${stat} training data:`, err.message);
    }
  }

  // Convert raw training total → estimated energy spent
  // Formula: each "contributed" unit represents roughly 1 stat point gained.
  // Torn average: ~1 stat gained per 5 energy on gym.
  const result = {};
  for (const [uid, data] of Object.entries(memberTraining)) {
    result[uid] = {
      name: data.name,
      totalTraining: data.totalTraining,
      estimatedEnergy: Math.round(data.totalTraining * ENERGY_PER_TRAIN)
    };
  }
  return result;
}

// ─── MONTHLY FACTION REPORT: BUILD AND POST ──────────────────────────────────
// Generates the full monthly report embed(s) and sends them to the configured channel.
// monthKey: "YYYY-MM" — defaults to current month.
async function buildAndPostMonthlyReport(monthKey = null) {
  const LOW_ENERGY_THRESHOLD = 7000; // energy below this triggers low-training warning
  const targetMonth = monthKey || getMonthKey();
  const channelId = config.chainChannelId;

  console.log(`[REPORT] Building monthly report for ${targetMonth}...`);

  // ── 1. Aggregate chain data ──────────────────────────────────────────────
  const chainAgg = aggregateChainDataForMonth(targetMonth);

  // ── 2. Fetch training stats ──────────────────────────────────────────────
  let trainingStats = {};
  try {
    trainingStats = await fetchTrainingStats();
  } catch (err) {
    console.error("[REPORT] Failed to fetch training stats:", err.message);
  }

  // ── 3. Resolve names for top chain hitters ───────────────────────────────
  const sortedHitters = Object.entries(chainAgg.memberHits)
    .filter(([, hits]) => hits > 0)
    .sort((a, b) => b[1] - a[1]);

  const allIds = [...new Set([
    ...sortedHitters.map(([id]) => id),
    ...Object.keys(trainingStats)
  ])];
  const nameMap = await resolveTornPlayerNames(allIds);

  // Merge names into trainingStats (API names take priority, fall back to contributor name)
  for (const [uid, data] of Object.entries(trainingStats)) {
    if (nameMap.has(uid)) data.name = nameMap.get(uid);
  }

  // ── 4. Identify low trainers ─────────────────────────────────────────────
  const lowTrainers = Object.entries(trainingStats)
    .filter(([, d]) => d.estimatedEnergy < LOW_ENERGY_THRESHOLD)
    .sort((a, b) => a[1].estimatedEnergy - b[1].estimatedEnergy);

  // ── 5. Persist report data ───────────────────────────────────────────────
  monthlyReportsData[targetMonth] = {
    chainsCompleted: chainAgg.chainsCompleted,
    totalHits: chainAgg.totalHits,
    totalRespect: Math.round(chainAgg.totalRespect * 100) / 100,
    memberHits: chainAgg.memberHits,
    generatedAt: Math.floor(Date.now() / 1000)
  };
  saveMonthlyReportsData();
  console.log(`[REPORT] Saved report data for ${targetMonth}`);

  // ── 6. Build embed(s) ────────────────────────────────────────────────────
  // Top 5 hitters section
  const MEDALS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
  const topHittersText = sortedHitters.slice(0, 5).length > 0
    ? sortedHitters.slice(0, 5).map(([id, hits], i) => {
        const name = nameMap.get(id) || `Player ${id}`;
        return `${MEDALS[i]} [${name}](${playerProfileLink(id)}) — **${hits.toLocaleString()}** hits`;
      }).join("\n")
    : "No chain data recorded this month.";

  // Low trainers section
  const lowTrainersText = lowTrainers.length > 0
    ? lowTrainers.slice(0, 15).map(([id, d]) => {
        const name = d.name || nameMap.get(id) || `Player ${id}`;
        return `• [${name}](${playerProfileLink(id)}) — ${d.estimatedEnergy.toLocaleString()} energy`;
      }).join("\n") +
      (lowTrainers.length > 15 ? `\n*...and ${lowTrainers.length - 15} more*` : "")
    : "✅ All members above training threshold!";

  // Main summary embed
  const summaryEmbed = new EmbedBuilder()
    .setTitle(`📊 Monthly Faction Report — ${targetMonth}`)
    .setColor(0x5865F2)
    .addFields(
      {
        name: "⛓️ Chain Summary",
        value: [
          `**Chains Completed:** ${chainAgg.chainsCompleted.toLocaleString()}`,
          `**Total Chain Hits:** ${chainAgg.totalHits.toLocaleString()}`,
          `**Total Respect Earned:** ${chainAgg.totalRespect.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
        ].join("\n"),
        inline: false
      },
      {
        name: "🏆 Top Chain Hitters",
        value: topHittersText,
        inline: false
      },
      {
        name: `⚠️ Low Training (<${LOW_ENERGY_THRESHOLD.toLocaleString()} energy)`,
        value: lowTrainersText,
        inline: false
      }
    )
    .setFooter({ text: `Report generated for ${targetMonth}` })
    .setTimestamp();

  // ── 7. Send to channel ───────────────────────────────────────────────────
  if (channelId) {
    await sendToChannel(channelId, { embeds: [summaryEmbed] });
    console.log(`[REPORT] Monthly report posted to channel ${channelId}`);
  } else {
    console.warn("[REPORT] No chainChannelId configured — report not posted. Use /setchainchannel.");
  }

  return summaryEmbed;
}

// ─── MONTHLY REPORT: AUTO-TRIGGER ON MONTH END ───────────────────────────────
// Called from inside the OC poll. Fires once on the last day of the month at 23:00 UTC.
async function checkMonthlyReportTrigger() {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const isLastDayOfMonth = tomorrow.getUTCDate() === 1; // tomorrow is 1st → today is last day
  const hour = now.getUTCHours();
  const today = now.toDateString();

  if (isLastDayOfMonth && hour === 23 && config.lastMonthlyReportSent !== today && config.chainChannelId) {
    config.lastMonthlyReportSent = today;
    saveConfig();
    const monthKey = getMonthKey(now);
    console.log(`[REPORT] Auto-triggering monthly report for ${monthKey}`);
    await buildAndPostMonthlyReport(monthKey);
  }
}

// ─── OC CHECK (runs every 10 mins) ───────────────────────────────────────────

async function checkOrganisedCrime() {
  console.log("[OC CHECK] Running organised crime check...");
  try {
    // ── 1. Fetch all faction members ────────────────────────────────────────
    const membersUrl = `https://api.torn.com/v2/faction/${FACTION_ID}?selections=members&key=${TORN_API_KEY}`;
    const membersRes = await fetch(membersUrl);
    if (!membersRes.ok) { console.error(`[OC CHECK] Members API error: ${membersRes.status}`); return; }
    const membersData = await membersRes.json();
    if (membersData.error) { console.error("[OC CHECK] Members API error:", membersData.error); return; }

    const members = normalizeMembers(membersData);
    if (members.length === 0) { console.warn("[OC CHECK] No members returned from API"); return; }

    // ── 2. Fetch active/planned crimes ──────────────────────────────────────
    const crimesUrl = `https://api.torn.com/v2/faction/crimes?cat=available&key=${TORN_API_KEY}`;
    const crimesRes = await fetch(crimesUrl);
    if (!crimesRes.ok) { console.error(`[OC CHECK] Crimes API error: ${crimesRes.status}`); return; }
    const crimesData = await crimesRes.json();
    if (crimesData.error) {
      console.error("[OC CHECK] Crimes API error:", crimesData.error);
      return;
    }

    // ── 3. Build set of member IDs currently in an OC ───────────────────────
    const inOcSet = new Set();
    const readyOcByMember = {};

    const crimes = crimesData.crimes || [];
    console.log(`[OC CHECK] Found ${crimes.length} active crime(s)`);

    // ── FEATURE 6: OC DELAY DETECTION ────────────────────────────────────────
    // For each active crime, check if it has unfilled slots and warn if so.
    const ocAlertChannelId = config.ocAlertChannelId;
    const delayWarningChannelId = config.delayWarningChannelId;

    for (const crime of crimes) {
      const crimeStatus = (crime.status || "").toLowerCase();
      const isReady = crimeStatus === "ready";
      const slots = crime.slots || [];

      // ── Feature 6: Detect crimes with empty slots (members not yet assigned) ─
      // "recruiting" status means slots are not yet fully filled
      if (crimeStatus === "recruiting") {
        const emptySlots = slots.filter(s => !s.user);
        const filledSlots = slots.filter(s => s.user);

        // Only warn once per crime (use crime ID as key)
        const warnKey = `slot_${crime.id}`;
        if (emptySlots.length > 0 && !ocSlotWarnedCrimes.has(warnKey)) {
          ocSlotWarnedCrimes.add(warnKey);
          console.log(`[OC] Crime ${crime.id} "${crime.name}" has ${emptySlots.length} empty slot(s)`);

          // Build list of members already assigned (they're not the problem, but context helps)
          const assignedNames = filledSlots
            .map(s => s.user?.name || `ID ${s.user?.id}`)
            .filter(Boolean)
            .join(", ");

          const embed = new EmbedBuilder()
            .setTitle("⚠️ OC Delay Detected — Unfilled Slots")
            .setDescription(
              `**${crime.name || "Unknown OC"}** is recruiting but has **${emptySlots.length}** unfilled slot(s).\n` +
              `The OC cannot start until all slots are filled.`
            )
            .addFields(
              { name: "Crime", value: crime.name || "Unknown", inline: true },
              { name: "Empty Slots", value: `${emptySlots.length}`, inline: true },
              { name: "Assigned Members", value: assignedNames || "None yet", inline: false }
            )
            .setColor(0xFFA500)
            .setTimestamp();

          await sendToChannel(ocAlertChannelId, { embeds: [embed] });
        }
      } else {
        // Crime is no longer recruiting — clear its warn key so if it recurrs it'll warn again
        ocSlotWarnedCrimes.delete(`slot_${crime.id}`);
      }

      // ── Existing OC tracking logic ────────────────────────────────────────
      for (const slot of slots) {
        if (!slot.user) continue;
        const uid = String(slot.user.id || "");
        if (!uid || uid === "0") continue;
        inOcSet.add(uid);
        if (isReady) {
          readyOcByMember[uid] = {
            ocId: crime.id,
            ocName: crime.name || "Unknown OC"
          };
        }
      }
    }

    console.log(`[OC CHECK] ${inOcSet.size} member(s) in an OC: ${[...inOcSet].join(", ")}`);

    // ── 4. Process each member ───────────────────────────────────────────────
    const now = Date.now();

    for (const m of members) {
      const id = String(m.player_id);
      const name = m.name || ocState[id]?.name || "Unknown";
      const inOc = inOcSet.has(id);
      const isReady = !!readyOcByMember[id];
      const ocName = readyOcByMember[id]?.ocName || null;

      if (!ocState[id]) {
        ocState[id] = {
          name,
          not_in_oc_since: inOc ? null : now,
          warned_12h: false,
          struck_48h: false,
          oc_ready_since: null,
          delay_warned: false,
          last_seen: now,
          first_seen: now
        };
        console.log(`[OC] First time seeing ${name} (${id}) — recording silently`);
        continue;
      }

      ocState[id].name = name;
      ocState[id].last_seen = now;
      const state = ocState[id];

      if (inOc) {
        if (state.not_in_oc_since !== null) {
          console.log(`[OC] ${name} is now in an OC — resetting timer`);
          state.not_in_oc_since = null;
          state.warned_12h = false;
          state.struck_48h = false;
        }

        if (isReady) {
          if (!state.oc_ready_since) {
            state.oc_ready_since = now;
            state.delay_warned = false;
            console.log(`[OC] ${name}'s OC "${ocName}" is ready — starting delay timer`);
          }
          const readyDuration = now - state.oc_ready_since;
          if (readyDuration >= OC_DELAY_WARN && !state.delay_warned) {
            state.delay_warned = true;
            const strikeCount = addStrike(id, name, `OC delay — ${ocName} ready for ${formatDuration(readyDuration)} without executing`);
            console.log(`[OC] Delay strike for ${name}. Total strikes: ${strikeCount}`);
            const embed = new EmbedBuilder()
              .setTitle("⏰ OC DELAY STRIKE")
              .setDescription(`**${name}** has been in a ready OC for **${formatDuration(readyDuration)}** and hasn't executed it!`)
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
          if (state.oc_ready_since) {
            console.log(`[OC] ${name}'s OC ready state cleared`);
            state.oc_ready_since = null;
            state.delay_warned = false;
          }
        }
      } else {
        state.oc_ready_since = null;
        state.delay_warned = false;

        if (!state.not_in_oc_since) {
          state.not_in_oc_since = now;
          state.warned_12h = false;
          state.struck_48h = false;
          console.log(`[OC] ${name} has no OC — timer started`);
        }

        const timeOutMs = now - state.not_in_oc_since;

        if (timeOutMs >= OC_WARN_12H && !state.warned_12h) {
          state.warned_12h = true;
          console.log(`[OC] 12h warning for ${name} (${formatDuration(timeOutMs)} without OC)`);
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

        if (timeOutMs >= OC_STRIKE_48H && !state.struck_48h) {
          state.struck_48h = true;
          const strikeCount = addStrike(id, name, `48h without OC (${formatDuration(timeOutMs)})`);
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

    // Send daily Not-in-OC report at noon UTC if channel is set
    const currentDate = new Date(now);
    const today = currentDate.toDateString();
    const hour = currentDate.getUTCHours();
    if (hour === 12 && config.lastDailySent !== today && config.notOcChannelId) {
      try {
        const report = buildNotInOcReportText(1900);
        await sendToChannel(config.notOcChannelId, { content: report });
        config.lastDailySent = today;
        saveConfig();
        console.log("[OC CHECK] Daily Not-in-OC report sent at noon UTC.");
      } catch (err) {
        console.error("[OC CHECK] Failed to send daily report:", err);
      }
    }

    // ── Feature 4: Check if monthly leaderboard should fire ───────────────
    await checkMonthlyLeaderboardTrigger();

    // ── Monthly faction report: auto-trigger on last day of month at 23:00 UTC ─
    await checkMonthlyReportTrigger();

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
    await interaction.reply({ embeds: [embed] });
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

  // ── /setchainchannel — FEATURE 7 ──────────────────────────────────────────
  if (interaction.commandName === "setchainchannel") {
    if (!interaction.member.permissions.has("Administrator"))
      return interaction.reply({ content: "❌ admins only", ephemeral: true });
    const channel = interaction.options.getChannel("channel");
    if (!channel.isTextBased()) return interaction.reply({ content: "❌ pick a text channel", ephemeral: true });
    config.chainChannelId = channel.id;
    saveConfig();
    await interaction.reply({ content: `✅ Chain results and monthly leaderboards will post to ${channel}`, ephemeral: true });
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
    await interaction.reply({ content: `Configured Not-in-OC channel id: \`${id}\`` });
  }

  // ── /notinoc ───────────────────────────────────────────────────────────────
  if (interaction.commandName === "notinoc") {
    await interaction.deferReply().catch(() => {});
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
      const playerStrikes = all.filter(s => s.name.toLowerCase().includes(targetName.toLowerCase()));
      if (playerStrikes.length === 0) {
        return interaction.reply({ content: `✅ No active strikes found for **${targetName}**` });
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
      await interaction.reply({ embeds: [embed] });
    } else {
      const grouped = {};
      for (const s of all) {
        if (!grouped[s.player_id]) grouped[s.player_id] = { name: s.name, count: 0 };
        grouped[s.player_id].count++;
      }
      if (Object.keys(grouped).length === 0) {
        return interaction.reply({ content: "✅ No active strikes! Everyone's behaving." });
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
      await interaction.reply({ embeds: [embed] });
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
      const toRemove = playerStrikes[indexArg - 1];
      if (!toRemove) return interaction.reply({ content: `❌ Strike #${indexArg} not found for ${targetName}`, ephemeral: true });
      const newStrikes = active.filter(s => !(s.player_id === toRemove.player_id && s.timestamp === toRemove.timestamp));
      saveStrikes(newStrikes);
      await interaction.reply({ content: `✅ Removed strike #${indexArg} from **${toRemove.name}** (${toRemove.reason})`, ephemeral: true });
    } else {
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
    await interaction.reply({ embeds: [embed] });
  }

  // ── /leaderboard ───────────────────────────────────────────────────────────
  if (interaction.commandName === "leaderboard") {
    const top = Object.entries(xpData).sort((a, b) => (b[1].xp || 0) - (a[1].xp || 0)).slice(0, 10);
    const desc = top.map(([id, d], i) => `${i + 1}. <@${id}> — Level ${xpToLevel(d.xp || 0)} (${d.xp || 0} XP)`).join("\n") || "No data yet.";
    const embed = new EmbedBuilder().setTitle("🏆 XP Leaderboard").setDescription(desc).setColor(0xFFD700).setTimestamp();
    await interaction.reply({ embeds: [embed] });
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

  // ── /monthlyleaderboard — FEATURE 4 ───────────────────────────────────────
  if (interaction.commandName === "monthlyleaderboard") {
    await interaction.deferReply().catch(() => {});
    try {
      const monthArg = interaction.options.getString("month"); // optional YYYY-MM
      const embed = await getMonthlyLeaderboardEmbed(monthArg || null);
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error("[CHAIN] /monthlyleaderboard error:", err);
      await interaction.editReply({ content: "❌ Failed to build leaderboard, check logs." });
    }
  }

  // ── /chainstats — FEATURE 5 ────────────────────────────────────────────────
  if (interaction.commandName === "chainstats") {
    await interaction.deferReply().catch(() => {});
    try {
      const discordUser = interaction.options.getUser("user") || interaction.user;
      const tornIdArg = interaction.options.getString("tornid"); // optional manual Torn ID

      // Determine which Torn player ID to look up
      // Priority: explicit Torn ID arg > try to find Discord user in xpData / ocState by Discord ID
      // (There's no Discord↔Torn ID link in this bot, so we use tornid arg or guess from ocState name)
      let tornId = tornIdArg || null;
      let resolvedName = discordUser.username;

      if (!tornId) {
        // Try to find the player in ocState by matching the Discord username/display name
        // This is a best-effort fuzzy match since there's no Torn↔Discord link stored
        const lowerTarget = discordUser.username.toLowerCase();
        for (const [id, data] of Object.entries(ocState)) {
          if ((data.name || "").toLowerCase() === lowerTarget) {
            tornId = id;
            resolvedName = data.name;
            break;
          }
        }
      } else {
        // Resolve name from ocState or API
        resolvedName = ocState[tornId]?.name || `Player ${tornId}`;
      }

      if (!tornId) {
        // No Torn ID could be determined — ask user to provide it
        await interaction.editReply({
          content: `❌ Couldn't find a Torn player ID for **${discordUser.username}**.\n` +
            `Use \`/chainstats tornid:YOUR_TORN_ID\` to specify it directly.\n` +
            `Your Torn profile: https://www.torn.com/profiles.php`
        });
        return;
      }

      const stats = getPlayerChainStats(tornId);

      // Try to get a fresher name from Torn API
      const nameMap = await resolveTornPlayerNames([tornId]);
      if (nameMap.has(tornId)) resolvedName = nameMap.get(tornId);

      const monthKey = getMonthKey();
      const embed = new EmbedBuilder()
        .setTitle(`⛓️ Chain Stats — ${resolvedName}`)
        .setDescription(`[View Torn Profile](${playerProfileLink(tornId)})`)
        .addFields(
          { name: `Monthly Hits (${monthKey})`, value: stats.monthlyHits.toLocaleString(), inline: true },
          { name: "Chains Participated", value: stats.chainsParticipated.toLocaleString(), inline: true },
          { name: "Avg Hits Per Chain", value: stats.avgHitsPerChain.toLocaleString(), inline: true },
          { name: "All-Time Hits (recorded)", value: stats.totalHitsAllTime.toLocaleString(), inline: true }
        )
        .setColor(0xFF4500)
        .setFooter({ text: `Torn ID: ${tornId}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error("[CHAIN] /chainstats error:", err);
      await interaction.editReply({ content: "❌ Failed to fetch chain stats, check logs." });
    }
  }

  // ── /fetchchainreport — manual trigger for admins ─────────────────────────
  if (interaction.commandName === "fetchchainreport") {
    if (!interaction.member.permissions.has("Administrator"))
      return interaction.reply({ content: "❌ admins only", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const result = await fetchAndProcessChainReport(0);
      if (result) {
        await interaction.editReply(`✅ Chain report fetched! Chain length: **${result.chainLength}**, Respect: **${result.respect}**, Members: **${Object.keys(result.memberHits).length}**`);
      } else {
        await interaction.editReply("❌ Failed to fetch chain report — check logs for details.");
      }
    } catch (err) {
      await interaction.editReply(`❌ Error: ${err.message}`);
    }
  }

  // ── /monthlyreport — generate and post the monthly faction report ─────────
  if (interaction.commandName === "monthlyreport") {
    // Defer publicly so everyone sees it being generated
    await interaction.deferReply({ ephemeral: false }).catch(() => {});
    try {
      const monthArg = interaction.options.getString("month"); // optional YYYY-MM
      const targetMonth = monthArg || getMonthKey();

      // Validate month format if provided
      if (monthArg && !/^\d{4}-\d{2}$/.test(monthArg)) {
        await interaction.editReply("❌ Invalid month format. Use `YYYY-MM` (e.g. `2026-03`).");
        return;
      }

      await interaction.editReply(`⏳ Generating monthly report for **${targetMonth}**... (fetching training data, this may take a few seconds)`);

      const embed = await buildAndPostMonthlyReport(targetMonth);

      // If no channel is configured, reply directly to the interaction instead
      if (!config.chainChannelId) {
        await interaction.followUp({ embeds: [embed] });
      } else {
        await interaction.editReply(`✅ Monthly report for **${targetMonth}** posted to <#${config.chainChannelId}>.`);
      }
    } catch (err) {
      console.error("[REPORT] /monthlyreport error:", err);
      await interaction.editReply("❌ Failed to generate report — check the logs.");
    }
  }
});


// ─── COMMAND REGISTRATION ────────────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  const commands = [
    // ── Existing commands (unchanged) ────────────────────────────────────────
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

    // ── NEW commands (Features 1-7) ───────────────────────────────────────────

    // Feature 7: Configure chain results channel
    new SlashCommandBuilder()
      .setName("setchainchannel")
      .setDescription("Set channel for chain results and monthly leaderboards")
      .addChannelOption(o => o.setName("channel").setDescription("Chain results channel").setRequired(true)),

    // Feature 4: Monthly leaderboard on demand
    new SlashCommandBuilder()
      .setName("monthlyleaderboard")
      .setDescription("Show the monthly chain hit leaderboard")
      .addStringOption(o => o.setName("month").setDescription("Month to view (YYYY-MM format, default: current month)").setRequired(false)),

    // Feature 5: Per-user chain stats
    new SlashCommandBuilder()
      .setName("chainstats")
      .setDescription("View chain hit stats for a player")
      .addUserOption(o => o.setName("user").setDescription("Discord user (optional)").setRequired(false))
      .addStringOption(o => o.setName("tornid").setDescription("Torn player ID (use this if Discord user doesn't match)").setRequired(false)),

    // Feature 1: Manual chain report fetch (admin)
    new SlashCommandBuilder()
      .setName("fetchchainreport")
      .setDescription("Admin: manually fetch and process the latest chain report"),

    // Monthly faction report: chain stats + training activity
    new SlashCommandBuilder()
      .setName("monthlyreport")
      .setDescription("Generate and post the monthly faction report (chains + training)")
      .addStringOption(o => o.setName("month").setDescription("Month to report on (YYYY-MM, default: current)").setRequired(false)),

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
    try { await checkChainStatus(); } catch (err) { console.error("Initial chain check error:", err); }

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

    // ── Feature 1: Chain status poll every 60 seconds ──────────────────────
    setInterval(async () => {
      try { await checkChainStatus(); } catch (err) { console.error("Chain check error:", err); }
    }, CHAIN_POLL_INTERVAL);

    console.log("[CHAIN] Chain monitoring started. Poll interval: 60s");
    console.log(`[CHAIN] Chain results channel: ${config.chainChannelId || "not configured (use /setchainchannel)"}`);

  } catch (err) { console.error("Error in ready handler:", err); }
}

client.once("clientReady", handleClientReady);
client.login(DISCORD_TOKEN);