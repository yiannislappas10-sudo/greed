require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const { Pool } = require("pg");
const { envyConfigured, lockBuckshotWager, settleBuckshotWager, refundBuckshotWager } = require("./envy-api");

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const challenges = new Map();
const games = new Map();
const activeUsers = new Map();
const turnTimers = new Map();
const rematchRequests = new Map();
const memoryStats = new Map();
const memoryRestrictions = new Map();

const BLACK = 0x000000;
const STARTING_HP = 4;
const MIN_ROUND_HP = 2;
const CHALLENGE_TIMEOUT_MS = 120_000;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const REMATCH_TIMEOUT_MS = 90_000;
const DB_ENABLED = Boolean(process.env.DATABASE_URL);

const TURN_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.TURN_TIMEOUT_SECONDS || 120) * 1000
);

let dbReady = false;

const pool = DB_ENABLED
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      ssl:
        process.env.DATABASE_SSL === "true"
          ? { rejectUnauthorized: false }
          : undefined
    })
  : null;

if (pool) pool.on("error", error => console.error("PostgreSQL pool error:", error));

const DIFFICULTIES = {
  easy: {
    label: "Easy",
    rounds: 2,
    shellMin: 5,
    shellMax: 6,
    liveMin: 1,
    itemMin: 1,
    itemMax: 3,
    itemPool: ["magnifier", "beer", "cigarettes", "saw"]
  },
  normal: {
    label: "Normal",
    rounds: 4,
    shellMin: 6,
    shellMax: 8,
    liveMin: 2,
    itemMin: 2,
    itemMax: 4,
    itemPool: ["magnifier", "beer", "cigarettes", "saw", "handcuffs", "phone"]
  },
  hard: {
    label: "Hard",
    rounds: 6,
    shellMin: 7,
    shellMax: 9,
    liveMin: 3,
    itemMin: 2,
    itemMax: 5,
    itemPool: ["magnifier", "beer", "cigarettes", "saw", "handcuffs", "phone", "inverter", "adrenaline"]
  },
  extreme: {
    label: "Extreme",
    rounds: 8,
    shellMin: 8,
    shellMax: 10,
    liveMin: 4,
    itemMin: 3,
    itemMax: 5,
    itemPool: ["magnifier", "beer", "cigarettes", "saw", "handcuffs", "phone", "inverter", "adrenaline"]
  }
};

