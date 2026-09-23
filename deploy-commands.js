require("dotenv").config();

const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");

const command = new SlashCommandBuilder()
  .setName("buckshot")
  .setDescription("Play a 2-player Buckshot-style game.")
  .addSubcommand(sub =>
    sub
      .setName("challenge")
      .setDescription("Challenge another player to a game.")
      .addUserOption(option =>
        option
          .setName("player")
          .setDescription("The player you want to challenge.")
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName("rules")
      .setDescription("Show the game rules.")
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
