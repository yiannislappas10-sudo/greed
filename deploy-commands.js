require("dotenv").config();

const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType
} = require("discord.js");

const command = new SlashCommandBuilder()
  .setName("buckshot")
  .setDescription("Play a 2-player Buckshot-style Discord game.")
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
      .setName("cancel")
      .setDescription("Cancel one of your pending Buckshot challenges.")
      .addUserOption(option =>
        option
          .setName("player")
          .setDescription("The challenged player. Leave blank to cancel all your pending challenges.")
          .setRequired(false)
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
      .setDescription("Open the Buckshot game guide.")
  )
  .addSubcommand(sub =>
    sub
      .setName("stats")
      .setDescription("View Buckshot statistics.")
      .addUserOption(option =>
        option
          .setName("player")
          .setDescription("Player to view. Defaults to yourself.")
          .setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName("leaderboard")
      .setDescription("View the Buckshot leaderboard.")
  )
  .addSubcommand(sub => {
    sub
      .setName("restrict")
      .setDescription("Restrict new Buckshot challenges to one channel.")
      .addChannelOption(option =>
        option
          .setName("channel")
          .setDescription("The channel where challenge requests are allowed.")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      );
    return sub.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  })
  .addSubcommand(sub =>
    sub
      .setName("unrestrict")
      .setDescription("Remove the Buckshot challenge channel restriction.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  )
  .addSubcommand(sub =>
    sub
      .setName("active")
      .setDescription("Show active Buckshot games on this server.")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  )
  .addSubcommand(sub => {
    sub
      .setName("forceend")
      .setDescription("Force-end the Buckshot game in a ticket/channel.")
      .addChannelOption(option =>
        option
          .setName("channel")
          .setDescription("The ticket channel. Defaults to this channel.")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false)
      );
    return sub.setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);
  })
  .addSubcommand(sub =>
    sub
      .setName("reset")
      .setDescription("Reset a player's Buckshot statistics.")
      .addUserOption(option =>
        option
          .setName("player")
          .setDescription("The player whose statistics should be reset.")
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