const ITEM_INFO = {
  magnifier: { label: "Magnifier", symbol: "⌕" },
  beer: { label: "Beer", symbol: "−" },
  cigarettes: { label: "Cigarettes", symbol: "＋" },
  saw: { label: "Hand Saw", symbol: "⌁" },
  handcuffs: { label: "Handcuffs", symbol: "∥" },
  phone: { label: "Burner Phone", symbol: "⌂" },
  inverter: { label: "Inverter", symbol: "↕" },
  adrenaline: { label: "Adrenaline", symbol: "◇" }
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function randomId(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function difficultyFor(game) {
  return DIFFICULTIES[game.difficulty] || DIFFICULTIES.normal;
}

function userName(game, userId) {
  return (
    game.players[userId]?.name ||
    game.players[userId]?.displayName ||
    game.players[userId]?.username ||
    "Player"
  );
}

function heartDisplay(player) {
  const current = Math.max(0, Math.min(player.hp, player.maxHp));
  const full = Array.from({ length: current }, () => "♥").join(" ");
  const empty = Array.from({ length: Math.max(0, player.maxHp - current) }, () => "♡").join(" ");
  return `${[full, empty].filter(Boolean).join(" ")}  ${current}/${player.maxHp}`;
}

function plural(value, singular, pluralForm = `${singular}s`) {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

function shellLabel(shell) {
  return shell === "live" ? "LIVE" : "BLANK";
}

function oppositePlayerId(game, userId) {
  return userId === game.challengerId ? game.targetId : game.challengerId;
}

function actionButton(customId, label, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}

function publicMentions(userIds) {
  return { users: [...new Set(userIds)] };
}

function isChallengeChannelAllowed(guildId, channelId) {
  const restricted = memoryRestrictions.get(guildId);
  return !restricted || restricted === channelId;
}

function getChallengeRestrictionText(guildId) {
  const channelId = memoryRestrictions.get(guildId);
  return channelId ? `<#${channelId}>` : "any channel";
}

async function turnTimeoutMsFor(game) {
  const settings = await getBuckshotSettings(game.guildId);
  return Math.max(30_000, settings.turn_timeout_seconds * 1000);
}

async function dbQuery(text, params = []) {
  if (!pool || !dbReady) return null;
  return pool.query(text, params);
}

async function initDatabase() {
  if (!pool) {
    console.log("DATABASE_URL not set. Running in temporary in-memory mode.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS buckshot_guild_settings (
      guild_id TEXT PRIMARY KEY,
      challenge_channel_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      wager_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      min_wager BIGINT NOT NULL DEFAULT 1,
      max_wager BIGINT NOT NULL DEFAULT 1000000,
      turn_timeout_seconds INTEGER NOT NULL DEFAULT 120
    );

    CREATE TABLE IF NOT EXISTS buckshot_challenges (
      challenge_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      challenger_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      wager BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS buckshot_games (
      game_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      challenger_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      wager BIGINT NOT NULL DEFAULT 0,
      wager_id TEXT,
      wager_status TEXT NOT NULL DEFAULT 'none',
      round INTEGER NOT NULL,
      turn_id TEXT,
      shells JSONB NOT NULL,
      players JSONB NOT NULL,
      skipped_turn JSONB NOT NULL,
      finished BOOLEAN NOT NULL DEFAULT FALSE,
      winner_id TEXT,
      sudden_death BOOLEAN NOT NULL DEFAULT FALSE,
      round_started_at BIGINT NOT NULL,
      last_action_at BIGINT NOT NULL,
      end_reason TEXT,
      stats_recorded BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS buckshot_player_stats (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      games INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      rounds_won INTEGER NOT NULL DEFAULT 0,
      damage_dealt INTEGER NOT NULL DEFAULT 0,
      items_used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
  `);
  await pool.query(`
    ALTER TABLE buckshot_guild_settings ADD COLUMN IF NOT EXISTS wager_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE buckshot_guild_settings ADD COLUMN IF NOT EXISTS min_wager BIGINT NOT NULL DEFAULT 1;
    ALTER TABLE buckshot_guild_settings ADD COLUMN IF NOT EXISTS max_wager BIGINT NOT NULL DEFAULT 1000000;
    ALTER TABLE buckshot_guild_settings ADD COLUMN IF NOT EXISTS turn_timeout_seconds INTEGER NOT NULL DEFAULT 120;
    ALTER TABLE buckshot_challenges ADD COLUMN IF NOT EXISTS wager BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE buckshot_games ADD COLUMN IF NOT EXISTS wager BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE buckshot_games ADD COLUMN IF NOT EXISTS wager_id TEXT;
    ALTER TABLE buckshot_games ADD COLUMN IF NOT EXISTS wager_status TEXT NOT NULL DEFAULT 'none';
  `);
  dbReady = true;
}

async function saveRestriction(guildId, channelId) {
  if (!channelId) {
    memoryRestrictions.delete(guildId);
  } else {
    memoryRestrictions.set(guildId, channelId);
  }

  if (dbReady) {
    await dbQuery(
      `INSERT INTO buckshot_guild_settings (guild_id, challenge_channel_id)
       VALUES ($1, $2)
       ON CONFLICT (guild_id) DO UPDATE SET challenge_channel_id = EXCLUDED.challenge_channel_id, updated_at = NOW()`,
      [guildId, channelId]
    );
  }
}

async function loadRestrictions() {
  if (!dbReady) return;
  const result = await dbQuery(`SELECT guild_id, challenge_channel_id FROM buckshot_guild_settings`);
  for (const row of result.rows) {
    if (row.challenge_channel_id) memoryRestrictions.set(row.guild_id, row.challenge_channel_id);
  }
}

async function getBuckshotSettings(guildId) {
  const defaults = {
    guild_id: guildId,
    challenge_channel_id: null,
    wager_enabled: true,
    min_wager: 1,
    max_wager: 1000000,
    turn_timeout_seconds: 120
  };
  if (!dbReady) return defaults;

  const result = await dbQuery(
    "SELECT * FROM buckshot_guild_settings WHERE guild_id = $1",
    [guildId]
  );
  if (!result.rows[0]) {
    await dbQuery(
      "INSERT INTO buckshot_guild_settings (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [guildId]
    );
    return defaults;
  }
  const row = result.rows[0];
  return {
    guild_id: row.guild_id,
    challenge_channel_id: row.challenge_channel_id,
    wager_enabled: row.wager_enabled,
    min_wager: Number(row.min_wager),
    max_wager: Number(row.max_wager),
    turn_timeout_seconds: Number(row.turn_timeout_seconds)
  };
}

async function updateBuckshotSettings(guildId, fields) {
  if (!dbReady) return;
  const allowed = new Set([
    "challenge_channel_id",
    "wager_enabled",
    "min_wager",
    "max_wager",
    "turn_timeout_seconds"
  ]);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (!entries.length) return;
  const columns = entries.map(([key], i) => `${key} = ${i + 2}`).join(", ");
  const values = [guildId, ...entries.map(([, value]) => value)];
  await dbQuery(
    `UPDATE buckshot_guild_settings SET ${columns}, updated_at = NOW() WHERE guild_id = $1`,
    values
  );
}

function serializeGame(game) {
  const players = {};
  for (const [userId, player] of Object.entries(game.players)) {
    players[userId] = { ...player };
  }

  return {
    ...game,
    players,
    skippedTurn: [...game.skippedTurn]
  };
}

function hydrateGame(row) {
  const rawPlayers = typeof row.players === "string" ? JSON.parse(row.players) : row.players;
  const rawSkipped = typeof row.skipped_turn === "string" ? JSON.parse(row.skipped_turn) : row.skipped_turn;
  const rawShells = typeof row.shells === "string" ? JSON.parse(row.shells) : row.shells;

  return {
    id: row.game_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    challengerId: row.challenger_id,
    targetId: row.target_id,
    difficulty: row.difficulty,
    wager: Number(row.wager || 0),
    wagerId: row.wager_id || null,
    wagerStatus: row.wager_status || 'none',
    turnTimeoutMs: null,
    round: row.round,
    turnId: row.turn_id,
    shells: rawShells || [],
    players: rawPlayers || {},
    skippedTurn: new Set(rawSkipped || []),
    finished: row.finished,
    winnerId: row.winner_id,
    suddenDeath: row.sudden_death,
    roundStartedAt: Number(row.round_started_at),
    lastActionAt: Number(row.last_action_at),
    endReason: row.end_reason || "",
    statsRecorded: row.stats_recorded,
    processing: false
  };
}

async function saveGame(game) {
  if (!dbReady) return;
  const data = serializeGame(game);
  await dbQuery(
    `INSERT INTO buckshot_games (
       game_id, guild_id, channel_id, message_id, challenger_id, target_id,
       difficulty, wager, wager_id, wager_status, round, turn_id, shells, players, skipped_turn, finished,
       winner_id, sudden_death, round_started_at, last_action_at, end_reason,
       stats_recorded, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,NOW())
     ON CONFLICT (game_id) DO UPDATE SET
       guild_id=EXCLUDED.guild_id,
       channel_id=EXCLUDED.channel_id,
       message_id=EXCLUDED.message_id,
       challenger_id=EXCLUDED.challenger_id,
       target_id=EXCLUDED.target_id,
       difficulty=EXCLUDED.difficulty,
       wager=EXCLUDED.wager,
       wager_id=EXCLUDED.wager_id,
       wager_status=EXCLUDED.wager_status,
       round=EXCLUDED.round,
       turn_id=EXCLUDED.turn_id,
       shells=EXCLUDED.shells,
       players=EXCLUDED.players,
       skipped_turn=EXCLUDED.skipped_turn,
       finished=EXCLUDED.finished,
       winner_id=EXCLUDED.winner_id,
       sudden_death=EXCLUDED.sudden_death,
       round_started_at=EXCLUDED.round_started_at,
       last_action_at=EXCLUDED.last_action_at,
       end_reason=EXCLUDED.end_reason,
       stats_recorded=EXCLUDED.stats_recorded,
       updated_at=NOW()`,
    [
      game.id,
      game.guildId,
      game.channelId,
      game.messageId,
      game.challengerId,
      game.targetId,
      game.difficulty,
      game.wager || 0,
      game.wagerId || null,
      game.wagerStatus || 'none',
      game.round,
      game.turnId,
      JSON.stringify(data.shells),
      JSON.stringify(data.players),
      JSON.stringify(data.skippedTurn),
      data.finished,
      data.winnerId,
      data.suddenDeath,
      data.roundStartedAt,
      data.lastActionAt,
      data.endReason,
      data.statsRecorded
    ]
  );
}

async function deleteGame(gameId) {
  if (pool) await dbQuery(`DELETE FROM buckshot_games WHERE game_id = $1`, [gameId]);
}

async function saveChallenge(challenge) {
  if (!dbReady) return;
  await dbQuery(
    `INSERT INTO buckshot_challenges
       (challenge_id, guild_id, challenger_id, target_id, difficulty, channel_id, wager, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,TO_TIMESTAMP($8 / 1000.0))
     ON CONFLICT (challenge_id) DO UPDATE SET
       difficulty=EXCLUDED.difficulty,
       channel_id=EXCLUDED.channel_id,
       created_at=EXCLUDED.created_at`,
    [
      challenge.id,
      challenge.guildId,
      challenge.challengerId,
      challenge.targetId,
      challenge.difficulty,
      challenge.channelId,
      challenge.wager,
      challenge.createdAt
    ]
  );
}

async function deleteChallenge(challengeId) {
  if (pool) await dbQuery(`DELETE FROM buckshot_challenges WHERE challenge_id = $1`, [challengeId]);
}

function statsKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

async function getStats(guildId, userId) {
  if (pool) {
    const result = await dbQuery(
      `SELECT guild_id, user_id, display_name, games, wins, losses, rounds_won, damage_dealt, items_used
       FROM buckshot_player_stats WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );
    return result.rows[0] || {
      guild_id: guildId,
      user_id: userId,
      display_name: "Unknown Player",
      games: 0,
      wins: 0,
      losses: 0,
      rounds_won: 0,
      damage_dealt: 0,
      items_used: 0
    };
  }

  return memoryStats.get(statsKey(guildId, userId)) || {
    guild_id: guildId,
    user_id: userId,
    display_name: "Unknown Player",
    games: 0,
    wins: 0,
    losses: 0,
    rounds_won: 0,
    damage_dealt: 0,
    items_used: 0
  };
}

async function updateStats(guildId, userId, displayName, delta) {
  if (dbReady) {
    await dbQuery(
      `INSERT INTO buckshot_player_stats
         (guild_id, user_id, display_name, games, wins, losses, rounds_won, damage_dealt, items_used)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (guild_id,user_id) DO UPDATE SET
         display_name=EXCLUDED.display_name,
         games=buckshot_player_stats.games + EXCLUDED.games,
         wins=buckshot_player_stats.wins + EXCLUDED.wins,
         losses=buckshot_player_stats.losses + EXCLUDED.losses,
         rounds_won=buckshot_player_stats.rounds_won + EXCLUDED.rounds_won,
         damage_dealt=buckshot_player_stats.damage_dealt + EXCLUDED.damage_dealt,
         items_used=buckshot_player_stats.items_used + EXCLUDED.items_used`,
      [
        guildId,
        userId,
        displayName,
        delta.games || 0,
        delta.wins || 0,
        delta.losses || 0,
        delta.rounds_won || 0,
        delta.damage_dealt || 0,
        delta.items_used || 0
      ]
    );
    return;
  }

  const key = statsKey(guildId, userId);
  const current = memoryStats.get(key) || {
    guild_id: guildId,
    user_id: userId,
    display_name: displayName,
    games: 0,
    wins: 0,
    losses: 0,
    rounds_won: 0,
    damage_dealt: 0,
    items_used: 0
  };

  current.display_name = displayName;
  current.games += delta.games || 0;
  current.wins += delta.wins || 0;
  current.losses += delta.losses || 0;
  current.rounds_won += delta.rounds_won || 0;
  current.damage_dealt += delta.damage_dealt || 0;
  current.items_used += delta.items_used || 0;
  memoryStats.set(key, current);
}

async function resetStats(guildId, userId) {
  if (dbReady) {
    await dbQuery(`DELETE FROM buckshot_player_stats WHERE guild_id = $1 AND user_id = $2`, [guildId, userId]);
  } else {
    memoryStats.delete(statsKey(guildId, userId));
  }
}

async function getLeaderboard(guildId, limit = 10) {
  if (pool) {
    const result = await dbQuery(
      `SELECT display_name, user_id, games, wins, losses, rounds_won, damage_dealt, items_used,
              CASE WHEN games = 0 THEN 0 ELSE ROUND((wins::numeric / games::numeric) * 100, 1) END AS win_rate
       FROM buckshot_player_stats
       WHERE guild_id = $1 AND games > 0
       ORDER BY wins DESC, win_rate DESC, damage_dealt DESC, games DESC
       LIMIT $2`,
      [guildId, limit]
    );
    return result.rows;
  }

  return [...memoryStats.values()]
    .filter(stat => stat.guild_id === guildId && stat.games > 0)
    .map(stat => ({
      ...stat,
      win_rate: stat.games ? ((stat.wins / stat.games) * 100).toFixed(1) : "0.0"
    }))
    .sort((a, b) => b.wins - a.wins || Number(b.win_rate) - Number(a.win_rate) || b.damage_dealt - a.damage_dealt)
    .slice(0, limit);
}

async function restoreState() {
  await loadRestrictions();

  if (!dbReady) return;

  const now = Date.now();
  const challengeRows = await dbQuery(`
    SELECT challenge_id, guild_id, challenger_id, target_id, difficulty, channel_id, wager,
           EXTRACT(EPOCH FROM created_at) * 1000 AS created_ms
    FROM buckshot_challenges
    WHERE created_at > NOW() - INTERVAL '3 minutes'
  `);

  for (const row of challengeRows.rows) {
    const challenge = {
      id: row.challenge_id,
      guildId: row.guild_id,
      challengerId: row.challenger_id,
      targetId: row.target_id,
      difficulty: row.difficulty,
      channelId: row.channel_id,
      wager: Number(row.wager || 0),
      createdAt: Number(row.created_ms)
    };
    if (now - challenge.createdAt < CHALLENGE_TIMEOUT_MS) {
      challenges.set(challenge.id, challenge);
      scheduleChallengeExpiry(challenge);
    } else {
      await deleteChallenge(challenge.id);
    }
  }

  const gameRows = await dbQuery(`SELECT * FROM buckshot_games`);
  for (const row of gameRows.rows) {
    const game = hydrateGame(row);
    game.turnTimeoutMs = await turnTimeoutMsFor(game);
    games.set(game.id, game);
    if (!game.finished) {
      activeUsers.set(game.challengerId, game.id);
      activeUsers.set(game.targetId, game.id);
      scheduleTurnTimer(game);
    }
  }

  console.log(`Restored ${challenges.size} challenge(s) and ${games.size} game(s) from PostgreSQL.`);

  if (envyConfigured()) {
    for (const game of games.values()) {
      if (
        game.finished &&
        game.winnerId &&
        game.wager &&
        game.wagerId &&
        game.wagerStatus !== "settled"
      ) {
        try {
          await settleBuckshotWager(game.wagerId, game.winnerId);
          game.wagerStatus = "settled";
          await saveGame(game);
        } catch (error) {
          console.error("Pending Envy wager settlement still unavailable", game.wagerId, error);
        }
      }
    }
  }
}

function scheduleChallengeExpiry(challenge) {
  const remaining = Math.max(1, CHALLENGE_TIMEOUT_MS - (Date.now() - challenge.createdAt));
  setTimeout(() => expireChallenge(challenge.id).catch(console.error), remaining);
}

async function expireChallenge(challengeId) {
  const challenge = challenges.get(challengeId);
  if (!challenge) return;

  challenges.delete(challengeId);
  await deleteChallenge(challengeId);

  const channel = await client.channels.fetch(challenge.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const messages = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  const message = messages?.find(m =>
    m.author.id === client.user.id &&
    m.components?.some(row =>
      row.components?.some(component => component.customId === `challenge:accept:${challenge.id}`)
    )
  );

  if (message) {
    await message.edit({
      components: [buildChallengePanel(challenge, "expired")],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: publicMentions([challenge.challengerId, challenge.targetId])
    }).catch(() => {});
  }
}

function createRoundShells(game) {
  const difficulty = difficultyFor(game);
  const count = difficulty.shellMin + Math.floor(Math.random() * (difficulty.shellMax - difficulty.shellMin + 1));
  const maxLive = Math.max(difficulty.liveMin, Math.min(count - 2, Math.floor(count * 0.55)));
  const liveCount = Math.min(
    maxLive,
    difficulty.liveMin + Math.floor(Math.random() * (maxLive - difficulty.liveMin + 1))
  );
  const blankCount = count - liveCount;

  return shuffle([
    ...Array.from({ length: liveCount }, () => "live"),
    ...Array.from({ length: blankCount }, () => "blank")
  ]);
}

function giveRoundItems(game) {
  const difficulty = difficultyFor(game);

  for (const player of Object.values(game.players)) {
    const amount = difficulty.itemMin + Math.floor(Math.random() * (difficulty.itemMax - difficulty.itemMin + 1));

    for (let i = 0; i < amount; i++) {
      const item = difficulty.itemPool[Math.floor(Math.random() * difficulty.itemPool.length)];
      player.items.push(item);
    }
  }
}

function prepareRound(game) {
  if (game.round > 1 && !game.suddenDeath) {
    for (const player of Object.values(game.players)) {
      player.maxHp = Math.max(MIN_ROUND_HP, player.maxHp - 1);
      player.hp = Math.min(player.hp, player.maxHp);
      player.sawArmed = false;
    }
  }

  game.shells = createRoundShells(game);
  giveRoundItems(game);
  game.roundStartedAt = Date.now();
}

function prepareSuddenDeath(game) {
  game.suddenDeath = true;
  game.shells = shuffle(["live", "blank", "live"]);
  for (const player of Object.values(game.players)) {
    player.maxHp = 1;
    player.hp = 1;
    player.items = [];
    player.sawArmed = false;
  }
}

function formatItems(player) {
  if (!player.items.length) return "None";

  const counts = new Map();
  for (const item of player.items) counts.set(item, (counts.get(item) || 0) + 1);

  return [...counts.entries()]
    .map(([item, count]) => `${ITEM_INFO[item].symbol} ${ITEM_INFO[item].label}${count > 1 ? ` x${count}` : ""}`)
    .join("  ·  ");
}

function turnCountdown(game) {
  if (game.finished || !game.turnId || game.suddenDeath && !game.lastActionAt) return "";
  const timeoutMs = game.turnTimeoutMs || TURN_TIMEOUT_MS;
  const expires = Math.floor((game.lastActionAt + timeoutMs) / 1000);
  return `**Turn timer:** <t:${expires}:R>`;
}

function buildChallengePanel(challenge, state = "pending", ticketChannel = null) {
  const difficulty = DIFFICULTIES[challenge.difficulty] || DIFFICULTIES.normal;

  let heading = "# BUCKSHOT — CHALLENGE";
  let status = `<@${challenge.targetId}>, choose **Accept** or **Decline**. The challenger can cancel the request before it is accepted.`;

  if (state === "accepted") {
    heading = "# BUCKSHOT — ACCEPTED";
    status = `<@${challenge.targetId}> accepted the challenge. Private ticket: ${ticketChannel || "created"}`;
  } else if (state === "declined") {
    heading = "# BUCKSHOT — DECLINED";
    status = `<@${challenge.targetId}> declined the challenge from <@${challenge.challengerId}>.`;
  } else if (state === "cancelled") {
    heading = "# BUCKSHOT — CANCELLED";
    status = `<@${challenge.challengerId}> cancelled the challenge before it was accepted.`;
  } else if (state === "expired") {
    heading = "# BUCKSHOT — EXPIRED";
    status = "This challenge expired because no response was received within 2 minutes.";
  }

  const container = new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(heading),
      new TextDisplayBuilder().setContent(
        `**Challenger:** <@${challenge.challengerId}>\n` +
        `**Opponent:** <@${challenge.targetId}>\n` +
        `**Difficulty:** ${difficulty.label}\n` +
        `**Rounds:** ${difficulty.rounds}\n` +
        `**Starting hearts:** ${STARTING_HP} each\n` +
        `**Wager:** ${Number(challenge.wager || 0).toLocaleString()} per player\n` +
        `**Pot:** ${(Number(challenge.wager || 0) * 2).toLocaleString()}\n` +
        `**Winner:** Not decided`
      ),
      new TextDisplayBuilder().setContent(status)
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

  if (state === "pending") {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        actionButton(`challenge:accept:${challenge.id}`, "Accept"),
        actionButton(`challenge:decline:${challenge.id}`, "Decline"),
        actionButton(`challenge:cancel:${challenge.id}`, "Cancel Request", ButtonStyle.Danger)
      )
    );
  }

  return container;
}

function buildGamePanel(game) {
  const [p1, p2] = Object.values(game.players);
  const difficulty = difficultyFor(game);
  const roundLabel = game.suddenDeath
    ? `Round ${difficulty.rounds}/${difficulty.rounds} · SUDDEN DEATH`
    : `Round ${game.round}/${difficulty.rounds}`;

  let turnLine;
  if (game.finished) {
    turnLine = `### Winner: ${userName(game, game.winnerId)}`;
  } else {
    turnLine = `### Turn: ${userName(game, game.turnId)}`;
  }

  const chamberText = `${game.shells.length} ${game.shells.length === 1 ? "shell" : "shells"} remaining`;

  const container = new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# BUCKSHOT\n**${difficulty.label}**  ·  **${roundLabel}**`),
      new TextDisplayBuilder().setContent(
        `${turnLine}\n\n` +
        `**${userName(game, p1.id)}**\n${heartDisplay(p1)}\n\n` +
        `**${userName(game, p2.id)}**\n${heartDisplay(p2)}\n\n` +
        `**Chamber:** ${chamberText}\n` +
        `**Wager:** ${Number(game.wager || 0).toLocaleString()} per player\n` +
        `${game.finished ? `**Result:** ${game.endReason || "Match complete"}` : turnCountdown(game)}`
      ),
      new TextDisplayBuilder().setContent(
        game.finished
          ? `**Final health**\n${userName(game, p1.id)}: ${p1.hp}/${p1.maxHp} hearts\n${userName(game, p2.id)}: ${p2.hp}/${p2.maxHp} hearts`
          : `**${userName(game, game.turnId)}'s items**\n${formatItems(game.players[game.turnId])}`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

  const active = !game.finished;
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      actionButton(`game:shoot_enemy:${game.id}`, "Shoot Opponent", ButtonStyle.Secondary, !active),
      actionButton(`game:shoot_self:${game.id}`, "Shoot Self", ButtonStyle.Danger, !active)
    )
  );

  if (active) {
    const current = game.players[game.turnId];
    const counts = new Map();
    for (const item of current.items) counts.set(item, (counts.get(item) || 0) + 1);

    const visibleItems = [...counts.keys()].slice(0, 10);
    for (let i = 0; i < visibleItems.length; i += 5) {
      const row = new ActionRowBuilder();
      for (const item of visibleItems.slice(i, i + 5)) {
        row.addComponents(
          actionButton(
            `game:item:${item}:${game.id}`,
            `${ITEM_INFO[item].label}${counts.get(item) > 1 ? ` x${counts.get(item)}` : ""}`
          )
        );
      }
      container.addActionRowComponents(row);
    }
  }

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      actionButton(`game:rematch:${game.id}`, "Rematch", ButtonStyle.Secondary, !game.finished),
      actionButton(`game:close:${game.id}`, "Close Ticket")
    )
  );

  return container;
}

function buildRematchPanel(game) {
  return new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# BUCKSHOT — REMATCH"),
      new TextDisplayBuilder().setContent(
        `Rematch requested by **${userName(game, game.rematchInitiatorId)}**.\nChoose the difficulty for the next match. This will restart the game in the current private ticket.\n\n` +
        `**Current players:** ${userName(game, game.challengerId)} vs ${userName(game, game.targetId)}`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        actionButton(`rematch:choose:easy:${game.id}`, "Easy"),
        actionButton(`rematch:choose:normal:${game.id}`, "Normal"),
        actionButton(`rematch:choose:hard:${game.id}`, "Hard"),
        actionButton(`rematch:choose:extreme:${game.id}`, "Extreme"),
        actionButton(`rematch:cancel:${game.id}`, "Cancel", ButtonStyle.Danger)
      )
    );
}

