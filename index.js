// Import required modules
import fs from "fs"; // For reading/writing config and state files
import fetch from "node-fetch"; // For calling the Torn API
import dotenv from "dotenv"; // For reading environment variables from .env
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder
} from "discord.js"; // Discord.js handles bot interaction and messaging

// Load environment variables from .env file
dotenv.config();

// Load important tokens and IDs from environment variables
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const TORN_API_KEY = process.env.TORN_API_KEY;
const FACTION_ID = process.env.FACTION_ID;
const GUILD_ID = process.env.GUILD_ID;

// How often the bot checks the Torn API (defaults to 60s if not specified)
const POLL_INTERVAL = (parseInt(process.env.POLL_INTERVAL || "60") || 60) * 1000;

// Paths for storing bot configuration and jail state data
const CONFIG_FILE = "./config.json";
const STATE_FILE = "./jailstate.json";

// Ensure required environment variables are set, otherwise stop the program

// DISCORD TOKEN
if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

//TORN API
if (!TORN_API_KEY) {
  console.error("Missing TORN_API_KEY in .env");
  process.exit(1);
}

//TARGET FACTION ID
if (!FACTION_ID) {
  console.error("Missing FACTION_ID in .env");
  process.exit(1);
}

// Create the Discord bot client with required permissions
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,           // For basic guild operations
    GatewayIntentBits.GuildMembers,     // For member join events
    GatewayIntentBits.GuildMessages,    // For message operations
    GatewayIntentBits.MessageContent,   // For reading message content
    GatewayIntentBits.GuildEmojisAndStickers,  // For emoji reactions
    GatewayIntentBits.GuildMessageReactions,   // For handling reactions
  ],
});

// Load saved configuration and jail state from disk (if available)
let config = fs.existsSync(CONFIG_FILE)
  ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))
  : {};

let jailState = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  : {};

// Save bot config (channel and role info) to config.json
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error("Error saving config:", err);
  }
}

// Save jail state (who’s in jail) to jailstate.json
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(jailState, null, 2));
  } catch (err) {
    console.error("Error saving state:", err);
  }
}

// Helper: create a Torn player profile link
const playerProfileLink = (id) => `https://www.torn.com/profiles.php?XID=${id}`;

// Helper: normalize faction member data into a consistent array format
const normalizeMembers = (apiData) => {
  const members = [];
  if (!apiData || !apiData.members) return members;

  // Torn sometimes returns members as an object rather than array
  if (Array.isArray(apiData.members)) return apiData.members;

  // Convert member object into an array
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

// --- Role React Feature ---
// Store active role-react messages and their emoji-role mapping
const activeRoleReactMessages = new Map();

// /roleReact command handler
async function handleRoleReact(interaction) {
  // Only allow admins to use this command (optional)
  if (!interaction.member.permissions.has('Administrator')) {
    return interaction.reply({ content: '❌ You need admin permissions to use this command.', ephemeral: true });
  }

  // Collect up to 5 role/emoji pairs from options
  const pairs = [];
  for (let i = 1; i <= 5; i++) {
    const role = interaction.options.getRole(`role${i}`);
    const emoji = interaction.options.getString(`emoji${i}`);
    if (role && emoji) {
      pairs.push({ role, emoji });
    }
  }
  if (pairs.length === 0) {
    return interaction.reply({ content: '❌ You must specify at least one role/emoji pair.', ephemeral: true });
  }

  // Compose the embed message
  const embed = new EmbedBuilder()
    .setTitle('🎭 Role Selection')
    .setDescription('React to get cool, colourful shiny roles!\nClick a reaction below to receive the corresponding role. YUPEE!')
    .setColor(0x9b59b6) // A nice blue color
    .addFields(
      pairs.map(({ role, emoji }) => ({
        name: `${emoji} ${role.name}`,
        value: ``,
        inline: true
      }))
    )
    .setFooter({ text: 'Remove your reaction to lose the role' })
    .setTimestamp();

  // Send the embed message
  const msg = await interaction.channel.send({ embeds: [embed] });
  // Add reactions
  for (const { emoji } of pairs) {
    await msg.react(emoji).catch(() => {});
  }

  // Store mapping for this message
  const emojiRoleMap = {};
  for (const { role, emoji } of pairs) {
    emojiRoleMap[emoji] = role.id;
  }
  activeRoleReactMessages.set(msg.id, emojiRoleMap);

  await interaction.reply({ content: 'Role react message sent!', ephemeral: true });
}

// Auto-role configuration
let unverifiedRoleId = config.unverifiedRoleId || null;

// Listen for new members joining
client.on('guildMemberAdd', async (member) => {
  if (!unverifiedRoleId) return;
  try {
    await member.roles.add(unverifiedRoleId);
    console.log(`Added unverified role to new member: ${member.user.tag}`);
  } catch (err) {
    console.error(`Failed to add unverified role to ${member.user.tag}:`, err);
  }
});

// Listen for reaction add/remove events
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
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
    await member.roles.add(roleId).catch(() => {});
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
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
    await member.roles.remove(roleId).catch(() => {});
  }
});

