require("dotenv").config();

const {
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const command = new SlashCommandBuilder()
  .setName("buckshot")
  .setDescription("Play a 2-player Buckshot-style game.")
  .addSubcommand(sub =>
    sub
      .setName("challenge")
      .setDescription("Challenge another player to a Buckshot match.")
      .addUserOption(option =>
        option
          .setName("player")
          .setDescription("The player you want to challenge.")
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName("difficulty")
          .setDescription("Choose the match difficulty.")
          .setRequired(true)
          .addChoices(
            { name: "Easy — 2 rounds", value: "easy" },
            { name: "Normal — 4 rounds", value: "normal" },
            { name: "Hard — 6 rounds", value: "hard" },
            { name: "Extreme — 8 rounds", value: "extreme" }
          )
      )
  )
  .addSubcommand(sub =>
    sub
      .setName("guide")
      .setDescription("Open the full Buckshot game guide.")
  )
  .addSubcommand(sub =>
    sub
      .setName("rules")
      .setDescription("Open the Buckshot game guide (legacy command).")
  );

async function main() {
  if (!process.env.BOT_TOKEN || !process.env.CLIENT_ID || !process.env.GUILD_ID) {
    throw new Error("BOT_TOKEN, CLIENT_ID and GUILD_ID are required in .env");
  }

  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: [command.toJSON()] }
  );

  console.log("Registered /buckshot commands.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