function rulesButton(customId, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

function buildRulesPanel(section = "home") {
  const sections = {
    home: {
      title: "# BUCKSHOT — RULES",
      text:
        "Choose a section below to expand it. The rules are shown inside this Components V2 panel.\n\n" +
        "**Basics** — how a match starts and how the ticket works.\n" +
        "**Turns** — shooting, shells and turn order.\n" +
        "**Items** — every item and its effect.\n" +
        "**Winning** — rounds, sudden death and forfeits.\n" +
        "**Wagers** — how Buckshot connects to Envy and how the pot is paid.",
    },
    basics: {
      title: "# BUCKSHOT — BASICS",
      text:
        "**1. Two players only**\n" +
        "A player challenges another player. The opponent can accept or decline. You can cancel your own pending request before it is accepted.\n\n" +
        "**2. Private ticket**\n" +
        "Once accepted, Greed creates a private ticket for the two players and the bot. The match is controlled from the Components V2 game panel.\n\n" +
        "**3. Difficulty**\n" +
        "Easy has 2 rounds, Normal 4, Hard 6 and Extreme 8. Higher difficulties use larger chambers, tougher shell requirements and broader item pools.\n\n" +
        "**4. Challenge expiry**\n" +
        "A pending challenge expires after 2 minutes if nobody responds.",
    },
    turns: {
      title: "# BUCKSHOT — TURNS",
      text:
        "**1. Shells**\n" +
        "Each round secretly contains a random sequence of LIVE and BLANK shells. Players only see how many shells remain.\n\n" +
        "**2. Shooting**\n" +
        "Shoot the opponent to test the current shell. A LIVE shell normally removes 1 heart; a BLANK does no damage.\n\n" +
        "**3. Shooting yourself**\n" +
        "You can shoot yourself. If the shell is BLANK, the turn stays with you, otherwise the normal turn flow continues.\n\n" +
        "**4. Turn timer**\n" +
        "Every active turn has a default 120-second inactivity timer. When it expires, the opponent wins by forfeit.",
    },
    items: {
      title: "# BUCKSHOT — ITEMS",
      text:
        "**Magnifier** — privately reveals the current shell without removing it.\n" +
        "**Beer** — reveals and ejects the current shell, then passes the turn.\n" +
        "**Cigarettes** — restores 1 heart up to your current maximum, then passes the turn.\n" +
        "**Hand Saw** — arms the next shot; a LIVE shot deals 2 damage. Arming it passes the turn.\n" +
        "**Handcuffs** — makes the opponent lose their next turn.\n" +
        "**Burner Phone** — privately reveals a random future shell, then passes the turn.\n" +
        "**Inverter** — flips the current shell from LIVE to BLANK or BLANK to LIVE, then passes the turn.\n" +
        "**Adrenaline** — steals one random item from the opponent, then passes the turn.",
    },
    winning: {
      title: "# BUCKSHOT — WINNING",
      text:
        "**Hearts**\n" +
        "Players start with 4 hearts. At the start of later rounds, maximum health drops by 1 but never below 2. Current health cannot exceed the new maximum.\n\n" +
        "**Round completion**\n" +
        "When all shells in a chamber are gone, the next round starts automatically.\n\n" +
        "**Match win**\n" +
        "A player wins immediately when the opponent reaches 0 hearts. If the final scheduled round ends with both alive, the player with more hearts wins.\n\n" +
        "**Sudden Death**\n" +
        "If the final round is tied, both players are reduced to 1 heart, items are cleared and a short chamber is loaded. The first elimination decides the match.",
    },
    money: {
      title: "# BUCKSHOT — ENVY WAGERS",
      text:
        "**Wallet source**\n" +
        "Buckshot uses the player’s Envy wallet. Banked currency is not used for wagers.\n\n" +
        "**When money moves**\n" +
        "The wager is not taken when the challenge is created. Both players’ stakes are locked only after the opponent accepts.\n\n" +
        "**The pot**\n" +
        "Each player contributes the exact amount shown on the challenge. The winner receives the full 2× pot.\n\n" +
        "**Refunds and recovery**\n" +
        "If a ticket cannot be created after a successful lock, Greed asks Envy to refund both stakes. Settlement operations are persisted and retried after restart.\n\n" +
        "**Example**\n        amount:5000 means 5,000 coins from each player and a 10,000-coin winner payout.",
    }
  };

  const data = sections[section] || sections.home;
  const container = new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(data.title),
      new TextDisplayBuilder().setContent(data.text)
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

  if (section === "home") {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        rulesButton("rules:basics", "Basics"),
        rulesButton("rules:turns", "Turns"),
        rulesButton("rules:items", "Items"),
        rulesButton("rules:winning", "Winning"),
        rulesButton("rules:money", "Wagers")
      )
    );
  } else {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        rulesButton("rules:home", "Rules Home"),
        rulesButton("rules:basics", "Basics"),
        rulesButton("rules:turns", "Turns"),
        rulesButton("rules:items", "Items"),
        rulesButton("rules:winning", "Winning")
      )
    );
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        rulesButton("rules:money", "Wagers", ButtonStyle.Primary)
      )
    );
  }

  return container;
}