// Main function: check the Torn API to see who’s been jailed or released
async function checkFactionJail() {
  // Skip if bot hasn’t been configured with a channel or role
  if (!config.channelId || !config.roleId) return;
  
  try {
    // Fetch faction data from Torn API
    const res = await fetch(
      `https://api.torn.com/v2/faction/${FACTION_ID}?selections=members&key=${TORN_API_KEY}`
    );
    
    // Handle HTTP errors
    if (!res.ok) {
      console.error(`API error: ${res.status} ${res.statusText}`);
      return;
    }
    
    // Parse JSON data
    const data = await res.json();
    
    // Handle Torn API-specific errors
    if (data.error) {
      console.error("Torn API error:", data.error);
      return;
    }
    
    // Normalize member data
    const members = normalizeMembers(data);
    console.log(`Checking ${members.length} faction members...`);
    
    // Fetch the Discord channel for jail notifications
    const channel = await client.channels.fetch(config.channelId);
    
    if (!channel || !channel.isTextBased()) {
      console.error("Invalid channel configuration");
      return;
    }

    // Keep track of all member IDs currently in faction
    const currentMemberIds = new Set();

    // Loop through each member
    for (const m of members) {
      const id = String(m.player_id);
      currentMemberIds.add(id);
      const jailTime = Number(m.jail_time || 0); // Current jail time in seconds
      const prev = Number(jailState[id] || 0);   // Previous jail time (from last check)

      // Log member jail status for debugging
      if (jailTime > 0) {
        console.log(`${m.name} (${id}): jail_time=${jailTime}, prev=${prev}`);
      }

      // CASE 1: Member has just been jailed
      if (jailTime > 0 && prev === 0) {
        const minutes = Math.ceil(jailTime / 60);

        // Create the jail embed notification
        const embed = new EmbedBuilder()
          .setTitle("🚨 Faction Member Jailed")
          .setDescription(`${m.name} has just been jailed!`)
          .addFields(
            { name: "Time left", value: `${minutes} minute(s)`, inline: true },
            { name: "Profile", value: `[Open profile](${playerProfileLink(id)})`, inline: true }
          )
          .setColor(0x9370DB)
          .setTimestamp();

        // Send the message to Discord
        await channel.send({
          content: `<@&${config.roleId}> • ${m.name} went to jail!`,
          embeds: [embed]
        });
      }

      // CASE 2: Member has just been released from jail
      if (prev > 0 && jailTime === 0) {
        const embed = new EmbedBuilder()
          .setTitle("✅ Faction Member Released")
          .setDescription(`${m.name} has been released from jail!`)
          .addFields(
            { name: "Profile", value: `[Open profile](${playerProfileLink(id)})`, inline: true }
          )
          .setColor(0x9370DB)
          .setTimestamp();

        await channel.send({
          content: `${m.name} is free!`,
          embeds: [embed]
        });
      }

      // Update stored jail state for this member
      jailState[id] = jailTime;
    }

    // Clean up old entries (remove players no longer in faction)
    for (const id in jailState) {
      if (!currentMemberIds.has(id) && jailState[id] === 0) {
        delete jailState[id];
      }
    }

    // Save updated jail state to file
    saveState();
  } catch (err) {
    console.error("Error checking jail:", err);
  }
}

