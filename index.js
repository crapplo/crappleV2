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

// File paths for persistence
const CONFIG_FILE = "./config.json";
const STATE_FILE = "./jailstate.json";
const ROLE_REACT_FILE = "./rolereact.json";
const XP_FILE = "./xp.json";
// Add CSV persistence for "not in organised crime"
const NOT_OC_CSV = "./not_oc.csv";

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

const xpCooldowns = new Map();
const messageCounters = new Map(); // Track recent messages per user (per channel)
const crossChannelSpam = new Map(); // Track spam across all channels: { userId: [{ timestamp, channelId }, ...] }
const XP_MIN = 5;
const XP_MAX = 15;
const COOLDOWN_MS = 2000;
//const SPAM_THRESHOLD = 1    //FOR TESTING
const SPAM_THRESHOLD = 10; // Max messages allowed in window
const SPAM_WINDOW_MS = 7000; // 7 second window
const SPAM_WARN_COOLDOWN = 15000; // 15 seconds between spam warnings
const SPAM_TIMEOUT_DURATION = 67; // Timeout duration in seconds (1 minute)
const CROSS_CHANNEL_SPAM_THRESHOLD = 15; // Messages in different channels within time window
const CROSS_CHANNEL_SPAM_WINDOW = 10000; // 10 second window
const CROSS_CHANNEL_TIMEOUT_DURATION = 12 * 60 * 60; // 12 hours in seconds

let notOcState = {}; // { [player_id]: { name, last_not_in_oc: number|null, lastSeen: number } }

// Helper functions for saving data
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error("Oof couldn't save config:", err);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(jailState, null, 2));
  } catch (err) {
    console.error("Welp, state save failed:", err);
  }
}

function saveRoleReactMessages() {
  try {
    fs.writeFileSync(
      ROLE_REACT_FILE,
      JSON.stringify([...activeRoleReactMessages], null, 2)
    );
  } catch (err) {
    console.error("Couldn't save role react stuff, rip:", err);
  }
}

function saveXp() {
  try {
    fs.writeFileSync(XP_FILE, JSON.stringify(xpData, null, 2));
  } catch (e) {
    console.error("Couldn't save XP:", e);
  }
}

function saveNotOcCsv() {
  try {
    const rows = [["player_id","name","last_not_in_oc","lastSeen"]];
    for (const [id, rec] of Object.entries(notOcState)) {
      // Only save players who are NOT in OC (last_not_in_oc is set)
      if (rec.last_not_in_oc !== null) {
        // wrap name in quotes to allow commas
        rows.push([id, `"${String(rec.name).replace(/"/g,'""')}"`, rec.last_not_in_oc || "", rec.lastSeen || ""]);
      }
    }
    fs.writeFileSync(NOT_OC_CSV, rows.map(r => r.join(',')).join("\n"));
  } catch (e) {
    console.error("Failed to save not_oc CSV:", e);
  }
}

function xpToLevel(xp) {
  xp = Number(xp) || 0;
  return Math.floor(0.1 * Math.sqrt(xp));
}

// Helper: create Torn profile link
const playerProfileLink = (id) => `https://www.torn.com/profiles.php?XID=${id}`;

// Helper: format jail time nicely
function formatJailTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ${hours % 24}h (yikes)`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s (literally nothing)`;
}

// Helper: normalize faction members into consistent format
const normalizeMembers = (apiData) => {
  const members = [];

  // Handle missing or invalid data
  if (!apiData) {
    console.error("normalizeMembers: apiData is null/undefined");
    return members;
  }

  // Check for members in different possible locations
  let membersData = apiData.members || apiData.faction?.members || apiData;

  if (!membersData) {
    console.error("normalizeMembers: No members data found. API structure:", Object.keys(apiData));
    return members;
  }

  // If already an array, normalize it
  if (Array.isArray(membersData)) {
    console.log(`Found ${membersData.length} members (array format)`);

    // Normalize array format to extract jail time from status
    const normalized = membersData.map(m => {
      let jailTime = 0;

      // Check if member is jailed
      if (m.status) {
        if (m.status.state === 'Jailed' || m.status.state === 'Jail') {
          // until is a timestamp, convert to seconds remaining
          if (m.status.until) {
            const now = Math.floor(Date.now() / 1000);
            jailTime = Math.max(0, m.status.until - now);
          }
        }
      }

      return {
        player_id: m.id || m.player_id,
        name: m.name,
        jail_time: jailTime,
        status: m.status
      };
    });

    // Log jailed members for debugging
    const jailed = normalized.filter(m => m.jail_time > 0);
    if (jailed.length > 0) {
      console.log(`Found ${jailed.length} jailed members:`, jailed.map(m => `${m.name} (${m.jail_time}s)`));
    }

    return normalized;
  }

  // If it's an object, convert to array
  for (const key of Object.keys(membersData)) {
    const m = membersData[key];

    // Check multiple possible locations for jail time
    let jailTime = 0;

    // Check if member is jailed (same logic as array format)
    if (m.status) {
      if (m.status.state === 'Jailed' || m.status.state === 'Jail') {
        // until is a timestamp, convert to seconds remaining
        if (m.status.until) {
          const now = Math.floor(Date.now() / 1000);
          jailTime = Math.max(0, m.status.until - now);
        }
      }
    } else if (m.jail_time !== undefined) {
      // Fallback for old API format
      jailTime = m.jail_time;
    }

    members.push({
      player_id: m.player_id || m.id || Number(key),
      name: m.name || m.player_name || "Unknown",
      jail_time: jailTime,
      status: m.status // Keep full status for debugging
    });
  }

  console.log(`Normalized ${members.length} members from object format`);
  // Log first member with jail time for debugging
  const jailedExample = members.find(m => m.jail_time > 0);
  if (jailedExample) {
    console.log('Example jailed member:', JSON.stringify(jailedExample, null, 2));
  }
  return members;
};

// Auto-role and welcome config
let unverifiedRoleId = config.unverifiedRoleId || null;
let welcomeChannelId = config.welcomeChannelId || null;