function buildResultPanel(game) {
  const winner = game.players[game.winnerId];
  const loserId = oppositePlayerId(game, game.winnerId);
  const loser = game.players[loserId];

  return new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# BUCKSHOT — GAME OVER"),
      new TextDisplayBuilder().setContent(
        `${game.endReason ? `**Reason:** ${game.endReason}\n\n` : ""}` +
        `**Winner:** ${userName(game, winner.id)}\n` +
        `**Defeated:** ${userName(game, loser.id)}\n\n` +
        `**Final health**\n` +
        `${userName(game, winner.id)} — ${heartDisplay(winner)}\n` +
        `${userName(game, loser.id)} — ${heartDisplay(loser)}\n\n` +
        `**Difficulty:** ${difficultyFor(game).label}\n` +
        `**Wager:** ${Number(game.wager || 0).toLocaleString()} per player\n` +
        `**Pot:** ${(Number(game.wager || 0) * 2).toLocaleString()}`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        actionButton(`game:rematch:${game.id}`, "Rematch"),
        actionButton(`game:close:${game.id}`, "Close Ticket")
      )
    );
}

function buildRoundAnnouncement(game, text) {
  const roundTitle = game.suddenDeath
    ? "SUDDEN DEATH"
    : `ROUND ${game.round}/${difficultyFor(game).rounds}`;

  return new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# BUCKSHOT — ${roundTitle}`),
      new TextDisplayBuilder().setContent(text),
      new TextDisplayBuilder().setContent(
        `**${userName(game, game.challengerId)}:** ${heartDisplay(game.players[game.challengerId])}\n` +
        `**${userName(game, game.targetId)}:** ${heartDisplay(game.players[game.targetId])}\n\n` +
        `**Next turn:** ${userName(game, game.turnId)}`
      )
    );
}

async function getOrCreateTicketCategory(guild) {
  if (process.env.TICKET_CATEGORY_ID) {
    const configured = guild.channels.cache.get(process.env.TICKET_CATEGORY_ID);
    if (configured?.type === ChannelType.GuildCategory) return configured;
  }

  const existing = guild.channels.cache.find(
    ch => ch.type === ChannelType.GuildCategory && ch.name === "Buckshot Tickets"
  );
  if (existing) return existing;

  return guild.channels.create({
    name: "Buckshot Tickets",
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }
    ]
  });
}

function clearTurnTimer(gameId) {
  const timer = turnTimers.get(gameId);
  if (timer) clearTimeout(timer);
  turnTimers.delete(gameId);
}

function scheduleTurnTimer(game) {
  clearTurnTimer(game.id);
  if (game.finished || !game.turnId) return;

  const timeoutMs = game.turnTimeoutMs || TURN_TIMEOUT_MS;
  const remaining = Math.max(1, timeoutMs - (Date.now() - game.lastActionAt));
  turnTimers.set(
    game.id,
    setTimeout(() => handleTurnTimeout(game.id).catch(console.error), remaining)
  );
}

