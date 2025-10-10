// Import required modules
import fs from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";
import {
  Client,
  GatewayIntentBits,
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
    // Add unverified role
    if (unverifiedRoleId) {
      await member.roles.add(unverifiedRoleId);
      console.log(`Slapped unverified role on ${member.user.tag} hehe`);
    }

    // Send welcome message
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
  
  // Handle partial reactions
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
      
      // Initialize state object if needed
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

      // JAIL TIME INCREASED (bailed and re-jailed)
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

  // /jail command
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

  // /testjail command
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

  // /rolereact command
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
    
    // Add reactions with delay to avoid rate limits
    for (const { emoji } of pairs) {
      await msg.react(emoji).catch((err) => {
        console.error(`Couldn't react with ${emoji}:`, err);
      });
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Store mapping
    const emojiRoleMap = {};
    for (const { role, emoji } of pairs) {
      emojiRoleMap[emoji] = role.id;
    }
    activeRoleReactMessages.set(msg.id, emojiRoleMap);
    saveRoleReactMessages();

    await interaction.editReply({ content: '✅ Role react message is live! go nuts', ephemeral: true });
  }

  // /setwelcome command
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

  // /setunverified command
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

  // /jailstatus command
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

  // /event command
  if (interaction.commandName === "event") {
    const title = interaction.options.getString("title");
    const description = interaction.options.getString("description") || "No description provided lol";
    const timeStr = interaction.options.getString("time");
    const role = interaction.options.getRole("role");

    // Only require ManageMessages permission if trying to ping a role
    if (role && !interaction.member.permissions.has('ManageMessages')) {
      return interaction.reply({ 
        content: '❌ You need Manage Messages permission to ping roles with events', 
        ephemeral: true 
      });
    }

    // Validate the ISO 8601 time format
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

    // Check if event is in the future
    const now = new Date();
    if (eventTime <= now) {
      return interaction.reply({
        content: "❌ Event time must be in the future!",
        ephemeral: true
      });
    }

    // Create the event embed with Discord timestamps
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

    // Send event message and add reaction options
    const msg = await interaction.channel.send({
      content: role ? `<@&${role.id}> 📅 New event!` : "📅 New event!",
      embeds: [embed]
    });

    // Add RSVP reactions
    await msg.react('✅');
    await msg.react('❌');
    await msg.react('❓');

    // Track RSVPs
    const going = new Set();
    const notGoing = new Set();
    const maybe = new Set();

    const filter = (reaction, user) => 
      ['✅', '❌', '❓'].includes(reaction.emoji.name) && !user.bot;
    
    const collector = msg.createReactionCollector({ filter, time: eventTime.getTime() - now.getTime() });

    collector.on('collect', async (reaction, user) => {
      // Remove user from all other response sets
      going.delete(user.id);
      notGoing.delete(user.id);
      maybe.delete(user.id);

      // Add to appropriate set
      switch (reaction.emoji.name) {
        case '✅': going.add(user.id); break;
        case '❌': notGoing.add(user.id); break;
        case '❓': maybe.add(user.id); break;
      }

      // Update embed with current counts
      const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
        .spliceFields(1, 1, {
          name: "RSVP",
          value: `React to let others know if you're coming!\n✅ Going (${going.size})\n❌ Not going (${notGoing.size})\n❓ Maybe (${maybe.size})`,
          inline: false
        });

      await msg.edit({ embeds: [updatedEmbed] });
    });

    collector.on('remove', async (reaction, user) => {
      // Remove from appropriate set
      switch (reaction.emoji.name) {
        case '✅': going.delete(user.id); break;
        case '❌': notGoing.delete(user.id); break;
        case '❓': maybe.delete(user.id); break;
      }

      // Update embed with current counts
      const updatedEmbed = EmbedBuilder.from(msg.embeds[0])
        .spliceFields(1, 1, {
          name: "RSVP",
          value: `React to let others know if you're coming!\n✅ Going (${going.size})\n❌ Not going (${notGoing.size})\n❓ Maybe (${maybe.size})`,
          inline: false
        });

      await msg.edit({ embeds: [updatedEmbed] });
    });

    // When event starts, ping everyone who's going
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
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully... peace out!');
  saveState();
  saveConfig();
  saveRoleReactMessages();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Got the shutdown signal... bye bye!');
  saveState();
  saveConfig();
  saveRoleReactMessages();
  client.destroy();
  process.exit(0);
});