// Handle slash command interactions from Discord
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // /jail command: used to configure the alert channel and role
  if (interaction.commandName === "jail") {
    const channel = interaction.options.getChannel("channel");
    const role = interaction.options.getRole("role");

    // Save the selected channel and role to config
    config.channelId = channel.id;
    config.roleId = role.id;
    saveConfig();

    console.log(`[COMMAND] /jail used by ${interaction.user.tag} - Channel: ${channel.name}, Role: ${role.name}`);

    await interaction.reply(
      `✅ Jail alerts configured! Channel: ${channel.name}, Role: ${role.name}`
    );
  }

  // /testjail command: send a fake jail alert for testing
  if (interaction.commandName === "testjail") {
    console.log(`[COMMAND] /testjail used by ${interaction.user.tag}`);
    
    // Ensure config exists before testing
    if (!config.channelId || !config.roleId) {
      return interaction.reply("❌ Configure a channel and role first using /jail.");
    }

    try {
      const channel = await client.channels.fetch(config.channelId);
      if (!channel || !channel.isTextBased()) {
        return interaction.reply("❌ Invalid channel configuration.");
      }

      // Create a test embed message
      const embed = new EmbedBuilder()
        .setTitle("🚨 Faction Member Jailed (Test)")
        .setDescription("TestUser has just been jailed!")
        .addFields(
          { name: "Time left", value: `60 minute(s)`, inline: true },
          { name: "Profile", value: `[Open profile](https://www.torn.com/profiles.php?XID=12345)`, inline: true }
        )
        .setColor(0x9370DB)
        .setTimestamp();

      // Send the test alert to the configured channel
      await channel.send({
        content: `<@&${config.roleId}> • TestUser went to jail!`,
        embeds: [embed]
      });

      await interaction.reply("✅ Test jail alert sent!");
    } catch (err) {
      console.error("Error sending test alert:", err);
      await interaction.reply("❌ Error sending test alert. Check logs.");
    }
  }

  // /roleReact command: setup a message for role reactions
  if (interaction.commandName === "rolereact") {
    await handleRoleReact(interaction);
  }

  // /setunverified command: configure auto-role for new members
  if (interaction.commandName === "setunverified") {
    const role = interaction.options.getRole("role");
    unverifiedRoleId = role.id;
    config.unverifiedRoleId = role.id;
    saveConfig();
    await interaction.reply(`✅ New members will now automatically receive the ${role.name} role.`);
  }

  // End of command handlers
});

// Handle graceful shutdown (e.g., Ctrl+C or server stop)
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  saveState();
  saveConfig();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  saveState();
  saveConfig();
  client.destroy();
  process.exit(0);
});

// Log into Discord and start the bot
client.login(DISCORD_TOKEN).then(async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register slash commands (/jail and /testjail)
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  
  const commands = [
    new SlashCommandBuilder()
      .setName("setunverified")
      .setDescription("Set the role to be automatically added to new members")
      .addRoleOption(opt =>
        opt
          .setName("role")
          .setDescription("The role to add to new members")
          .setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("jail")
      .setDescription("Setup jail notifications (lobdells idea)") // Lobdell gets credit :)
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Channel for jail alerts")
          .setRequired(true)
      )
      .addRoleOption((opt) =>
        opt
          .setName("role")
          .setDescription("Role to mention on jail alerts")
          .setRequired(true)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("testjail")
      .setDescription("Send a fake jail alert for testing")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("rolereact")
      .setDescription("Setup a message for role reactions")
      .addRoleOption((opt) =>
        opt
          .setName("role1")
          .setDescription("First role to assign")
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("emoji1")
          .setDescription("Emoji for the first role")
          .setRequired(true)
      )
      .addRoleOption((opt) =>
        opt
          .setName("role2")
          .setDescription("Second role to assign")
      )
      .addStringOption((opt) =>
        opt
          .setName("emoji2")
          .setDescription("Emoji for the second role")
      )
      .addRoleOption((opt) =>
        opt
          .setName("role3")
          .setDescription("Third role to assign")
      )
      .addStringOption((opt) =>
        opt
          .setName("emoji3")
          .setDescription("Emoji for the third role")
      )
      .addRoleOption((opt) =>
        opt
          .setName("role4")
          .setDescription("Fourth role to assign")
      )
      .addStringOption((opt) =>
        opt
          .setName("emoji4")
          .setDescription("Emoji for the fourth role")
      )
      .addRoleOption((opt) =>
        opt
          .setName("role5")
          .setDescription("Fifth role to assign")
      )
      .addStringOption((opt) =>
        opt
          .setName("emoji5")
          .setDescription("Emoji for the fifth role")
      )
      .toJSON(),

    // Command list ends here
  ];

  try {
    console.log("Registering slash commands...");
    
    // Register commands globally or to a specific guild (if GUILD_ID provided)
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(client.user.id, GUILD_ID)
      : Routes.applicationCommands(client.user.id);
    
    await rest.put(route, { body: commands });
    console.log(`Slash commands registered ${GUILD_ID ? 'to guild' : 'globally'}.`);
  } catch (err) {
    console.error("Error registering commands:", err);
  }

  // Start periodic jail checks
  console.log(`Starting jail monitoring (polling every ${POLL_INTERVAL / 1000}s)...`);
  checkFactionJail(); // Run immediately once
  setInterval(checkFactionJail, POLL_INTERVAL); // Schedule repeat checks
}).catch(err => {
  console.error("Failed to login:", err);
  process.exit(1);
});