async function refreshGameMessage(game) {
  const channel = await client.channels.fetch(game.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const message = await channel.messages.fetch(game.messageId).catch(() => null);
  if (!message) return;

  await message.edit({
    components: [buildGamePanel(game)],
    flags: MessageFlags.IsComponentsV2
  }).catch(() => {});
}

function passTurn(game, fromId) {
  const nextId = oppositePlayerId(game, fromId);
  if (game.skippedTurn.has(nextId)) {
    game.skippedTurn.delete(nextId);
    game.turnId = fromId;
    return true;
  }
  game.turnId = nextId;
  return false;
}

async function recordRoundWin(game, userId) {
  if (!userId) return;
  const player = game.players[userId];
  await updateStats(game.guildId, userId, userName(game, userId), { rounds_won: 1 });
  player.roundWins = (player.roundWins || 0) + 1;
}

async function recordGameResult(game) {
  if (game.statsRecorded) return;

  const winner = game.players[game.winnerId];
  const loserId = oppositePlayerId(game, game.winnerId);
  const loser = game.players[loserId];

  await updateStats(game.guildId, winner.id, userName(game, winner.id), {
    games: 1,
    wins: 1,
    damage_dealt: winner.damageDealt || 0,
    items_used: winner.itemsUsed || 0
  });
  await updateStats(game.guildId, loser.id, userName(game, loser.id), {
    games: 1,
    losses: 1,
    damage_dealt: loser.damageDealt || 0,
    items_used: loser.itemsUsed || 0
  });

  game.statsRecorded = true;
  await saveGame(game);
}

async function endGame(game, winnerId, reason) {
  if (game.finished) return;

  game.finished = true;
  game.winnerId = winnerId;
  game.endReason = reason || "Match complete";
  game.lastActionAt = Date.now();

  activeUsers.delete(game.challengerId);
  activeUsers.delete(game.targetId);
  clearTurnTimer(game.id);

  if (game.wager && game.wagerStatus !== "settled" && game.wagerId) {
    try {
      await settleBuckshotWager(game.wagerId, winnerId);
      game.wagerStatus = "settled";
    } catch (error) {
      game.wagerStatus = "pending_settlement";
      console.error("Failed to settle Envy wager", game.wagerId, error);
    }
  }

  await saveGame(game);
  await recordGameResult(game);
}

async function advanceRoundOrFinish(game, reason) {
  if (game.suddenDeath) return { type: "continue" };

  const difficulty = difficultyFor(game);

  if (game.round >= difficulty.rounds) {
    const [p1, p2] = Object.values(game.players);
    if (p1.hp > p2.hp) {
      await endGame(game, p1.id, reason || "Final-round health advantage.");
      return { type: "finished" };
    }
    if (p2.hp > p1.hp) {
      await endGame(game, p2.id, reason || "Final-round health advantage.");
      return { type: "finished" };
    }

    prepareSuddenDeath(game);
    game.lastActionAt = Date.now();
    await saveGame(game);
    scheduleTurnTimer(game);
    return { type: "sudden_death" };
  }

  const [p1, p2] = Object.values(game.players);
  if (p1.hp > p2.hp) await recordRoundWin(game, p1.id);
  else if (p2.hp > p1.hp) await recordRoundWin(game, p2.id);

  game.round += 1;
  prepareRound(game);
  game.lastActionAt = Date.now();
  await saveGame(game);
  scheduleTurnTimer(game);

  return { type: "next_round" };
}

async function announceRoundChange(channel, game, result, reason = "") {
  let text;
  if (result.type === "sudden_death") {
    text = `The final round ended in an exact health tie. **Sudden Death** begins. Both players have been set to 1 heart and all items are cleared.`;
  } else {
    text = `${reason ? `${reason}\n\n` : ""}The chamber is empty. The next round begins. Maximum hearts fall by 1, down to a minimum of 2.`;
  }

  await channel.send({
    components: [buildRoundAnnouncement(game, text)],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: publicMentions([game.turnId])
  });
}

async function resolveRoundIfEmpty(interaction, game, reason = "") {
  if (game.shells.length > 0) return false;

  const result = await advanceRoundOrFinish(game, reason);

  if (result.type === "finished") {
    await interaction.channel.send({
      components: [buildResultPanel(game)],
      flags: MessageFlags.IsComponentsV2
    });
    await refreshGameMessage(game);
    return true;
  }

  if (result.type === "sudden_death" || result.type === "next_round") {
    await announceRoundChange(interaction.channel, game, result, reason);
    await refreshGameMessage(game);
    return true;
  }

  return false;
}

async function handleTurnTimeout(gameId) {
  const game = games.get(gameId);
  if (!game || game.finished) return;

  const timeoutMs = game.turnTimeoutMs || TURN_TIMEOUT_MS;
  if (Date.now() - game.lastActionAt < timeoutMs) {
    scheduleTurnTimer(game);
    return;
  }

  const winnerId = oppositePlayerId(game, game.turnId);
  const timedOutPlayer = userName(game, game.turnId);
  await endGame(game, winnerId, `${timedOutPlayer} failed to act before the turn timer expired.`);

  await refreshGameMessage(game);
  const channel = await client.channels.fetch(game.channelId).catch(() => null);
  if (channel?.isTextBased()) {
    await channel.send({
      components: [buildResultPanel(game)],
      flags: MessageFlags.IsComponentsV2
    });
  }
}

async function handleShot(interaction, game, targetSelf) {
  if (game.processing) {
    return interaction.reply({ content: "That action is already being processed.", flags: MessageFlags.Ephemeral });
  }
  game.processing = true;

  try {
    if (game.finished) {
      return interaction.reply({ content: "This game is already finished.", flags: MessageFlags.Ephemeral });
    }
    if (interaction.user.id !== game.turnId) {
      return interaction.reply({ content: "It is not your turn.", flags: MessageFlags.Ephemeral });
    }

    if (!game.shells.length) {
      await interaction.reply({ content: "The chamber is empty. The next round is being prepared.", flags: MessageFlags.Ephemeral });
      const result = await advanceRoundOrFinish(game);
      if (result.type !== "finished") await announceRoundChange(interaction.channel, game, result);
      else await interaction.channel.send({ components: [buildResultPanel(game)], flags: MessageFlags.IsComponentsV2 });
      await refreshGameMessage(game);
      return;
    }

    const shooter = game.players[game.turnId];
    const opponentId = oppositePlayerId(game, game.turnId);
    const targetId = targetSelf ? game.turnId : opponentId;
    const target = game.players[targetId];

    const shell = game.shells.shift();
    const damage = shell === "live" ? (shooter.sawArmed ? 2 : 1) : 0;
    shooter.sawArmed = false;
    shooter.damageDealt = (shooter.damageDealt || 0) + damage;

    let resultText;
    if (shell === "live") {
      target.hp = Math.max(0, target.hp - damage);
      resultText = `**${userName(game, game.turnId)}** fired a **LIVE** shell at **${userName(game, targetId)}** and dealt **${damage} ${damage === 1 ? "heart" : "hearts"} of damage**.`;
    } else {
      resultText = `**${userName(game, game.turnId)}** fired a **BLANK** shell${targetSelf ? " at themselves" : " at the opponent"}.`;
    }

    game.lastActionAt = Date.now();

    if (target.hp <= 0) {
      await endGame(game, shooter.id, resultText);
      await interaction.update({
        components: [buildGamePanel(game)],
        flags: MessageFlags.IsComponentsV2
      });
      await interaction.channel.send({
        components: [buildResultPanel(game)],
        flags: MessageFlags.IsComponentsV2
      });
      return;
    }

    if (!(shell === "blank" && targetSelf)) {
      const skipped = passTurn(game, game.turnId);
      if (skipped) resultText += ` **${userName(game, opponentId)}'s turn was skipped.**`;
    }

    await saveGame(game);
    scheduleTurnTimer(game);

    await interaction.update({
      components: [buildGamePanel(game)],
      flags: MessageFlags.IsComponentsV2
    });

    await interaction.channel.send({
      components: [
        new ContainerBuilder()
          .setAccentColor(BLACK)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `${resultText}\n\n` +
              `**${userName(game, game.challengerId)}:** ${heartDisplay(game.players[game.challengerId])}\n` +
              `**${userName(game, game.targetId)}:** ${heartDisplay(game.players[game.targetId])}`
            )
          )
      ],
      flags: MessageFlags.IsComponentsV2
    });

    await resolveRoundIfEmpty(interaction, game, resultText);
    await refreshGameMessage(game);
  } finally {
    game.processing = false;
  }
}

async function privateItemResult(interaction, title, body) {
  return interaction.reply({
    components: [
      new ContainerBuilder()
        .setAccentColor(BLACK)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`## ${title}\n${body}`)
        )
    ],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
  });
}

async function logPublicAction(channel, text) {
  await channel.send({
    components: [
      new ContainerBuilder()
        .setAccentColor(BLACK)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
    ],
    flags: MessageFlags.IsComponentsV2
  });
}