// Welcome new members
client.on('guildMemberAdd', async (member) => {
  try {
    if (unverifiedRoleId) {
      await member.roles.add(unverifiedRoleId);
      console.log(`Slapped unverified role on ${member.user.tag} hehe`);
    }

    if (welcomeChannelId) {
      try {
        const welcomeChannel = await member.guild.channels.fetch(welcomeChannelId);
        if (welcomeChannel && welcomeChannel.isTextBased()) {
          const welcomeEmbed = new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle('🎉 NEW FRIEND ALERT!')
            .setDescription(`Heyooo <@${member.id}>!\n\nVerify your Torn account real quick to unlock the whole server and stuff. Click that shiny link above! ✨`)
            .setTimestamp();

          await welcomeChannel.send({ 
            content: `Everybody say hi to <@${member.id}>! 👋`,
            embeds: [welcomeEmbed] 
          });
        }
      } catch (err) {
        console.warn(`Couldn't fetch welcome channel, maybe it got deleted? ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`Uhhhh something broke welcoming ${member.user.tag}:`, err);
  }
});

// Handle role reactions - ADD
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Failed to fetch reaction (message probably deleted):', error);
      return;
    }
  }
  
  const { emoji, message } = reaction;
  const emojiKey = emoji.id ? `<:${emoji.name}:${emoji.id}>` : emoji.name;
  const emojiRoleMap = activeRoleReactMessages.get(message.id);
  if (!emojiRoleMap) return;
  
  const roleId = emojiRoleMap[emojiKey] || emojiRoleMap[emoji.name];
  if (!roleId) return;
  
  const guild = message.guild;
  if (!guild) return;
  
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;
  
  if (!member.roles.cache.has(roleId)) {
    await member.roles.add(roleId).catch((err) => {
      console.error(`Couldn't give role to ${user.tag}, whoops:`, err);
    });
  }
});

// Handle role reactions - REMOVE
client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Failed to fetch reaction:', error);
      return;
    }
  }
  
  const { emoji, message } = reaction;
  const emojiKey = emoji.id ? `<:${emoji.name}:${emoji.id}>` : emoji.name;
  const emojiRoleMap = activeRoleReactMessages.get(message.id);
  if (!emojiRoleMap) return;
  
  const roleId = emojiRoleMap[emojiKey] || emojiRoleMap[emoji.name];
  if (!roleId) return;
  
  const guild = message.guild;
  if (!guild) return;
  
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;
  
  if (member.roles.cache.has(roleId)) {
    await member.roles.remove(roleId).catch((err) => {
      console.error(`Couldn't yoink role from ${user.tag}:`, err);
    });
  }
});

// ========== CROSS-CHANNEL SPAM DETECTION ==========
async function checkCrossChannelSpam(message) {
  const now = Date.now();
  const userId = message.author.id;
  const guildId = message.guild.id;
  const channelId = message.channel.id;

  const crossKey = `${guildId}_${userId}`;
  const userCrossSpam = crossChannelSpam.get(crossKey) || [];
  
  // Clean old messages outside the window
  const recentCrossSpam = userCrossSpam.filter(msg => now - msg.timestamp < CROSS_CHANNEL_SPAM_WINDOW);
  recentCrossSpam.push({ timestamp: now, channelId });
  crossChannelSpam.set(crossKey, recentCrossSpam);
  
  // Count unique channels spammed in
  const uniqueChannels = new Set(recentCrossSpam.map(msg => msg.channelId));
  
  // If spamming across multiple channels, timeout for 12 hours
  if (recentCrossSpam.length > CROSS_CHANNEL_SPAM_THRESHOLD && uniqueChannels.size > 2) {
    if (message.member && message.member.moderatable) {
      try {
        await message.member.timeout(CROSS_CHANNEL_TIMEOUT_DURATION * 1000, 'Cross-channel spam detected');
        
        // Notify mods
        try {
          const fetchedMsgs = await message.channel.messages.fetch({ limit: 50 });
          const toDelete = fetchedMsgs.filter(m => m.author.id === userId && now - m.createdTimestamp < CROSS_CHANNEL_SPAM_WINDOW);
          if (toDelete.size > 0) {
            try {
              await message.channel.bulkDelete(toDelete, true).catch(()=>{});
            } catch (bulkErr) {
              for (const msg of toDelete.values()) {
                try { await msg.delete().catch(()=>{}); } catch(_) {}
              }
            }
          }
        } catch (delErr) {
          console.error('Failed to delete cross-channel spam messages:', delErr);
        }
        
        await message.channel.send(`🚨 <@${userId}> has been timed out for **12 hours** due to cross-channel spamming!`).catch(()=>{});
        console.log(`[SPAM] ${message.author.tag} timed out for 12 hours - cross-channel spam across ${uniqueChannels.size} channels`);
        crossChannelSpam.delete(crossKey);
        return true; // Return true if timed out
      } catch (err) {
        console.error('Failed to timeout cross-channel spammer:', err);
      }
    }
  }
  
  return false; // Not a cross-channel spam violation
}

