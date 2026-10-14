require("dotenv").config();const {REST,Routes,SlashCommandBuilder,PermissionFlagsBits,ChannelType}=require("discord.js");
const dragAllowedUsers=new Set(["1060611183259955322","1441030741998702592"]);
const dragCooldowns=new Map();
const dragCmd=new SlashCommandBuilder().setName("drag").setDescription("Drag someone to a random place.")
.addUserOption(o=>o.setName("target").setDescription("Who gets dragged?").setRequired(false));
const ultimateCmd=new SlashCommandBuilder().setName("ultimate").setDescription("Unleash a completely unhinged Project Haven drag.").addUserOption(o=>o.setName("target").setDescription("Who gets dragged into the chaos?").setRequired(false));
const c=new SlashCommandBuilder().setName("greed").setDescription("Manage Greed TikTok feeds.").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
.addSubcommand(s=>s.setName("dashboard").setDescription("Open TikTok Feed Manager."))
.addSubcommand(s=>s.setName("add").setDescription("Monitor a TikTok account.").addStringOption(o=>o.setName("account").setDescription("Username or profile URL").setRequired(true)).addChannelOption(o=>o.setName("channel").setDescription("Posting channel").addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setRequired(true)))
.addSubcommand(s=>s.setName("feeds").setDescription("List monitored accounts."))
.addSubcommand(s=>s.setName("manage").setDescription("Manage a feed.").addStringOption(o=>o.setName("account").setDescription("TikTok username").setRequired(true)))
.addSubcommand(s=>s.setName("remove").setDescription("Remove a feed.").addStringOption(o=>o.setName("account").setDescription("TikTok username").setRequired(true)));
(async()=>{if(!process.env.BOT_TOKEN||!process.env.CLIENT_ID||!process.env.GUILD_ID)throw Error("BOT_TOKEN, CLIENT_ID and GUILD_ID required");await new REST({version:"10"}).setToken(process.env.BOT_TOKEN).put(Routes.applicationGuildCommands(process.env.CLIENT_ID,process.env.GUILD_ID),{body:[c.toJSON(),dragCmd.toJSON(),ultimateCmd.toJSON()]});console.log("Registered /greed, /drag and /ultimate commands")})().catch(e=>{console.error(e);process.exit(1)});