async function handleItem(interaction, game, item) {
  if (game.processing) {
    return interaction.reply({ content: "That action is already being processed.", flags: MessageFlags.Ephemeral });
  }
  game.processing = true;

  try {
    if (game.finished) {
      return interaction.reply({ content: "This game is already finished.", flags: MessageFlags.Ephemeral });
    }
    if (interaction.user.id !== game.turnId) {
      return interaction.reply({ content: "It is not your turn.", flags: MessageFlags.Ephemeral });
    }

    const player = game.players[interaction.user.id];
    const itemIndex = player.items.indexOf(item);
    if (itemIndex === -1) {
      return interaction.reply({ content: "You do not have that item.", flags: MessageFlags.Ephemeral });
    }

    player.items.splice(itemIndex, 1);
    player.itemsUsed = (player.itemsUsed || 0) + 1;
    const opponentId = oppositePlayerId(game, interaction.user.id);
    const opponent = game.players[opponentId];
    let publicText = `**${userName(game, interaction.user.id)}** used **${ITEM_INFO[item]?.label || item}**.`;

    if (item === "magnifier") {
      if (!game.shells.length) {
        player.items.push(item);
        player.itemsUsed -= 1;
        return privateItemResult(interaction, "Magnifier", "The chamber is empty. The item was returned to you.");
      }
      await privateItemResult(interaction, "Magnifier", `The current shell is **${shellLabel(game.shells[0])}**.`);
      publicText += " The shell type was revealed privately.";
      await logPublicAction(interaction.channel, publicText);
      game.lastActionAt = Date.now();
      await saveGame(game);
      scheduleTurnTimer(game);
      await refreshGameMessage(game);
      return;
    }

    if (item === "beer") {
      if (!game.shells.length) {
        player.items.push(item);
        player.itemsUsed -= 1;
        return privateItemResult(interaction, "Beer", "The chamber is empty. The item was returned to you.");
      }
      const shell = game.shells.shift();
      await privateItemResult(interaction, "Beer", `You ejected a **${shellLabel(shell)}** shell.`);
      passTurn(game, interaction.user.id);
      game.lastActionAt = Date.now();
      await saveGame(game);
      scheduleTurnTimer(game);
      await logPublicAction(interaction.channel, `${publicText} The current shell was ejected.`);
      await resolveRoundIfEmpty(interaction, game, `${userName(game, interaction.user.id)} ejected the final shell of the round.`);
      await refreshGameMessage(game);
      return;
    }

    if (item === "cigarettes") {
      const before = player.hp;
      player.hp = Math.min(player.maxHp, player.hp + 1);
      await privateItemResult(interaction, "Cigarettes", `You restored **${plural(player.hp - before, "heart")}**.`);
      passTurn(game, interaction.user.id);
      game.lastActionAt = Date.now();
      await saveGame(game);
      scheduleTurnTimer(game);
      await logPublicAction(interaction.channel, `${publicText} Health changed to ${player.hp}/${player.maxHp}.`);
      await refreshGameMessage(game);
      return;
    }

    if (item === "saw") {
      player.sawArmed = true;
      await privateItemResult(interaction, "Hand Saw", "Your next **LIVE** shot deals **2 damage**. Arming the saw passes the turn.");
      passTurn(game, interaction.user.id);
      game.lastActionAt = Date.now();
      await saveGame(game);
      scheduleTurnTimer(game);
      await logPublicAction(interaction.channel, publicText);
      await refreshGameMessage(game);
      return;
    }

    if (item === "handcuffs") {
      game.skippedTurn.add(opponentId);
      const skippedImmediately = passTurn(game, interaction.user.id);
      await privateItemResult(
        interaction,
        "Handcuffs",
        skippedImmediately
          ? `The opponent already had a pending skip. Their skip was consumed and **${userName(game, game.turnId)}** retains the turn.`
          : `**${userName(game, opponentId)}** will lose their next turn.`
      );
      game.lastActionAt = Date.now();
      await saveGame(game);
      scheduleTurnTimer(game);
      await logPublicAction(interaction.channel, publicText);
      await refreshGameMessage(game);
      return;
    }

    if (item === "phone") {
      if (game.shells.length < 2) {
        player.items.push(item);
        player.itemsUsed -= 1;
        return privateItemResult(interaction, "Burner Phone", "There are not enough shells ahead for a future reading. The item was returned to you.");
      }
      const maxLookAhead = Math.min(3, game.shells.length - 1);
      const position = 1 + Math.floor(Math.random() * maxLookAhead);
      const shell = game.shells[position];
      await privateItemResult(interaction, "Burner Phone", `A shell **${position + 1} positions ahead** is **${shellLabel(shell)}**.`);
      passTurn(game, interaction.user.id);
      game.lastActionAt = Date.now();
      await saveGame(game);
      scheduleTurnTimer(game);
      await logPublicAction(interaction.channel, `${publicText} Future shell information was revealed privately.`);
      await refreshGameMessage(game);
      return;
    }

    if (item === "inverter") {
      if (!game.shells.length) {
        player.items.push(item);
        player.itemsUsed -= 1;
        return privateItemResult(interaction, "Inverter", "The chamber is empty. The item was returned to you.");
      }
      game.shells[0] = game.shells[0] === "live" ? "blank" : "live";
      await privateItemResult(interaction, "Inverter", "The current shell has been flipped.");
      passTurn(game, interaction.user.id);
      game.lastActionAt = Date.now();
      await saveGame(game);
      scheduleTurnTimer(game);
      await logPublicAction(interaction.channel, publicText);
      await refreshGameMessage(game);
      return;
    }

    if (item === "adrenaline") {
      if (!opponent.items.length) {
        player.items.push(item);
        player.itemsUsed -= 1;
        return privateItemResult(interaction, "Adrenaline", "The opponent has no item to steal. Adrenaline was returned to you.");
      }
      const stolenIndex = Math.floor(Math.random() * opponent.items.length);
      const stolen = opponent.items.splice(stolenIndex, 1)[0];
      player.items.push(stolen);
      await privateItemResult(interaction, "Adrenaline", `You stole **${ITEM_INFO[stolen].label}**.`);
      passTurn(game, interaction.user.id);
      game.lastActionAt = Date.now();
      await saveGame(game);
      scheduleTurnTimer(game);
      await logPublicAction(interaction.channel, publicText);
      await refreshGameMessage(game);
      return;
    }

    player.items.push(item);
    player.itemsUsed -= 1;
    return interaction.reply({ content: "That item is not available in this version, so it was returned.", flags: MessageFlags.Ephemeral });
  } finally {
    game.processing = false;
  }
}

async function createGameTicket(guild, challenge) {
  const category = await getOrCreateTicketCategory(guild);
  const gameId = randomId("game");
  const challengerMember = await guild.members.fetch(challenge.challengerId);
  const targetMember = await guild.members.fetch(challenge.targetId);
  const safeName = `buckshot-${challengerMember.user.username}-${targetMember.user.username}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 90);

  const channel = await guild.channels.create({
    name: safeName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Buckshot game ${gameId} | ${DIFFICULTIES[challenge.difficulty].label}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: challenge.challengerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: challenge.targetId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] }
    ]
  });

  const settings = await getBuckshotSettings(guild.id);
  const game = {
    id: gameId,
    guildId: guild.id,
    channelId: channel.id,
    challengerId: challenge.challengerId,
    targetId: challenge.targetId,
    difficulty: challenge.difficulty,
    wager: Number(challenge.wager || 0),
    wagerId: challenge.id,
    wagerStatus: 'locked',
    turnTimeoutMs: Math.max(30_000, settings.turn_timeout_seconds * 1000),
    round: 1,
    turnId: Math.random() < 0.5 ? challenge.challengerId : challenge.targetId,
    shells: [],
    players: {
      [challenge.challengerId]: {
        id: challenge.challengerId,
        name: challengerMember.displayName,
        hp: STARTING_HP,
        maxHp: STARTING_HP,
        items: [],
        sawArmed: false,
        damageDealt: 0,
        itemsUsed: 0,
        roundWins: 0
      },
      [challenge.targetId]: {
        id: challenge.targetId,
        name: targetMember.displayName,
        hp: STARTING_HP,
        maxHp: STARTING_HP,
        items: [],
        sawArmed: false,
        damageDealt: 0,
        itemsUsed: 0,
        roundWins: 0
      }
    },
    skippedTurn: new Set(),
    finished: false,
    winnerId: null,
    suddenDeath: false,
    roundStartedAt: Date.now(),
    lastActionAt: Date.now(),
    endReason: "",
    statsRecorded: false,
    processing: false,
    messageId: null,
    rematchInitiatorId: null
  };

  prepareRound(game);
  games.set(game.id, game);
  activeUsers.set(game.challengerId, game.id);
  activeUsers.set(game.targetId, game.id);

  const message = await channel.send({
    components: [buildGamePanel(game)],
    flags: MessageFlags.IsComponentsV2
  });
  game.messageId = message.id;
  game.lastActionAt = Date.now();
  await saveGame(game);
  scheduleTurnTimer(game);

  await channel.send({
    components: [
      new ContainerBuilder()
        .setAccentColor(BLACK)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## MATCH STARTED\n` +
            `**Challenger:** <@${game.challengerId}>\n` +
            `**Opponent:** <@${game.targetId}>\n` +
            `**Difficulty:** ${DIFFICULTIES[game.difficulty].label}\n` +
            `**Rounds:** ${DIFFICULTIES[game.difficulty].rounds}\n` +
            `**Starting hearts:** ${STARTING_HP} each\n` +
            `**First turn:** <@${game.turnId}>\n\n` +
            "The game is controlled by the buttons in the black panel."
          )
        )
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: publicMentions([game.challengerId, game.targetId, game.turnId])
  });

  return { channel, game };
}