// Login and start bot
client.login(DISCORD_TOKEN).then(async () => {
  console.log(`🎉 Logged in as ${client.user.tag} - let's gooooo`);

  client.user.setPresence({
    activities: [{ name: "Mommy ASMR", type: 2 }],
    status: "online"
  });

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  
  const commands = [
    new SlashCommandBuilder()
      .setName("setwelcome")
      .setDescription("Set where to spam welcome messages")
      .addChannelOption(opt =>
        opt
          .setName("channel")
          .setDescription("The channel to spam in")
          .setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("setunverified")
      .setDescription("Set auto-role for new members")
      .addRoleOption(opt =>
        opt
          .setName("role")
          .setDescription("The role to slap on newbies")
          .setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("jail")
      .setDescription("Setup jail stalking (lobdell idea)")
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Where to send jail alerts")
          .setRequired(true)
      )
      .addRoleOption((opt) =>
        opt
          .setName("role")
          .setDescription("Role to ping when someone gets arrested")
          .setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("testjail")
      .setDescription("Send a fake jail alert to test if it works")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("jailstatus")
      .setDescription("Check who's currently in the chambers")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("rolereact")
      .setDescription("Create a message where people can react for roles")
      .addRoleOption((opt) =>
        opt
          .setName("role1")
          .setDescription("First role")
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("emoji1")
          .setDescription("Emoji for first role")
          .setRequired(true)
      )
      .addRoleOption((opt) =>
        opt.setName("role2").setDescription("Second role")
      )
      .addStringOption((opt) =>
        opt.setName("emoji2").setDescription("Emoji for second role")
      )
      .addRoleOption((opt) =>
        opt.setName("role3").setDescription("Third role")
      )
      .addStringOption((opt) =>
        opt.setName("emoji3").setDescription("Emoji for third role")
      )
      .addRoleOption((opt) =>
        opt.setName("role4").setDescription("Fourth role")
      )
      .addStringOption((opt) =>
        opt.setName("emoji4").setDescription("Emoji for fourth role")
      )
      .addRoleOption((opt) =>
        opt.setName("role5").setDescription("Fifth role")
      )
      .addStringOption((opt) =>
        opt.setName("emoji5").setDescription("Emoji for fifth role")
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("event")
      .setDescription("Create an event announcement with a date/time")
      .addStringOption(opt =>
        opt.setName("title")
          .setDescription("Event title")
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName("time")
          .setDescription("Event time like 2025-10-08T20:00:00Z (year-month-day T hour:min:sec Z)")
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName("description")
          .setDescription("Event description (optional)")
          .setRequired(false)
      )
      .addRoleOption(opt =>
        opt.setName("role")
          .setDescription("Role to ping for this event (optional)")
          .setRequired(false)
      )
      .toJSON(),
  ];

  try {
    console.log("Registering slash commands...");
    
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(client.user.id, GUILD_ID)
      : Routes.applicationCommands(client.user.id);
    
    await rest.put(route, { body: commands });
    console.log(`✅ Commands registered ${GUILD_ID ? 'to guild' : 'globally'}!`);
  } catch (err) {
    console.error("Command registration went boom:", err);
  }

  // Start jail monitoring
  console.log(`👀 Starting jail stalking (checking every ${POLL_INTERVAL / 1000}s)...`);
  checkFactionJail();
  setInterval(checkFactionJail, POLL_INTERVAL);
}).catch(err => {
  console.error("Login failed rip:", err);
  process.exit(1);
});
