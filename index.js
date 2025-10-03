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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
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
      .toJSON()
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