async function startRematch(game, difficulty) {
  const wagerId = game.id + ":rematch:" + Date.now().toString();
  const settings = await getBuckshotSettings(game.guildId);
  await lockBuckshotWager(
    wagerId,
    game.guildId,
    game.challengerId,
    game.targetId,
    Number(game.wager || 0)
  );

  clearTurnTimer(game.id);
  rematchRequests.delete(game.id);

  for (const userId of [game.challengerId, game.targetId]) {
    activeUsers.set(userId, game.id);
  }

  game.wagerId = wagerId;
  game.wagerStatus = "locked";
  game.turnTimeoutMs = Math.max(30_000, settings.turn_timeout_seconds * 1000);
  game.difficulty = difficulty;
  game.round = 1;
  game.turnId = Math.random() < 0.5 ? game.challengerId : game.targetId;
  game.shells = [];
  game.suddenDeath = false;
  game.finished = false;
  game.winnerId = null;
  game.endReason = "";
  game.statsRecorded = false;
  game.lastActionAt = Date.now();
  game.roundStartedAt = Date.now();
  game.rematchInitiatorId = null;
  game.processing = false;

  for (const player of Object.values(game.players)) {
    player.hp = STARTING_HP;
    player.maxHp = STARTING_HP;
    player.items = [];
    player.sawArmed = false;
    player.damageDealt = 0;
    player.itemsUsed = 0;
    player.roundWins = 0;
  }

  game.skippedTurn = new Set();
  prepareRound(game);
  await saveGame(game);
  scheduleTurnTimer(game);
}

async function handleRematchButton(interaction, game) {
  if (!game.finished && !rematchRequests.has(game.id)) {
    return interaction.reply({ content: "The current match is still active.", flags: MessageFlags.Ephemeral });
  }

  if (!game.finished && rematchRequests.has(game.id)) {
    return interaction.reply({ content: "A rematch choice is already open.", flags: MessageFlags.Ephemeral });
  }

  if (!rematchRequests.has(game.id)) {
    game.rematchInitiatorId = interaction.user.id;
    rematchRequests.set(game.id, { initiatorId: interaction.user.id, createdAt: Date.now() });
    setTimeout(() => {
      const request = rematchRequests.get(game.id);
      if (!request) return;
      if (Date.now() - request.createdAt >= REMATCH_TIMEOUT_MS) rematchRequests.delete(game.id);
    }, REMATCH_TIMEOUT_MS);
  }

  await interaction.reply({
    components: [buildRematchPanel(game)],
    flags: MessageFlags.IsComponentsV2
  });
}

async function closeGameTicket(interaction, game) {
  if (
    interaction.user.id !== game.challengerId &&
    interaction.user.id !== game.targetId &&
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)
  ) {
    return interaction.reply({
      content: "Only the players or a moderator can close this ticket.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (!game.finished && game.wager && game.wagerId && game.wagerStatus === "locked") {
    try {
      await refundBuckshotWager(game.wagerId);
      game.wagerStatus = "refunded";
    } catch (error) {
      console.error("Failed to refund Envy wager before closing ticket", game.wagerId, error);
      return interaction.reply({
        content: "The ticket cannot be closed yet because the Envy wager could not be refunded. Please try again in a moment.",
        flags: MessageFlags.Ephemeral
      });
    }
  }

  activeUsers.delete(game.challengerId);
  activeUsers.delete(game.targetId);
  clearTurnTimer(game.id);
  games.delete(game.id);
  rematchRequests.delete(game.id);
  await deleteGame(game.id);

  await interaction.reply({ content: "Closing the Buckshot ticket...", flags: MessageFlags.Ephemeral });
  await sleep(700);
  await interaction.channel.delete("Buckshot game closed");
}

async function handleForceEnd(interaction, channel) {
  const game = [...games.values()].find(
    candidate => candidate.guildId === interaction.guildId && candidate.channelId === channel.id && !candidate.finished
  );

  if (!game) {
    return interaction.reply({ content: "There is no active Buckshot game in that channel.", flags: MessageFlags.Ephemeral });
  }

  await endGame(game, interaction.user.id === game.challengerId ? game.targetId : game.challengerId, `Match force-ended by ${interaction.user.username}.`);
  await refreshGameMessage(game);
  await channel.send({ components: [buildResultPanel(game)], flags: MessageFlags.IsComponentsV2 });
  return interaction.reply({ content: "The Buckshot match was force-ended.", flags: MessageFlags.Ephemeral });
}

async function sendStats(interaction, userId) {
  const stats = await getStats(interaction.guildId, userId);
  const winRate = stats.games ? ((stats.wins / stats.games) * 100).toFixed(1) : "0.0";

  return interaction.reply({
    components: [
      new ContainerBuilder()
        .setAccentColor(BLACK)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# BUCKSHOT — STATISTICS\n**${stats.display_name === "Unknown Player" ? `<@${userId}>` : stats.display_name}**`),
          new TextDisplayBuilder().setContent(
            `**Games:** ${stats.games}\n` +
            `**Wins:** ${stats.wins}\n` +
            `**Losses:** ${stats.losses}\n` +
            `**Win rate:** ${winRate}%\n` +
            `**Round wins:** ${stats.rounds_won}\n` +
            `**Damage dealt:** ${stats.damage_dealt}\n` +
            `**Items used:** ${stats.items_used}`
          )
        )
    ],
    flags: MessageFlags.IsComponentsV2
  });
}

async function sendLeaderboard(interaction) {
  const rows = await getLeaderboard(interaction.guildId, 10);
  const lines = rows.length
    ? rows.map((row, index) =>
        `**${index + 1}.** ${row.display_name} — ${row.wins}W / ${row.losses}L · ${Number(row.win_rate).toFixed(1)}% WR · ${row.damage_dealt} damage`
      ).join("\n")
    : "No Buckshot games have been recorded on this server yet.";

  return interaction.reply({
    components: [
      new ContainerBuilder()
        .setAccentColor(BLACK)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("# BUCKSHOT — LEADERBOARD"),
          new TextDisplayBuilder().setContent(lines)
        )
    ],
    flags: MessageFlags.IsComponentsV2
  });
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await initDatabase();
    await restoreState();
    console.log(dbReady ? "PostgreSQL persistence is enabled." : "Using temporary in-memory storage.");
    console.log("Buckshot bot is ready.");
  } catch (error) {
    dbReady = false;
    console.error("PostgreSQL setup/restore failed. Continuing in temporary in-memory mode.", error);
  }
});

