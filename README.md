# Buckshot Discord Bot — Components V2

This is a 2-player Buckshot-style Discord bot built around Discord Components V2.

## What it does

1. `/buckshot challenge @player`
2. The bot pings both players and shows a black Components V2 challenge panel.
3. The challenged player clicks **Accept** or **Decline**.
4. Accepting creates a private **Buckshot Tickets** channel.
5. Only the two players and the bot can see the ticket.
6. The game starts immediately inside the ticket.
7. Shooting and every item are clickable buttons inside the V2 container.
8. The ticket has a **Close Ticket** button.

## Components V2 note

Discord Components V2 uses `MessageFlags.IsComponentsV2`. Traditional `content` and `embeds` cannot be used on a V2 message, so the visible panels are built from `ContainerBuilder` + `TextDisplayBuilder` + `ActionRowBuilder` instead.

## Install

Use Node.js 22.12+.

```bash
npm install
```

Copy `.env.example` to `.env` and fill in:

```env
BOT_TOKEN=...
CLIENT_ID=...
GUILD_ID=...
TICKET_CATEGORY_ID=...
```

`TICKET_CATEGORY_ID` is optional. When it is blank, the bot automatically creates a `Buckshot Tickets` category.

## Register the command

```bash
npm run deploy
```

## Start

```bash
npm start
```

## Required Discord permissions

The bot needs permission to:

- View Channels
- Send Messages
- Read Message History
- Manage Channels
- Manage Messages

The bot should also be invited with the `applications.commands` scope.

## Current items

- Magnifier — privately reveals the current shell.
- Beer — ejects the current shell.
- Cigarettes — restores 1 HP.
- Hand Saw — next live shot deals 2 damage.
- Handcuffs — skips the opponent's next turn.
- Burner Phone — privately reveals a future shell.
- Inverter — flips the current shell.
- Adrenaline — steals a random item from the opponent.

## Important

The game state is stored in memory. If the bot restarts, active games are lost. For a production server, move `challenges` and `games` into a database or Redis.
