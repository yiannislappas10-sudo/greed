# Buckshot Discord Bot — Components V2

A 2-player Buckshot-style Discord bot using black Discord Components V2 panels and private ticket channels.

## Challenge flow

1. Run:
   `/buckshot challenge @player difficulty:<difficulty>`
2. The bot posts a black Components V2 challenge card and pings both players.
3. The request clearly shows:
   - Challenger
   - Opponent
   - Difficulty
   - Number of rounds
   - Starting hearts
   - `Winner: Not decided`
4. The challenged player can press **Accept** or **Decline**.
5. The challenger can press **Cancel Request** before the request is accepted.
6. Challenges expire after 2 minutes.
7. Accepting creates a private `Buckshot Tickets` channel containing only the two players and the bot.

## Difficulties

- Easy — 2 rounds
- Normal — 4 rounds
- Hard — 6 rounds
- Extreme — 8 rounds

Every match starts at 4 hearts per player. At the start of each new scheduled round, each player's maximum hearts drops by 1, but never below 2. Current health is not restored between rounds.

If both players survive the final scheduled round, the player with more hearts wins. An exact health tie starts Sudden Death at 1 heart each.

## Game controls

The main game panel is a Components V2 Container with buttons for:

- Shoot Opponent
- Shoot Self
- Every item currently owned by the player whose turn it is
- Close Ticket

The panel shows the difficulty, current round, both players' hearts, remaining shells, and the current turn.

## Items

- Magnifier — privately reveals the current shell.
- Beer — reveals and ejects the current shell, then passes the turn.
- Cigarettes — restores 1 heart up to the current maximum, then passes the turn.
- Hand Saw — makes the next LIVE shot deal 2 damage, then passes the turn after arming it.
- Handcuffs — makes the opponent lose their next turn.
- Burner Phone — privately reveals a future shell, then passes the turn.
- Inverter — flips the current shell, then passes the turn.
- Adrenaline — steals a random item from the opponent, then passes the turn.

## Guide

`/buckshot guide` posts a detailed 4-part game guide. `/buckshot rules` opens the same guide for compatibility with the old command.

## Install

Use Node.js 22.12+.

```bash
npm install
```

Copy `.env.example` to `.env`:

```env
BOT_TOKEN=YOUR_BOT_TOKEN
CLIENT_ID=YOUR_APPLICATION_ID
GUILD_ID=YOUR_SERVER_ID
TICKET_CATEGORY_ID=
```

Run:

```bash
npm run deploy
npm start
```

## Required Discord permissions

The bot needs:

- View Channels
- Send Messages
- Read Message History
- Manage Channels
- Manage Messages

Invite the bot with the `applications.commands` scope.

## Components V2 note

Components V2 messages need the `MessageFlags.IsComponentsV2` flag. A V2 message cannot use traditional `content`, embeds, stickers, or polls. A Container can hold up to 10 child components, so the detailed guide is split into four separate black Containers rather than overloading one panel.

## Production note

Challenges and active games are stored in memory. Restarting the bot clears active requests and games. A production deployment should move game state to a persistent database or Redis.