client.on("error", console.error);

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "buckshot") return;
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === "guide" || subcommand === "rules") {
        return interaction.reply({
          components: [buildRulesPanel()],
          flags: MessageFlags.IsComponentsV2
        });
      }

      if (subcommand === "challenge") {
        if (!isChallengeChannelAllowed(interaction.guildId, interaction.channelId)) {
          return interaction.reply({
            content: `Buckshot challenge requests are restricted to ${getChallengeRestrictionText(interaction.guildId)}.`,
            flags: MessageFlags.Ephemeral
          });
        }

        const target = interaction.options.getUser("player", true);
        const difficulty = interaction.options.getString("difficulty", true);
        const amount = interaction.options.getInteger("amount", true);
        const challenger = interaction.user;

        if (amount <= 0) {
          return interaction.reply({ content: "The wager must be greater than 0.", flags: MessageFlags.Ephemeral });
        }
        if (!envyConfigured()) {
          return interaction.reply({ content: "Money-backed Buckshot is not configured yet. Envy connection is required.", flags: MessageFlags.Ephemeral });
        }
        if (!DIFFICULTIES[difficulty]) {
          return interaction.reply({ content: "That difficulty is not available.", flags: MessageFlags.Ephemeral });
        }
        if (target.bot) return interaction.reply({ content: "You cannot challenge a bot.", flags: MessageFlags.Ephemeral });
        if (target.id === challenger.id) return interaction.reply({ content: "You cannot challenge yourself.", flags: MessageFlags.Ephemeral });
        if (activeUsers.has(challenger.id)) return interaction.reply({ content: "You are already in a Buckshot game.", flags: MessageFlags.Ephemeral });
        if (activeUsers.has(target.id)) return interaction.reply({ content: "That player is already in a Buckshot game.", flags: MessageFlags.Ephemeral });

        const duplicate = [...challenges.values()].find(
          c => c.guildId === interaction.guildId &&
            ((c.challengerId === challenger.id && c.targetId === target.id) ||
             (c.challengerId === target.id && c.targetId === challenger.id))
        );
        if (duplicate) {
          return interaction.reply({ content: "There is already a pending Buckshot challenge between these players.", flags: MessageFlags.Ephemeral });
        }

        const challenge = {
          id: randomId("challenge"),
          guildId: interaction.guildId,
          challengerId: challenger.id,
          targetId: target.id,
          difficulty,
          channelId: interaction.channelId,
          wager: amount,
          createdAt: Date.now()
        };

        challenges.set(challenge.id, challenge);
        await saveChallenge(challenge);
        scheduleChallengeExpiry(challenge);

        return interaction.reply({
          components: [buildChallengePanel(challenge)],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: publicMentions([challenger.id, target.id])
        });
      }

      if (subcommand === "cancel") {
        const target = interaction.options.getUser("player", false);
        const mine = [...challenges.values()].filter(
          c => c.guildId === interaction.guildId && c.challengerId === interaction.user.id && (!target || c.targetId === target.id)
        );

        if (!mine.length) {
          return interaction.reply({ content: "You have no matching pending Buckshot challenge requests.", flags: MessageFlags.Ephemeral });
        }

        for (const challenge of mine) {
          challenges.delete(challenge.id);
          await deleteChallenge(challenge.id);
          const channel = await client.channels.fetch(challenge.channelId).catch(() => null);
          if (channel?.isTextBased()) {
            const messages = await channel.messages.fetch({ limit: 30 }).catch(() => null);
            const message = messages?.find(m =>
              m.author.id === client.user.id &&
              m.components?.some(row => row.components?.some(component => component.customId === `challenge:accept:${challenge.id}`))
            );
            if (message) {
              await message.edit({
                components: [buildChallengePanel(challenge, "cancelled")],
                flags: MessageFlags.IsComponentsV2,
                allowedMentions: publicMentions([challenge.challengerId, challenge.targetId])
              }).catch(() => {});
            }
          }
        }

        return interaction.reply({ content: `Cancelled ${mine.length} pending Buckshot challenge${mine.length === 1 ? "" : "s"}.`, flags: MessageFlags.Ephemeral });
      }

      if (subcommand === "stats") {
        return sendStats(interaction, interaction.options.getUser("player", false)?.id || interaction.user.id);
      }

      if (subcommand === "leaderboard") {
        return sendLeaderboard(interaction);
      }

      if (subcommand === "restrict") {
        const channel = interaction.options.getChannel("channel", true);
        await saveRestriction(interaction.guildId, channel.id);
        return interaction.reply({
          components: [
            new ContainerBuilder()
              .setAccentColor(BLACK)
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `## BUCKSHOT — CHANNEL RESTRICTED\nNew challenge requests can now only be started in ${channel}.\n\nUse /buckshot unrestrict to allow challenges in any channel again.`
                )
              )
          ],
          flags: MessageFlags.IsComponentsV2
        });
      }

      if (subcommand === "unrestrict") {
        await saveRestriction(interaction.guildId, null);
        return interaction.reply({
          components: [
            new ContainerBuilder()
              .setAccentColor(BLACK)
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent("## BUCKSHOT — RESTRICTION REMOVED\nNew challenge requests can now be started in any channel.")
              )
          ],
          flags: MessageFlags.IsComponentsV2
        });
      }

      if (subcommand === "active") {
        const active = [...games.values()].filter(game => game.guildId === interaction.guildId && !game.finished);
        const body = active.length
          ? active.map((game, i) => `${i + 1}. <#${game.channelId}> — ${userName(game, game.challengerId)} vs ${userName(game, game.targetId)} · ${difficultyFor(game).label} · Round ${game.round}/${difficultyFor(game).rounds}`).join("\n")
          : "No active Buckshot matches.";

        return interaction.reply({
          components: [
            new ContainerBuilder()
              .setAccentColor(BLACK)
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent("# BUCKSHOT — ACTIVE MATCHES"),
                new TextDisplayBuilder().setContent(body)
              )
          ],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
        });
      }

      if (subcommand === "forceend") {
        const channel = interaction.options.getChannel("channel", false) || interaction.channel;
        return handleForceEnd(interaction, channel);
      }

      if (subcommand === "reset") {
        const target = interaction.options.getUser("player", true);
        await resetStats(interaction.guildId, target.id);
        return interaction.reply({ content: `Reset Buckshot statistics for <@${target.id}>.`, flags: MessageFlags.Ephemeral });
      }
    }

    if (!interaction.isButton()) return;

    const parts = interaction.customId.split(":");
    const scope = parts[0];
    const action = parts[1];

    if (scope === "rules") {
      const section = parts[1] || "home";
      return interaction.update({
        components: [buildRulesPanel(section)],
        flags: MessageFlags.IsComponentsV2
      });
    }

    if (scope === "challenge") {
      const challengeId = parts[2];
      const challenge = challenges.get(challengeId);
      if (!challenge) return interaction.reply({ content: "That challenge is no longer active.", flags: MessageFlags.Ephemeral });

      if (action === "cancel") {
        if (interaction.user.id !== challenge.challengerId) {
          return interaction.reply({ content: "Only the challenger can cancel this request.", flags: MessageFlags.Ephemeral });
        }
        challenges.delete(challenge.id);
        await deleteChallenge(challenge.id);
        return interaction.update({
          components: [buildChallengePanel(challenge, "cancelled")],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: publicMentions([challenge.challengerId, challenge.targetId])
        });
      }

      if (interaction.user.id !== challenge.targetId) {
        return interaction.reply({ content: "Only the challenged player can accept or decline this.", flags: MessageFlags.Ephemeral });
      }

      if (action === "accept") {
        if (activeUsers.has(challenge.challengerId) || activeUsers.has(challenge.targetId)) {
          challenges.delete(challenge.id);
          await deleteChallenge(challenge.id);
          return interaction.update({
            components: [buildChallengePanel(challenge, "cancelled")],
            flags: MessageFlags.IsComponentsV2
          });
        }

        if (!challenge.wager || challenge.wager <= 0) {
          challenges.delete(challenge.id);
          await deleteChallenge(challenge.id);
          return interaction.update({
            components: [buildChallengePanel(challenge, "cancelled")],
            flags: MessageFlags.IsComponentsV2
          });
        }

        try {
          await lockBuckshotWager(
            challenge.id,
            challenge.guildId,
            challenge.challengerId,
            challenge.targetId,
            Number(challenge.wager)
          );
        } catch (error) {
          console.error("Buckshot wager lock failed", challenge.id, error);
          return interaction.reply({
            content: error.message || "The wager could not be locked from Envy.",
            flags: MessageFlags.Ephemeral
          });
        }

        challenges.delete(challenge.id);
        await deleteChallenge(challenge.id);

        let channel;
        try {
          ({ channel } = await createGameTicket(interaction.guild, challenge));
        } catch (error) {
          console.error("Buckshot ticket creation failed after wager lock", challenge.id, error);
          await refundBuckshotWager(challenge.id).catch(refundError =>
            console.error("Failed to refund Buckshot wager", challenge.id, refundError)
          );
          return interaction.reply({
            content: "The Buckshot ticket could not be created, so the wager was refunded.",
            flags: MessageFlags.Ephemeral
          });
        }

        return interaction.update({
          components: [buildChallengePanel(challenge, "accepted", channel.toString())],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: publicMentions([challenge.challengerId, challenge.targetId])
        });
      }

      if (action === "decline") {
        challenges.delete(challenge.id);
        await deleteChallenge(challenge.id);
        return interaction.update({
          components: [buildChallengePanel(challenge, "declined")],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: publicMentions([challenge.challengerId, challenge.targetId])
        });
      }
    }

    if (scope === "game") {
      const actionName = action;
      let gameId;
      let item;

      if (actionName === "item") {
        item = parts[2];
        gameId = parts[3];
      } else {
        gameId = parts[2];
      }

      const game = games.get(gameId);
      if (!game) return interaction.reply({ content: "This game no longer exists.", flags: MessageFlags.Ephemeral });
      if (interaction.channelId !== game.channelId) return interaction.reply({ content: "That game is in another ticket.", flags: MessageFlags.Ephemeral });

      if (actionName === "shoot_enemy") return handleShot(interaction, game, false);
      if (actionName === "shoot_self") return handleShot(interaction, game, true);
      if (actionName === "item") return handleItem(interaction, game, item);
      if (actionName === "rematch") return handleRematchButton(interaction, game);
      if (actionName === "close") return closeGameTicket(interaction, game);
    }

    if (scope === "rematch") {
      const actionName = action;
      const value = parts[2];
      const gameId = parts[3];
      const game = games.get(gameId);
      if (!game) return interaction.reply({ content: "That game no longer exists.", flags: MessageFlags.Ephemeral });

      if (interaction.channelId !== game.channelId) return interaction.reply({ content: "That game is in another ticket.", flags: MessageFlags.Ephemeral });

      const request = rematchRequests.get(game.id);
      if (!request) return interaction.reply({ content: "The rematch selection has expired or was already used.", flags: MessageFlags.Ephemeral });

      if (actionName === "cancel") {
        if (interaction.user.id !== request.initiatorId) {
          return interaction.reply({ content: "Only the player who opened the rematch choice can cancel it.", flags: MessageFlags.Ephemeral });
        }
        rematchRequests.delete(game.id);
        return interaction.update({
          components: [buildGamePanel(game)],
          flags: MessageFlags.IsComponentsV2
        });
      }

      if (actionName === "choose") {
        if (!DIFFICULTIES[value]) return interaction.reply({ content: "That difficulty is not available.", flags: MessageFlags.Ephemeral });
        try {
          await startRematch(game, value);
        } catch (error) {
          console.error("Buckshot rematch wager lock failed", game.id, error);
          return interaction.reply({
            content: error.message || "Both players need enough Envy wallet currency for the rematch.",
            flags: MessageFlags.Ephemeral
          });
        }
        rematchRequests.delete(game.id);
        await interaction.update({
          components: [buildGamePanel(game)],
          flags: MessageFlags.IsComponentsV2
        });
        await refreshGameMessage(game);
        await interaction.channel.send({
          components: [
            new ContainerBuilder()
              .setAccentColor(BLACK)
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `## REMATCH STARTED\n**Difficulty:** ${DIFFICULTIES[value].label}\n**Rounds:** ${DIFFICULTIES[value].rounds}\n**First turn:** <@${game.turnId}>`
                )
              )
          ],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: publicMentions([game.turnId])
        });
      }
    }
  } catch (error) {
    console.error(error);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: "Something went wrong while processing that action.", flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: "Something went wrong while processing that action.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

process.on("SIGTERM", async () => {
  console.log("Shutting down Buckshot bot...");
  if (pool) await pool.end().catch(() => {});
  client.destroy();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("Shutting down Buckshot bot...");
  if (pool) await pool.end().catch(() => {});
  client.destroy();
  process.exit(0);
});

if (!process.env.BOT_TOKEN) {
  console.error("BOT_TOKEN is missing. Create a .env file from .env.example.");
  process.exit(1);
}

client.login(process.env.BOT_TOKEN);