// Modify messageCreate handler:
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.channel || (message.channel && !message.channel.isTextBased())) return;

    // Check for cross-channel spam first (separate system)
    const isCrossChannelSpam = await checkCrossChannelSpam(message);
    if (isCrossChannelSpam) return; // Exit if timed out for cross-channel spam

    const now = Date.now();
    const userId = message.author.id;
    const guildId = message.guild.id;

    // ========== PER-CHANNEL SPAM CHECK (XP spam prevention) ==========
    // Spam detection
    const spamKey = `${guildId}_${userId}`;
    const userMessages = messageCounters.get(spamKey) || [];
    
    // Clean old messages from counter
    const recentMessages = userMessages.filter(timestamp => now - timestamp < SPAM_WINDOW_MS);
    recentMessages.push(now);
    messageCounters.set(spamKey, recentMessages);

    // Check for spam in single channel
    if (recentMessages.length > SPAM_THRESHOLD) {
      const lastWarn = message.author.lastSpamWarn || 0;
      if (now - lastWarn > SPAM_WARN_COOLDOWN) {
        try {
          // Timeout the member if possible
          if (message.member && message.member.moderatable) {
            await message.member.timeout(SPAM_TIMEOUT_DURATION * 1000, 'Spam detected');
            // Try to delete recent spam messages from this user in the channel
            try {
              const canManage = message.channel.permissionsFor?.(client.user)?.has?.('ManageMessages');
              if (canManage) {
                const fetched = await message.channel.messages.fetch({ limit: 100 });
                const toDelete = fetched.filter(
                  m => m.author.id === message.author.id && (now - m.createdTimestamp) < SPAM_WINDOW_MS
                );
                if (toDelete.size > 0) {
                  try {
                    await message.channel.bulkDelete(toDelete, true);
                  } catch (bulkErr) {
                    // Bulk delete can fail for various reasons; fall back to individual deletes
                    for (const msg of toDelete.values()) {
                      try { await msg.delete().catch(()=>{}); } catch(_) {}
                    }
                  }
                }
              } else {
                // If bot can't manage messages, at least try to delete the triggering message
                await message.delete().catch(()=>{});
              }
            } catch (delErr) {
              console.error('Failed to delete spam messages:', delErr);
            }

            await message.channel.send(`Hey <@${message.author.id}>, you've been timed out for ${SPAM_TIMEOUT_DURATION} seconds for spamming! Your recent spam messages were removed.`).catch(()=>{});
          } else {
            // No moderation permission to timeout; try deleting messages if possible, otherwise warn
            try {
              const canManage = message.channel.permissionsFor?.(client.user)?.has?.('ManageMessages');
              if (canManage) {
                const fetched = await message.channel.messages.fetch({ limit: 100 });
                const toDelete = fetched.filter(
                  m => m.author.id === message.author.id && (now - m.createdTimestamp) < SPAM_WINDOW_MS
                );
                if (toDelete.size > 0) {
                  try {
                    await message.channel.bulkDelete(toDelete, true);
                  } catch (bulkErr) {
                    for (const msg of toDelete.values()) {
                      try { await msg.delete().catch(()=>{}); } catch(_) {}
                    }
                  }
                }
                await message.channel.send(`Hey <@${message.author.id}>, slow down! \nSpam messages don't count for XP. \nRecent spam messages were removed.`).catch(()=>{});
              } else {
                await message.channel.send(`Hey <@${message.author.id}>, slow down! \nSpam messages don't count for XP 🙄`).catch(()=>{});
              }
            } catch (err) {
              console.error('Failed during non-timeout spam deletion:', err);
            }
          }
          message.author.lastSpamWarn = now;
        } catch (err) {
          console.error('Failed to timeout member or delete spam messages:', err);
        }
      }
      return;
    }

    // ========== NORMAL XP HANDLING ==========
    // XP cooldown per user per guild
    const key = `${guildId}_${userId}`;
    const last = xpCooldowns.get(key) || 0;
    if (now - last < COOLDOWN_MS) return;
    xpCooldowns.set(key, now);

    const gained = Math.floor(Math.random() * (XP_MAX - XP_MIN + 1)) + XP_MIN;
    const uid = message.author.id;
    const prevXp = (xpData[uid] && xpData[uid].xp) || 0;
    const prevLevel = xpToLevel(prevXp);

    xpData[uid] = xpData[uid] || { xp: 0, messages: 0 };
    xpData[uid].xp += gained;
    xpData[uid].messages = (xpData[uid].messages || 0) + 1;
    saveXp();

    const newLevel = xpToLevel(xpData[uid].xp);
    if (newLevel > prevLevel) {
      const levelEmbed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('🎉 Level Up!')
        .setDescription(`<@${uid}> just reached **Level ${newLevel}**!`)
        .addFields(
          { name: 'Total XP', value: `${xpData[uid].xp}`, inline: true },
          { name: 'Messages', value: `${xpData[uid].messages}`, inline: true }
        )
        .setThumbnail(message.author.displayAvatarURL?.({ extension: 'png', size: 256 }) || '')
        .setTimestamp();

      await message.channel.send({ embeds: [levelEmbed] }).catch(()=>{});
    }
  } catch (err) {
    console.error("XP handler error:", err);
  }
});

// Main jail checking function
async function checkFactionJail() {
  if (!config.channelId || !config.roleId) {
    console.log("Jail check skipped: channelId or roleId not configured");
    return;
  }

  try {
    // Try v2 API first, fall back to v1 if needed
    const apiUrl = `https://api.torn.com/v2/faction/${FACTION_ID}?selections=members&key=${TORN_API_KEY}`;
    console.log(`Calling Torn API: ${apiUrl.replace(TORN_API_KEY, 'API_KEY_HIDDEN')}`);

    const res = await fetch(apiUrl);

    if (!res.ok) {
      console.error(`API said nope: ${res.status} ${res.statusText}`);
      const errorText = await res.text();
      console.error(`Response body: ${errorText}`);
      return;
    }

    const data = await res.json();
    console.log(`API Response structure:`, Object.keys(data));

    if (data.error) {
      console.error("Torn API error:", JSON.stringify(data.error, null, 2));
      return;
    }

    const members = normalizeMembers(data);
    console.log(`Stalking ${members.length} faction peeps...`);
    
    const channel = await client.channels.fetch(config.channelId).catch(() => null);
    
    if (!channel || !channel.isTextBased()) {
      console.error("Channel config is wonky, can't send messages");
      return;
    }

    const currentMemberIds = new Set();
    const now = Date.now();

    for (const m of members) {
      const id = String(m.player_id);
      currentMemberIds.add(id);
      
      if (typeof jailState[id] !== 'object') {
        jailState[id] = { time: 0, lastSeen: now, name: m.name };
      }

      const jailTime = Number(m.jail_time || 0);
      const prevTime = Number(jailState[id].time || 0);

      jailState[id].lastSeen = now;
      jailState[id].name = m.name; // Update name in case it changed

      if (jailTime > 0) {
        console.log(`${m.name} (${id}): jail_time=${jailTime}, prev=${prevTime}`);
      }

      // NEWLY JAILED
      if (jailTime > 0 && prevTime === 0) {
        const embed = new EmbedBuilder()
          .setTitle(`🚨 ${m.name} GOT ARRESTED`)
          .setDescription(`${m.name} just got thrown in the chambers lmaooo`)
          .addFields(
            { name: "Time left", value: formatJailTime(jailTime), inline: true },
            { name: "Profile", value: `[link for visitors](${playerProfileLink(id)})`, inline: true }
          )
          .setColor(0xFF6B6B)
          .setTimestamp();

        await channel.send({
          content: `<@&${config.roleId}> ${m.name} got jailed`,
          embeds: [embed]
        });
      }

      // RELEASED FROM JAIL
      if (prevTime > 0 && jailTime === 0) {
        const embed = new EmbedBuilder()
          .setTitle("✅ FREEDOM!!!")
          .setDescription(`${m.name} is out of jail!`)
          .setColor(0x57F287)
          .setTimestamp();

        await channel.send({
          content: `${m.name} escaped!!! 🎉`,
          embeds: [embed]
        });
      }

      // JAIL TIME INCREASED
      if (prevTime > 0 && jailTime > prevTime + 60) {
        const embed = new EmbedBuilder()
          .setTitle(`🔄 LMAO ${m.name} GOT JAILED AGAIN`)
          .setDescription(`${m.name} got bailed but went right back in HAHAHA`)
          .addFields(
            { name: "New sentence", value: formatJailTime(jailTime), inline: true },
            { name: "Profile", value: `[point and laugh](${playerProfileLink(id)})`, inline: true }
          )
          .setColor(0xFEE75C)
          .setTimestamp();

        await channel.send({
          content: `<@&${config.roleId}> ${m.name} can't stay out of trouble smh`,
          embeds: [embed]
        });
      }

      jailState[id].time = jailTime;

      const inOc = isInOrganisedCrime(m);
      // ensure notOcState entry exists
      if (!notOcState[id]) {
        notOcState[id] = { name: m.name || jailState[id].name || "Unknown", last_not_in_oc: null, lastSeen: now };
      } else {
        notOcState[id].name = m.name || notOcState[id].name;
        notOcState[id].lastSeen = now;
      }

      if (!inOc) {
        // currently NOT in organised crime - ensure a "start" timestamp
        if (!notOcState[id].last_not_in_oc) {
          notOcState[id].last_not_in_oc = now;
          console.log(`Tracking ${m.name} (${id}) as NOT in OC starting ${new Date(now).toISOString()}`);
        }
      } else {
        // currently IN an organised crime - clear the "not in" start
        if (notOcState[id].last_not_in_oc) {
          // keep lastSeen, but clear last_not_in_oc so future report ignores them
          notOcState[id].last_not_in_oc = null;
          console.log(`${m.name} (${id}) is now in OC; clearing not-in-OC timer`);
        }
      }
    }

    // Clean up old entries (7 day retention)
    const RETENTION_DAYS = 7 * 24 * 60 * 60 * 1000;
    for (const id in jailState) {
      if (!currentMemberIds.has(id)) {
        if (jailState[id].lastSeen && now - jailState[id].lastSeen > RETENTION_DAYS) {
          delete jailState[id];
        }
      }
    }

    saveState();
    saveNotOcCsv();
  } catch (err) {
    console.error("Jail check went boom:", err);
  }
}

