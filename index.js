import fs from "fs";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder } from "discord.js";

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const TORN_API_KEY = process.env.TORN_API_KEY;
const FACTION_ID = process.env.FACTION_ID;
const POLL_INTERVAL = (parseInt(process.env.POLL_INTERVAL || "60") || 60) * 1000;
const CONFIG_FILE = "./config.json";
const STATE_FILE = "./jailstate.json";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// Load or initialize config
let config = {};
if (fs.existsSync(CONFIG_FILE)) {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

// Load or initialize jail state
let jailState = {};
if (fs.existsSync(STATE_FILE)) {
  jailState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(jailState, null, 2));
}

// Register slash commands
const commands = [
  new SlashCommandBuilder()
    .setName("jail")
    .setDescription("Setup jail notifications (lobdells idea)")
    .addChannelOption(opt => opt.setName("channel").setDescription("Channel for jail alerts").setRequired(true))
    .addRoleOption(opt => opt.setName("role").setDescription("Role to mention on jail alerts").setRequired(true))
    .toJSON()
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(
      Routes.applicationCommands(client.user?.id || "bot_id_placeholder"),
      { body: commands }
    );
    console.log("Slash commands registered.");
  } catch (err) {
    console.error(err);
  }
})();

// Helper to build profile link
function playerProfileLink(id) {
  return `https://www.torn.com/profiles.php?XID=${id}`;
}

// Normalize members from Torn API
function normalizeMembers(apiData) {
  const members = [];
  if (!apiData || !apiData.members) return members;
  if (Array.isArray(apiData.members)) return apiData.members;
  for (const key of Object.keys(apiData.members)) {
    const m = apiData.members[key];
    members.push({ player_id: m.player_id || Number(key), name: m.name || m.player_name || "Unknown", jail_time: m.jail_time || 0 });
  }
  return members;
}

// Poll Torn API for jailed members
async function checkFactionJail() {
  if (!config.channelId || !config.roleId) return; // not configured
  try {
    const res = await fetch(`https://api.torn.com/faction/${FACTION_ID}?selections=members&key=${TORN_API_KEY}`);
    const data = await res.json();
    const members = normalizeMembers(data);
    const channel = await client.channels.fetch(config.channelId);
    if (!channel || !channel.isTextBased()) return;

    for (const m of members) {
      const id = String(m.player_id);
      const jailTime = Number(m.jail_time || 0);
      const prev = Number(jailState[id] || 0);

      if (jailTime > 0 && prev === 0) {
        const minutes = Math.ceil(jailTime / 60);
        const embed = new EmbedBuilder()
          .setTitle("🚨 Faction Member Jailed")
          .setDescription(`${m.name} has just been jailed!`)
          .addFields(
            { name: "Time left", value: `${minutes} minute(s)`, inline: true },
            { name: "Profile", value: `[Open profile](${playerProfileLink(id)})`, inline: true }
          )
          .setColor(0xff4500)
          .setTimestamp();

        await channel.send({ content: `<@&${config.roleId}> • ${m.name} went to jail!`, embeds: [embed] });
      }

      jailState[id] = jailTime;
    }
    saveState();
  } catch (err) {
    console.error("Error checking jail:", err);
  }
}

// Handle slash commands
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "jail") {
    const channel = interaction.options.getChannel("channel");
    const role = interaction.options.getRole("role");

    config.channelId = channel.id;
    config.roleId = role.id;
    saveConfig();

    await interaction.reply(`✅ Jail alerts configured! Channel: ${channel.name}, Role: ${role.name}`);
  }
});

// Ready
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  checkFactionJail();
  setInterval(checkFactionJail, POLL_INTERVAL);
});

client.login(DISCORD_TOKEN);