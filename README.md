# BUCKSHOT Discord Bot v2 — Railway Ready

A 2-player Buckshot-style Discord game using **Discord Components V2**, private ticket channels, selectable difficulty, rounds, hearts, items, rematches, inactivity forfeits, admin recovery commands, statistics, leaderboard and PostgreSQL persistence.

## Player flow

```text
/buckshot challenge @player difficulty:Hard
        ↓
Both players are pinged
        ↓
Black Components V2 challenge panel
        ↓
Accept / Decline / Cancel Request
        ↓
Accept
        ↓
Private Buckshot Tickets channel
        ↓
Game starts immediately
        ↓
Buttons for shooting + every item
        ↓
Round progression + heart scaling
        ↓
Winner announcement
        ↓
Rematch or Close Ticket
```

## Commands

### Player commands

```text
/buckshot challenge @player difficulty:<easy|normal|hard|extreme>
/buckshot cancel [player]
/buckshot guide
/buckshot rules
/buckshot stats [player]
/buckshot leaderboard
```

### Staff commands

These are restricted by Discord permission checks:

```text
/buckshot restrict #channel
/buckshot unrestrict
/buckshot active
/buckshot forceend [channel]
/buckshot reset @player
```

`restrict` and `unrestrict` require **Manage Server**. `active` and `reset` require **Manage Server**. `forceend` requires **Manage Channels**.

## Difficulties

| Difficulty | Rounds | Chamber Size | Live Shell Pressure | Item Pool |
|---|---:|---:|---|---|
| Easy | 2 | 5–6 | Low | Basic |
| Normal | 4 | 6–8 | Medium | Expanded |
| Hard | 6 | 7–9 | High | Advanced |
| Extreme | 8 | 8–10 | Highest | Full |

Every match starts at **4 hearts** per player. At the start of each normal round after Round 1, maximum hearts decrease by 1, never below 2. Current health carries over.

If the final round ends in an exact health tie, the bot starts Sudden Death with both players at 1 heart and a short chamber.

## Items

- Magnifier — privately reveals the current shell. Does not remove it and does not pass the turn.
- Beer — reveals the current shell to you and ejects it. Passes the turn.
- Cigarettes — heals 1 heart up to your current maximum. Passes the turn.
- Hand Saw — arms the next LIVE shot for 2 damage. Passes the turn when armed.
- Handcuffs — makes the opponent lose their next turn.
- Burner Phone — privately reveals a random future shell. Passes the turn.
- Inverter — flips the current shell LIVE/BLANK. Passes the turn.
- Adrenaline — steals one random opponent item. Passes the turn.

## Production features

### PostgreSQL persistence

When `DATABASE_URL` is configured, the bot persists:

- Guild challenge-channel restriction
- Pending challenges
- Active and finished ticket games
- Turn timestamps
- Shell order and player state
- Player statistics
- Wins / losses / rounds won / damage / item usage

If PostgreSQL is unavailable or `DATABASE_URL` is blank, the bot falls back to temporary in-memory storage for local testing.

### Restart recovery

On startup the bot reloads stored challenges and games. Active games are restored, active players are protected from opening another match, and turn timers resume using the stored last-action timestamp.

### Inactivity protection

Default turn timeout: **120 seconds**. A Discord relative-time countdown appears in the main game panel. A player who completely fails to act before the timeout loses by forfeit. Change it with:

```env
TURN_TIMEOUT_SECONDS=120
```

### Rematches

After a match, either player can press **Rematch**. A Components V2 difficulty selector appears with Easy / Normal / Hard / Extreme. The selected difficulty restarts the same two players inside the current private ticket.

### Stats

After games, the bot records:

- Games
- Wins
- Losses
- Win rate
- Round wins
- Damage dealt
- Items used

Use `/buckshot stats` or `/buckshot leaderboard`.

## Install locally

Node.js 22.12+ is recommended.

```bash
npm install
cp .env.example .env
```

Fill in:

```env
BOT_TOKEN=...
CLIENT_ID=...
GUILD_ID=...
DATABASE_URL=...
DATABASE_SSL=false
TICKET_CATEGORY_ID=
TURN_TIMEOUT_SECONDS=120
```

Register commands:

```bash
npm run deploy
```

Start:

```bash
npm start
```

## Discord permissions

The bot should have:

- View Channels
- Send Messages
- Read Message History
- Manage Channels
- Manage Messages

The bot should be invited with the `bot` and `applications.commands` scopes.

## Railway deployment

1. Create a Railway project.
2. Add this bot repository as the application service.
3. Add a PostgreSQL service to the same Railway project.
4. Add the environment variables above in the bot service.
5. Set `DATABASE_URL` to the PostgreSQL connection variable provided by Railway.
6. Use the start command:

```text
npm start
```

7. Deploy.

The database schema is created automatically on bot startup. You do not need to manually run the SQL schema.

Do **not** commit `.env` or paste your Discord bot token into GitHub.

## Important production note

Game and challenge state is persisted, but private Discord ticket channels are still Discord resources. If a server administrator manually deletes a ticket channel while a saved game exists, that saved game becomes unreachable until it is cleaned up with admin tooling or a future automatic cleanup job.