// Utility: decide if a member is in an Organised crime (tries multiple possible API fields)
function isInOrganisedCrime(member) {
  try {
    // If API provides an explicit boolean/flag
    if (member.organised_crime || member.organisedCrime || member.organisedcrime) return true;
    // count fields
    if (typeof member.organised_crime_count === 'number' && member.organised_crime_count > 0) return true;
    if (typeof member.organisedCrimeCount === 'number' && member.organisedCrimeCount > 0) return true;
    // status could contain nested info
    const s = member.status || {};
    if (s.organised_crime || s.organisedCrime || s.organisedcrime) return true;
    // sometimes status might include string tags
    if (typeof s.state === 'string' && /organis|organis?ed|crime/i.test(s.state)) return true;
    // fallback: not detected -> assume NOT in organised crime
    return false;
  } catch (e) {
    return false;
  }
}

// Small duration formatting for "how long not in OC"
function formatDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

// Build text report for players not in OC
function buildNotInOcReportText(maxChars) {
  const now = Date.now();
  const entries = Object.entries(notOcState).filter(([_, data]) => data.last_not_in_oc !== null);
  
  if (entries.length === 0) {
    return "📊 **Not-in-OC Report**\n\nEveryone's in OC! 🎉";
  }
  
  // Sort by duration (longest not in OC first)
  entries.sort((a, b) => {
    const durationA = a[1].last_not_in_oc ? now - a[1].last_not_in_oc : 0;
    const durationB = b[1].last_not_in_oc ? now - b[1].last_not_in_oc : 0;
    return durationB - durationA;
  });
  
  let report = "📊 **Not-in-OC Report**\n\n";
  let charCount = report.length;
  let count = 0;
  
  for (const [id, data] of entries) {
    const name = data.name || "Unknown";
    const lastNotInOc = data.last_not_in_oc;
    const durationSeconds = lastNotInOc ? Math.floor((now - lastNotInOc) / 1000) : null;
    const durationStr = durationSeconds !== null ? formatDuration(durationSeconds) : "N/A";
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

// Load prior CSV at startup
function loadNotOcCsv() {
  try {
    if (!fs.existsSync(NOT_OC_CSV)) return;
    const raw = fs.readFileSync(NOT_OC_CSV, "utf8").trim();
    if (!raw) return;
    const lines = raw.split(/\r?\n/);
    const header = lines.shift(); // skip header
    for (const ln of lines) {
      if (!ln) continue;
      // CSV: player_id,name,last_not_in_oc,lastSeen
      const parts = ln.split(',').map(s => s.replace(/^"|"$/g, ''));
      const [player_id, name, last_not_in_oc, lastSeen] = parts;
      notOcState[String(player_id)] = {
        name: name || "Unknown",
        last_not_in_oc: last_not_in_oc ? Number(last_not_in_oc) : null,
        lastSeen: lastSeen ? Number(lastSeen) : Date.now()
      };
    }
    console.log(`Loaded not_oc CSV with ${Object.keys(notOcState).length} rows`);
  } catch (e) {
    console.error("Failed to load not_oc CSV:", e);
  }
}

// Load existing CSV if present
loadNotOcCsv();

// Command handler
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "jail") {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply({ 
        content: '❌ nah you need admin perms for this one chief', 
        ephemeral: true 
      });
    }

    const channel = interaction.options.getChannel("channel");
    const role = interaction.options.getRole("role");

    config.channelId = channel.id;
    config.roleId = role.id;
    saveConfig();

    console.log(`[COMMAND] ${interaction.user.tag} configured jail alerts - Channel: ${channel.name}, Role: ${role.name}`);

    await interaction.reply(
      `✅ Ayyy jail alerts are good to go! Uh hope it works tho...? Channel: ${channel.name}, Role: ${role.name}`
    );
  }

  if (interaction.commandName === "testjail") {
    console.log(`[COMMAND] ${interaction.user.tag} testing jail alerts`);
    
    if (!config.channelId || !config.roleId) {
      return interaction.reply("❌ gotta use /jail first to set things up my dude");
    }

    try {
      const channel = await client.channels.fetch(config.channelId);
      if (!channel || !channel.isTextBased()) {
        return interaction.reply("❌ channel doesn't exist anymore lol, reconfigure with /jail");
      }

      const embed = new EmbedBuilder()
        .setTitle("🚨 OH NO THEY GOT ARRESTED (test)")
        .setDescription("TestyMcTest just got thrown in the chambers lmaooo")
        .addFields(
          { name: "When", value: `69m (nice)`, inline: true },
          { name: "Profile", value: `[go laugh at them](https://www.torn.com/profiles.php?XID=12345)`, inline: true }
        )
        .setColor(0xFF6B6B)
        .setTimestamp();

      await channel.send({
        content: `<@&${config.roleId}> yo TestyMcTestFace got jailed (this is a test btw)`,
        embeds: [embed]
      });

      await interaction.reply("✅ Test alert sent! check the channel :)");
    } catch (err) {
      console.error("Test alert failed:", err);
      await interaction.reply("❌ ughhhhh something broke, check the logs");
    }
  }

  if (interaction.commandName === "testapi") {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply({
        content: '❌ need admin perms for this one',
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const apiUrl = `https://api.torn.com/v2/faction/${FACTION_ID}?selections=members&key=${TORN_API_KEY}`;
      console.log(`Testing API call to: ${apiUrl.replace(TORN_API_KEY, 'HIDDEN')}`);

      const res = await fetch(apiUrl);
      const data = await res.json();

      if (data.error) {
        return interaction.editReply(`❌ API Error: ${JSON.stringify(data.error, null, 2)}`);
      }

      console.log('Raw API response keys:', Object.keys(data));
      if (data.members) {
        const firstMemberKey = Object.keys(data.members)[0];
        if (firstMemberKey) {
          console.log('Sample member data:', JSON.stringify(data.members[firstMemberKey], null, 2));
        }
      }

      const members = normalizeMembers(data);
      const jailedMembers = members.filter(m => m.jail_time > 0);

      let response = `✅ API is working!\n\n`;
      response += `**Total members:** ${members.length}\n`;
      response += `**Currently jailed:** ${jailedMembers.length}\n\n`;

      if (jailedMembers.length > 0) {
        response += `**Jailed members:**\n`;
        jailedMembers.forEach(m => {
          response += `• ${m.name} (${m.player_id}): ${formatJailTime(m.jail_time)}\n`;
        });
      } else {
        response += `*No jailed members detected. Check console logs for raw API data.*`;
      }

      await interaction.editReply(response.substring(0, 2000));
    } catch (err) {
      console.error("API test failed:", err);
      await interaction.editReply(`❌ API test failed: ${err.message}`);
    }
  }

  if (interaction.commandName === "rolereact") {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply({ 
        content: '❌ whoops, admins only for this one buddy', 
        ephemeral: true 
      });
    }

    const pairs = [];
    for (let i = 1; i <= 5; i++) {
      const role = interaction.options.getRole(`role${i}`);
      const emoji = interaction.options.getString(`emoji${i}`);
      if (role && emoji) {
        pairs.push({ role, emoji });
      }
    }
    
    if (pairs.length === 0) {
      return interaction.reply({ 
        content: '❌ you gotta give me at least one role/emoji combo buddy', 
        ephemeral: true 
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('🎭 GRAB YOUR ROLES HERE!')
      .setDescription('React below to snag some sick roles! Remove your reaction to delete role I think.\n\nPretty simple tbh')
      .setColor(0x9b59b6)
      .addFields(
        pairs.map(({ role, emoji }) => ({
          name: `${emoji} → ${role.name}`,
          value: `React to get this one!`,
          inline: true
        }))
      )
      .setFooter({ text: 'unreact to lose the role (if you want to for some reason)' })
      .setTimestamp();

    await interaction.reply({ content: 'Creating role react message...', ephemeral: true });

    const msg = await interaction.channel.send({ embeds: [embed] });
    
    for (const { emoji } of pairs) {
      await msg.react(emoji).catch((err) => {
        console.error(`Couldn't react with ${emoji}:`, err);
      });
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const emojiRoleMap = {};
    for (const { role, emoji } of pairs) {
      emojiRoleMap[emoji] = role.id;
    }
    activeRoleReactMessages.set(msg.id, emojiRoleMap);
    saveRoleReactMessages();

    await interaction.editReply({ content: '✅ Role react message is live! go nuts', ephemeral: true });
  }

  if (interaction.commandName === "setwelcome") {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply({ 
        content: '❌ need admin perms bestie', 
        ephemeral: true 
      });
    }

    const channel = interaction.options.getChannel("channel");
    if (!channel.isTextBased()) {
      return interaction.reply({ 
        content: "❌ bruh pick a text channel", 
        ephemeral: true 
      });
    }
    
    welcomeChannelId = channel.id;
    config.welcomeChannelId = channel.id;
    saveConfig();
    
    await interaction.reply({ 
      content: `✅ Yeet! Welcome messages will spam ${channel} now`, 
      ephemeral: true 
    });
  }

  if (interaction.commandName === "setunverified") {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply({ 
        content: '❌ admins only sorry', 
        ephemeral: true 
      });
    }

    const role = interaction.options.getRole("role");
    unverifiedRoleId = role.id;
    config.unverifiedRoleId = role.id;
    saveConfig();
    
    await interaction.reply({ 
      content: `✅ Yuppee new members gonna get ${role.name} automatically now!`, 
      ephemeral: true 
    });
  }

  if (interaction.commandName === "jailstatus") {
    const jailed = Object.entries(jailState)
      .filter(([_, data]) => data.time > 0)
      .map(([id, data]) => {
        const name = data.name || 'Unknown';
        const profileLink = playerProfileLink(id);
        return `• [${name}](${profileLink}): ${formatJailTime(data.time)}`;
      })
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle('🚨 Current Jail Status')
      .setDescription(jailed || 'Nobody\'s in the chambers rn! Everyone\'s being good :)')
      .setColor(jailed ? 0xFF6B6B : 0x57F287)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.commandName === "event") {
    const title = interaction.options.getString("title");
    const description = interaction.options.getString("description") || "No description provided lol";
    const timeStr = interaction.options.getString("time");
    const role = interaction.options.getRole("role");

    if (role && !interaction.member.permissions.has('ManageMessages')) {
      return interaction.reply({ 
        content: '❌ You need Manage Messages permission to ping roles with events', 
        ephemeral: true 
      });
    }

    let eventTime;
    try {
      eventTime = new Date(timeStr);
      if (isNaN(eventTime.getTime())) {
        throw new Error("Invalid date");
      }
    } catch (err) {
      return interaction.reply({
        content: "❌ bruh that's not a valid time format. Use `YYYY-MM-DDTHH:MM:SSZ` like `2025-10-08T20:00:00Z` (that Z at the end is important!)",
        ephemeral: true
      });
    }

    const now = new Date();
    if (eventTime <= now) {
      return interaction.reply({
        content: "❌ Event time must be in the future!",
        ephemeral: true
      });
    }

    const unixTimestamp = Math.floor(eventTime.getTime() / 1000);
    const embed = new EmbedBuilder()
      .setTitle(`📅 ${title}`)
      .setDescription(description)
      .addFields(
        { 
          name: "When", 
          value: `<t:${unixTimestamp}:F>\n(<t:${unixTimestamp}:R>)`, 
          inline: false 
        },
        {
          name: "RSVP",
          value: "React to let others know if you're coming!\n✅ Going\n❌ Not going\n❓ Maybe",
          inline: false
        }
      )
      .setColor(0x5865F2)
      .setFooter({ text: `Created by ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.reply({ content: 'Creating event...', ephemeral: true });

    const msg = await interaction.channel.send({
      content: role ? `<@&${role.id}> 📅 New event!` : "📅 New event!",
      embeds: [embed]
    });

    await msg.react('✅');
    await msg.react('❌');
    await msg.react('❓');

    const going = new Set();
    const notGoing = new Set();
    const maybe = new Set();

    const filter = (reaction, user) => 
      ['✅', '❌', '❓'].includes(reaction.emoji.name) && !user.bot;
    
    const collector = msg.createReactionCollector({ filter, time: eventTime.getTime() - now.getTime() });

    collector.on('collect', async (reaction, user) => {
      going.delete(user.id);
      notGoing.delete(user.id);
      maybe.delete(user.id);

      switch (reaction.emoji.name) {
        case '✅': going.add(user.id); break;
        case '❌': notGoing.add(user.id); break;
        case '❓': maybe.add(user.id); break;
      }

      const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
        .spliceFields(1, 1, {
          name: "RSVP",
          value: `React to let others know if you're coming!\n✅ Going (${going.size})\n❌ Not going (${notGoing.size})\n❓ Maybe (${maybe.size})`,
          inline: false
        });

      await msg.edit({ embeds: [updatedEmbed] });
    });

    collector.on('remove', async (reaction, user) => {
      switch (reaction.emoji.name) {
        case '✅': going.delete(user.id); break;
        case '❌': notGoing.delete(user.id); break;
        case '❓': maybe.delete(user.id); break;
      }

      const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
        .spliceFields(1, 1, {
          name: "RSVP",
          value: `React to let others know if you're coming!\n✅ Going (${going.size})\n❌ Not going (${notGoing.size})\n❓ Maybe (${maybe.size})`,
          inline: false
        });

      await msg.edit({ embeds: [updatedEmbed] });
    });

    setTimeout(async () => {
      if (going.size === 0) {
        await msg.reply('Event is starting, but nobody RSVP\'d as going! 😢');
        return;
      }

      const mentions = Array.from(going).map(id => `<@${id}>`).join(' ');
      await msg.reply(`⏰ **${title} is starting now!** ${mentions}`);
    }, eventTime.getTime() - now.getTime());

    await interaction.editReply({ 
      content: '✅ Event created! People can now RSVP with reactions.', 
      ephemeral: true
    });
    console.log(`[COMMAND] ${interaction.user.tag} created event: ${title} at ${timeStr}${role ? ` (pinging ${role.name})` : ''}`);
  }

  if (interaction.commandName === "profile") {
    const user = interaction.options.getUser("user") || interaction.user;
    const data = xpData[user.id] || { xp: 0, messages: 0 };
    const level = xpToLevel(data.xp);
    const xpForLevel = (lvl) => 100 * lvl * lvl;
    const currentLevelXp = xpForLevel(level);
    const nextXp = xpForLevel(level + 1);
    const progress = data.xp - currentLevelXp;
    const needed = nextXp - currentLevelXp;

    const embed = new EmbedBuilder()
      .setTitle(`${user.username}'s Profile`)
      .addFields(
        { name: "Level", value: `${level}`, inline: true },
        { name: "XP", value: `${data.xp} (+${progress}/${needed} toward next level)`, inline: true },
        { name: "Messages", value: `${data.messages}`, inline: true }
      )
      .setColor(0x5865F2)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.commandName === "leaderboard") {
    const entries = Object.entries(xpData);
    entries.sort((a, b) => (b[1].xp || 0) - (a[1].xp || 0));
    const top = entries.slice(0, 10);
    const desc = top.map(([id, d], i) => `${i + 1}. <@${id}> — Level ${xpToLevel(d.xp || 0)} (${d.xp || 0} XP)`).join("\n") || "No data yet.";
    const embed = new EmbedBuilder()
      .setTitle("🏆 XP Leaderboard")
      .setDescription(desc)
      .setColor(0xFFD700)
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.commandName === "debugapi") {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply({
        content: '❌ need admin perms for this one',
        ephemeral: true
      });
    }

    const playerName = interaction.options.getString("name");
    await interaction.deferReply({ ephemeral: true });

    try {
      const apiUrl = `https://api.torn.com/v2/faction/${FACTION_ID}?selections=members&key=${TORN_API_KEY}`;
      const res = await fetch(apiUrl);
      const data = await res.json();

      if (data.error) {
        return interaction.editReply(`❌ API Error: ${JSON.stringify(data.error, null, 2)}`);
      }

      const members = normalizeMembers(data);
      const member = members.find(m => m.name.toLowerCase().includes(playerName.toLowerCase()));

      if (!member) {
        return interaction.editReply(`❌ Could not find member with name containing "${playerName}"`);
      }

      // Show raw member data
      let response = `**Debug info for ${member.name}:**\n\`\`\`json\n`;
      response += JSON.stringify(member, null, 2);
      response += '\n```';

      await interaction.editReply(response.substring(0, 2000));
    } catch (err) {
      console.error("Debug API failed:", err);
      await interaction.editReply(`❌ Debug failed: ${err.message}`);
    }
  }

  if (interaction.commandName === "setnotoc") {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply({ content: '❌ admins only', ephemeral: true });
    }
    const channel = interaction.options.getChannel("channel");
    if (!channel || !channel.isTextBased()) {
      return interaction.reply({ content: '❌ pick a text channel', ephemeral: true });
    }
    config.notOcChannelId = channel.id;
    saveConfig();
    await interaction.reply({ content: `✅ Daily Not-in-OC reports will be posted to ${channel} (ID: ${channel.id})`, ephemeral: true });
  }

  if (interaction.commandName === "getnotoc") {
    const id = config.notOcChannelId || "(not set)";
    await interaction.reply({ content: `Configured Not-in-OC channel id: ${id}`, ephemeral: true });
  }

  if (interaction.commandName === "oc") {
    const now = Date.now();
    const entries = Object.entries(notOcState).filter(([_, data]) => data.last_not_in_oc !== null);
    
    if (entries.length === 0) {
      return interaction.reply({ content: "Everyone's in OC or no data available! 🎉"});
    }
    
    // Sort by duration (longest not in OC first)
    entries.sort((a, b) => {
      const durationA = a[1].last_not_in_oc ? now - a[1].last_not_in_oc : 0;
      const durationB = b[1].last_not_in_oc ? now - b[1].last_not_in_oc : 0;
      return durationB - durationA;
    });
    
    const lines = entries.map(([id, data]) => {
      const name = data.name || "Unknown";
      const lastNotInOc = data.last_not_in_oc;
      const durationSeconds = lastNotInOc ? Math.floor((now - lastNotInOc) / 1000) : null;
      const durationStr = durationSeconds !== null ? formatDuration(durationSeconds) : "N/A";
      const profileLink = playerProfileLink(id);

      return `• [${name}](${profileLink}) - not in OC for **${durationStr}**`;
    });
    
    // Build description and check length first
    let description = lines.join("\n") || "Everyone's in OC!";
    
    if (description.length > 4096) {
      const truncated = lines.slice(0, 50).join("\n");
      description = truncated + `\n\n*... and ${entries.length - 50} more*`;
    }
    
    const embed = new EmbedBuilder()
      .setTitle("🚨 Players Not in Organized Crime")
      .setDescription(description)
      .setColor(0xFF6B6B)
      .setFooter({ text: `Total: ${entries.length} player(s)` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed]});
  }

  if (interaction.commandName === "notinoc") {
    await interaction.deferReply({ ephemeral: true }).catch(()=>{});
    try {
      const report = buildNotInOcReportText(1900);
      await interaction.editReply({ content: report });
    } catch (err) {
      console.error("Failed to build/send not-in-OC report:", err);
      await interaction.editReply({ content: "❌ Failed to generate report, check logs.", ephemeral: true });
    }
  }

  if (interaction.commandName === "vote") {
    const text = interaction.options.getString("text");
    const emojis = [];
    for (let i = 1; i <= 5; i++) {
      const emoji = interaction.options.getString(`emoji${i}`);
      if (emoji) emojis.push(emoji);
    }
    if (emojis.length < 2) {
      return interaction.reply({ content: "❌ You must provide at least 2 emoji choices.", ephemeral: true });
    }

    // Build initial embed
    const embed = new EmbedBuilder()
      .setTitle("🗳️ Poll")
      .setDescription(text)
      .addFields(emojis.map((emoji, idx) => ({
        name: `Choice ${idx + 1}`,
        value: `${emoji} — **0** votes`,
        inline: false
      })))
      .setColor(0x5865F2)
      .setFooter({ text: `Poll by ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.reply({ content: "Poll created!", ephemeral: true });

    const msg = await interaction.channel.send({ embeds: [embed] });

    // React with each emoji
    for (const emoji of emojis) {
      try { await msg.react(emoji); } catch (err) { console.warn(`Failed to react with ${emoji}:`, err); }
      await new Promise(r => setTimeout(r, 300));
    }

    // Set up live vote counting
    const voteCounts = new Map(); // emoji -> Set of user ids
    for (const emoji of emojis) {
      voteCounts.set(emoji, new Set());
    }

    // Only allow one choice per person, remove others
    function clearOtherVotes(userId, selectedEmoji) {
      for (const [emoji, set] of voteCounts.entries()) {
        if (emoji !== selectedEmoji) set.delete(userId);
      }
    }

    const filter = (reaction, user) => !user.bot && emojis.includes(reaction.emoji.name || reaction.emoji.id || reaction.emoji.toString());

    const collector = msg.createReactionCollector({ filter, time: 60 * 60 * 1000 }); // 1 hour poll

    collector.on('collect', async (reaction, user) => {
      const emoji = reaction.emoji.name || reaction.emoji.id || reaction.emoji.toString();
      voteCounts.get(emoji)?.add(user.id);
      clearOtherVotes(user.id, emoji);

      // Remove user's other reactions
      for (const [otherEmoji] of voteCounts.entries()) {
        if (otherEmoji !== emoji) {
          const r = msg.reactions.cache.get(otherEmoji);
          if (r) await r.users.remove(user.id).catch(()=>{});
        }
      }

      // Update embed counts
      const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
        .setFields(emojis.map((e, idx) => ({
          name: `Choice ${idx + 1}`,
          value: `${e} — **${voteCounts.get(e)?.size || 0}** votes`,
          inline: false
        })));
      await msg.edit({ embeds: [updatedEmbed] });
    });

    collector.on('remove', async (reaction, user) => {
      const emoji = reaction.emoji.name || reaction.emoji.id || reaction.emoji.toString();
      voteCounts.get(emoji)?.delete(user.id);

      // Update embed counts
      const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
        .setFields(emojis.map((e, idx) => ({
          name: `Choice ${idx + 1}`,
          value: `${e} — **${voteCounts.get(e)?.size || 0}** votes`,
          inline: false
        })));
      await msg.edit({ embeds: [updatedEmbed] });
    });

    collector.on('end', async () => {
      const finalEmbed = EmbedBuilder.from(msg.embeds[0])
        .setTitle("🗳️ Poll (Closed)")
        .setFields(emojis.map((e, idx) => ({
          name: `Choice ${idx + 1}`,
          value: `${e} — **${voteCounts.get(e)?.size || 0}** final votes`,
          inline: false
        })));
      await msg.edit({ embeds: [finalEmbed] });
    });
  }
});

// Register all slash commands
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const commands = [
    new SlashCommandBuilder()
      .setName("jail")
      .setDescription("Configure jail alert notifications")
      .addChannelOption(option =>
        option.setName("channel").setDescription("Channel for jail alerts").setRequired(true)
      )
      .addRoleOption(option =>
        option.setName("role").setDescription("Role to ping for jail alerts").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("testjail")
      .setDescription("Send a test jail alert"),
    new SlashCommandBuilder()
      .setName("testapi")
      .setDescription("Test the Torn API connection and show current jail status"),
    new SlashCommandBuilder()
      .setName("debugapi")
      .setDescription("Show raw API data for a specific member")
      .addStringOption(option =>
        option.setName("name").setDescription("Player name to debug").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("jailstatus")
      .setDescription("Check who's currently in jail"),
    new SlashCommandBuilder()
      .setName("rolereact")
      .setDescription("Create a role reaction message")
      .addRoleOption(option => option.setName("role1").setDescription("First role").setRequired(true))
      .addStringOption(option => option.setName("emoji1").setDescription("First emoji").setRequired(true))
      .addRoleOption(option => option.setName("role2").setDescription("Second role").setRequired(false))
      .addStringOption(option => option.setName("emoji2").setDescription("Second emoji").setRequired(false))
      .addRoleOption(option => option.setName("role3").setDescription("Third role").setRequired(false))
      .addStringOption(option => option.setName("emoji3").setDescription("Third emoji").setRequired(false))
      .addRoleOption(option => option.setName("role4").setDescription("Fourth role").setRequired(false))
      .addStringOption(option => option.setName("emoji4").setDescription("Fourth emoji").setRequired(false))
      .addRoleOption(option => option.setName("role5").setDescription("Fifth role").setRequired(false))
      .addStringOption(option => option.setName("emoji5").setDescription("Fifth emoji").setRequired(false)),
    new SlashCommandBuilder()
      .setName("setwelcome")
      .setDescription("Set the welcome message channel")
      .addChannelOption(option =>
        option.setName("channel").setDescription("Channel for welcome messages").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("setunverified")
      .setDescription("Set the unverified role for new members")
      .addRoleOption(option =>
        option.setName("role").setDescription("Role to assign to new members").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("event")
      .setDescription("Create an event with RSVP tracking")
      .addStringOption(option =>
        option.setName("title").setDescription("Event title").setRequired(true)
      )
      .addStringOption(option =>
        option.setName("time").setDescription("Event time (YYYY-MM-DDTHH:MM:SSZ format)").setRequired(true)
      )
      .addStringOption(option =>
        option.setName("description").setDescription("Event description").setRequired(false)
      )
      .addRoleOption(option =>
        option.setName("role").setDescription("Role to ping (requires Manage Messages permission)").setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("profile")
      .setDescription("View your XP profile or someone else's")
      .addUserOption(option =>
        option.setName("user").setDescription("User to check (leave blank for yourself)").setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("leaderboard")
      .setDescription("View the XP leaderboard"),
    new SlashCommandBuilder()
      .setName("setnotoc")
      .setDescription("Configure daily Not-in-OC report channel")
      .addChannelOption(option =>
        option.setName("channel").setDescription("Channel for Not-in-OC reports").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("getnotoc")
      .setDescription("Show configured Not-in-OC report channel id"),
    new SlashCommandBuilder()
      .setName("oc")
      .setDescription("Show players not in organized crime and how long they've been out"),
    new SlashCommandBuilder()
      .setName("notinoc")
      .setDescription("Post the not-in-OC report"),
    new SlashCommandBuilder()
      .setName("vote")
      .setDescription("Start a poll that users can vote on using emojis")
      .addStringOption(option =>
        option.setName("text").setDescription("The poll question or description").setRequired(true))
      .addStringOption(option =>
        option.setName("emoji1").setDescription("Emoji for choice 1").setRequired(true))
      .addStringOption(option =>
        option.setName("emoji2").setDescription("Emoji for choice 2").setRequired(true))
      .addStringOption(option =>
        option.setName("emoji3").setDescription("Emoji for choice 3").setRequired(false))
      .addStringOption(option =>
        option.setName("emoji4").setDescription("Emoji for choice 4").setRequired(false))
      .addStringOption(option =>
        option.setName("emoji5").setDescription("Emoji for choice 5").setRequired(false)),
  ].map(cmd => cmd.toJSON());

  try {
    console.log("Registering slash commands globally...");
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log("✅ All commands registered globally!");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

const CHAIN_WATCH_CHANNEL_ID = '1168943503544418354';

const chainWatchSchedule = [
  { userId: '1029159689612689448', datetime: '2025-10-25 10:40', name: 'TEST' },
  { userId: '1277971252023263312', datetime: '2025-10-25 18:25', name: 'Pooboi' }
];

let sentChainWatch = {};

function parseDateTime(dateTimeStr) {
  const [date, time] = dateTimeStr.split(' ');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

async function processChainWatchSchedule() {
  const now = new Date();
  
  for (const entry of chainWatchSchedule) {
    const targetTime = parseDateTime(entry.datetime);
    const key = `${entry.userId}_${entry.datetime}_${entry.name}`;
    
    if (Math.abs(now - targetTime) <= 60000 && !sentChainWatch[key]) {
      try {
        const channel = await client.channels.fetch(CHAIN_WATCH_CHANNEL_ID).catch(() => null);
        if (!channel || !channel.isTextBased()) {
          console.error("Chain watch channel config is invalid, skipping reminder");
          continue;
        }
        await channel.send(`⏰ <@${entry.userId}>\n**Reminder:** ${entry.name} your chain watching starts now! 📺`);
        sentChainWatch[key] = true;
      } catch (err) {
        console.error("Failed to send chain watch reminder:", err);
      }
    }
  }
}

let _readyHandled = false;
async function handleClientReady() {
  if (_readyHandled) return;
  _readyHandled = true;

  try {
    console.log(`Logged in as ${client.user?.tag || 'unknown user'}!`);

    // Set bot status
    client.user.setActivity('mommy ASMR', { type: 2 }); // Type 2 is "Listening to"
    
    unverifiedRoleId = config.unverifiedRoleId || null;
    welcomeChannelId = config.welcomeChannelId || null;

    await registerCommands();

    try {
      await checkFactionJail();
    } catch (err) {
      console.error("Error during initial jail check:", err);
    }

    processChainWatchSchedule();

    setInterval(async () => {
      try {
        await checkFactionJail();
      } catch (err) {
        console.error("Error during scheduled jail check:", err);
      }

      processChainWatchSchedule();
    }, POLL_INTERVAL);
  } catch (err) {
    console.error("Error in client ready handler:", err);
  }
}

// Use clientReady for Discord.js v14+ (ready is deprecated)
client.once('clientReady', handleClientReady);

client.login(DISCORD_TOKEN);