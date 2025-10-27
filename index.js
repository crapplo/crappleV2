// Import required modules
import fs from "fs";
import fetch from "node-fetch";
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
const POLL_INTERVAL = (parseInt(process.env.POLL_INTERVAL || "60") || 60) * 1000;

// File paths for persistence
const CONFIG_FILE = "./config.json";
const STATE_FILE = "./jailstate.json";
const ROLE_REACT_FILE = "./rolereact.json";
const XP_FILE = "./xp.json";

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
const XP_MIN = 5;
const XP_MAX = 15;
const COOLDOWN_MS = 60 * 1000;

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
  if (!apiData || !apiData.members) return members;

  if (Array.isArray(apiData.members)) return apiData.members;

  for (const key of Object.keys(apiData.members)) {
    const m = apiData.members[key];
    members.push({
      player_id: m.player_id || Number(key),
      name: m.name || m.player_name || "Unknown",
      jail_time: m.jail_time || 0
    });
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

// Add messageCreate handler for XP awarding with cooldown
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.channel || (message.channel && !message.channel.isTextBased())) return;

    const key = `${message.guild.id}_${message.author.id}`;
    const last = xpCooldowns.get(key) || 0;
    const now = Date.now();
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
      message.channel.send(`🎉 <@${uid}> leveled up to **${newLevel}**! Congrats!`).catch(()=>{});
    }
  } catch (err) {
    console.error("XP handler error:", err);
  }
});

// Main jail checking function
async function checkFactionJail() {
  if (!config.channelId || !config.roleId) return;
  
  try {
    const res = await fetch(
      `https://api.torn.com/v2/faction/${FACTION_ID}?selections=members&key=${TORN_API_KEY}`
    );
    
    if (!res.ok) {
      console.error(`API said nope: ${res.status} ${res.statusText}`);
      return;
    }
    
    const data = await res.json();
    
    if (data.error) {
      console.error("Torn API is having a moment (let's give them a moment):", data.error);
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
        jailState[id] = { time: 0, lastSeen: now };
      }
      
      const jailTime = Number(m.jail_time || 0);
      const prevTime = Number(jailState[id].time || 0);
      
      jailState[id].lastSeen = now;

      if (jailTime > 0) {
        console.log(`${m.name} (${id}): jail_time=${jailTime}, prev=${prevTime}`);
      }

      // NEWLY JAILED
      if (jailTime > 0 && prevTime === 0) {
        const embed = new EmbedBuilder()
          .setTitle("🚨 OH NO THEY GOT ARRESTED")
          .setDescription(`${m.name} just got thrown in the chambers lmaooo`)
          .addFields(
            { name: "Time left", value: formatJailTime(jailTime), inline: true },
            { name: "Profile", value: `[go laugh at them](${playerProfileLink(id)})`, inline: true }
          )
          .setColor(0xFF6B6B)
          .setTimestamp();

        await channel.send({
          content: `<@&${config.roleId}> yo ${m.name} got jailed`,
          embeds: [embed]
        });
      }

      // RELEASED FROM JAIL
      if (prevTime > 0 && jailTime === 0) {
        const embed = new EmbedBuilder()
          .setTitle("✅ FREEDOM!!!")
          .setDescription(`${m.name} is out of jail! welcome back to society`)
          .addFields(
            { name: "Profile", value: `[say hi](${playerProfileLink(id)})`, inline: true }
          )
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
          .setTitle("🔄 LMAO THEY GOT JAILED AGAIN")
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
  } catch (err) {
    console.error("Jail check went boom:", err);
  }
}

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
          { name: "Time left", value: `69m (nice)`, inline: true },
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
      .map(([id, data]) => `• <@${id}>: ${formatJailTime(data.time)}`)
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

    const embed = new EmbedBuilder()
      .setTitle(`${user.username}'s Profile`)
      .addFields(
        { name: "Level", value: `${level}`, inline: true },
        { name: "XP", value: `${data.xp} ( +${progress}/${nextXp - currentLevelXp} toward next level )`, inline: true },
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
});

// Register XP commands at startup so they show up in Discord
(async () => {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const commands = [
    new SlashCommandBuilder()
      .setName("profile")
      .setDescription("View your XP profile or someone else's")
      .addUserOption(option =>
        option.setName("user").setDescription("User to check (default: you)").setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("leaderboard")
      .setDescription("View the XP leaderboard"),
    // ...add other commands here if needed...
  ].map(cmd => cmd.toJSON());

  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log("XP commands registered.");
  } catch (err) {
    console.error("Failed to register XP commands:", err);
  }
})();

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

    unverifiedRoleId = config.unverifiedRoleId || null;
    welcomeChannelId = config.welcomeChannelId || null;

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

client.once('clientReady', handleClientReady);

client.login(DISCORD_TOKEN);