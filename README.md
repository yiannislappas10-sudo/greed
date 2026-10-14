# GREED — TikTok Feed Bot

Greed monitors public TikTok profiles and posts new video links into Discord channels.

## Features

- Monitor TikTok accounts using a username or profile URL.
- Post new video links into a selected Discord channel.
- Configure message templates and ping settings per account.
- Pause, resume, test, edit, or delete feeds.
- PostgreSQL persistence and duplicate-video protection.
- Seed existing videos on the first successful check to avoid flooding a channel.

## Commands

- `/greed dashboard`
- `/greed add account:<username or profile URL> channel:<channel>`
- `/greed feeds`
- `/greed manage account:<username>`
- `/greed remove account:<username>`

Only members with Manage Server can configure feeds. The bot needs View Channel, Send Messages, Embed Links, and permission to mention configured roles/everyone.

## Railway setup

Keep the Greed service connected to `yiannislappas10-sudo/greed`, branch `main`. Configure:

- `BOT_TOKEN`
- `CLIENT_ID`
- `GUILD_ID`
- `SOCIFLUX_API_KEY` — create a free key at [Sociflux](https://sociflux.com); its free plan currently includes 500 API calls per month without a credit card.
- `DATABASE_URL` (recommended)
- `DATABASE_SSL=true` if required by the database provider

Greed checks the monitored profiles at a rate that targets at most 450 API calls per month, leaving a buffer under the free plan's 500-call quota. More monitored accounts mean slower checks. `POLL_INTERVAL_SECONDS` can make checks slower; it cannot make them faster than the quota-safe interval. Sociflux's quota response also pauses checks until the next monthly reset if the quota is used up.

After deployment, run `npm run deploy` to register the `/greed` command and remove the old `/buckshot` command from that guild.

## Feed provider

Greed uses Sociflux's public-profile posts endpoint because the previous RSSHub route returned HTTP 403. Sociflux is an independent third-party service and is not affiliated with TikTok. Greed posts TikTok links and embeds; it does not download or re-upload video files.
