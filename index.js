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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const TORN_API_KEY = process.env.TORN_API_KEY;
const FACTION_ID = process.env.FACTION_ID;
const GUILD_ID = process.env.GUILD_ID;
const POLL_INTERVAL = (parseInt(process.env.POLL_INTERVAL || "60") || 60) * 1000;
const CONFIG_FILE = "./config.json";
const STATE_FILE = "./jailstate.json";

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

if (!TORN_API_KEY) {
  console.error("Missing TORN_API_KEY in .env");
  process.exit(1);
}

if (!FACTION_ID) {
  console.error("Missing FACTION_ID in .env");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

let config = fs.existsSync(CONFIG_FILE)
  ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))
  : {};

let jailState = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  : {};

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error("Error saving config:", err);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(jailState, null, 2));
  } catch (err) {
    console.error("Error saving state:", err);
  }
}

const playerProfileLink = (id) => `https://www.torn.com/profiles.php?XID=${id}`;

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

async function checkFactionJail() {
  if (!config.channelId || !config.roleId) return;
  
  try {
    const res = await fetch(
      `https://api.torn.com/faction/${FACTION_ID}?selections=members&key=${TORN_API_KEY}`
    );
    
    if (!res.ok) {
      console.error(`API error: ${res.status} ${res.statusText}`);
      return;
    }
    
    const data = await res.json();
    
    if (data.error) {
      console.error("Torn API error:", data.error);
      return;
    }
    
    const members = normalizeMembers(data);
    console.log(`Checking ${members.length} faction members...`);
    
    const channel = await client.channels.fetch(config.channelId);
    
    if (!channel || !channel.isTextBased()) {
      console.error("Invalid channel configuration");
      return;
    }

    const currentMemberIds = new Set();

    for (const m of members) {
      const id = String(m.player_id);
      currentMemberIds.add(id);
      const jailTime = Number(m.jail_time || 0);
      const prev = Number(jailState[id] || 0);

      if (jailTime > 0) {
        console.log(`${m.name} (${id}): jail_time=${jailTime}, prev=${prev}`);
      }

      if (jailTime > 0 && prev === 0) {
        const minutes = Math.ceil(jailTime / 60);
        const embed = new EmbedBuilder()
          .setTitle("🚨 Faction Member Jailed")
          .setDescription(`${m.name} has just been jailed!`)
          .addFields(
            { name: "Time left", value: `${minutes} minute(s)`, inline: true },
            { name: "Profile", value: `[Open profile](${playerProfileLink(id)})`, inline: true }
          )
          .setColor(0x9370DB)
          .setTimestamp();

        await channel.send({
          content: `<@&${config.roleId}> • ${m.name} went to jail!`,
          embeds: [embed]
        });
      }

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

      jailState[id] = jailTime;
    }

    for (const id in jailState) {
      if (!currentMemberIds.has(id) && jailState[id] === 0) {
        delete jailState[id];
      }
    }

    saveState();
  } catch (err) {
    console.error("Error checking jail:", err);
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "jail") {
    const channel = interaction.options.getChannel("channel");
    const role = interaction.options.getRole("role");

    config.channelId = channel.id;
    config.roleId = role.id;
    saveConfig();

    await interaction.reply(
      `✅ Jail alerts configured! Channel: ${channel.name}, Role: ${role.name}`
    );
  }

  if (interaction.commandName === "testjail") {
    if (!config.channelId || !config.roleId) {
      return interaction.reply("❌ Configure a channel and role first using /jail.");
    }

    try {
      const channel = await client.channels.fetch(config.channelId);
      if (!channel || !channel.isTextBased()) {
        return interaction.reply("❌ Invalid channel configuration.");
      }

      const embed = new EmbedBuilder()
        .setTitle("🚨 Faction Member Jailed (Test)")
        .setDescription("TestUser has just been jailed!")
        .addFields(
          { name: "Time left", value: `60 minute(s)`, inline: true },
          { name: "Profile", value: `[Open profile](https://www.torn.com/profiles.php?XID=12345)`, inline: true }
        )
        .setColor(0x9370DB)
        .setTimestamp();

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

client.login(DISCORD_TOKEN).then(async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  
  const commands = [
    new SlashCommandBuilder()
      .setName("jail")
      .setDescription("Setup jail notifications (lobdells idea)")
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
    
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(client.user.id, GUILD_ID)
      : Routes.applicationCommands(client.user.id);
    
    await rest.put(route, { body: commands });
    console.log(`Slash commands registered ${GUILD_ID ? 'to guild' : 'globally'}.`);
  } catch (err) {
    console.error("Error registering commands:", err);
  }

  console.log(`Starting jail monitoring (polling every ${POLL_INTERVAL / 1000}s)...`);
  checkFactionJail();
  setInterval(checkFactionJail, POLL_INTERVAL);
}).catch(err => {
  console.error("Failed to login:", err);
  process.exit(1);
});