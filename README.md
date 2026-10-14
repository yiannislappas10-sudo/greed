# GREED — TikTok Feed Bot

Greed has been replaced from Buckshot with a TikTok auto-post feed manager.

## Features
- Monitor TikTok accounts and post new video links into chosen Discord channels.
- Independent message template and ping settings per account.
- Ping modes: none, @here, @everyone, or a selected role.
- Edit text, change channel, test post, pause/resume, delete feeds.
- PostgreSQL persistence and duplicate-video protection.
- First successful check seeds existing videos to avoid flooding the channel.

## Commands
- /greed dashboard
- /greed add account:<username or profile URL> channel:<channel>
- /greed feeds
- /greed manage account:<username>
- /greed remove account:<username>

Only members with Manage Server can configure feeds. The bot needs View Channel, Send Messages, Embed Links, and permission to mention configured roles/everyone.

## Railway
Keep the existing Greed service connected to yiannislappas10-sudo/greed, branch main. Configure BOT_TOKEN, CLIENT_ID, GUILD_ID, DATABASE_URL (recommended), and optionally DATABASE_SSL=true. POLL_INTERVAL_SECONDS defaults to 300.

After deployment run npm run deploy to register the new /greed command. The old /buckshot command is removed by this guild command refresh.

## Feed source limitation
The adapter uses RSSHub's public TikTok user feed route: https://rsshub.app/tiktok/user/@username. TikTok/RSSHub may rate-limit or change access; check Railway logs if an account cannot be fetched. Greed posts links and embeds; it does not download and re-upload video files.
