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

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const challenges = new Map();
const games = new Map();
const activeUsers = new Map();

const BLACK = 0x000000;
const STARTING_HP = 4;
const MIN_ROUND_HP = 2;
const CHALLENGE_TIMEOUT_MS = 120_000;

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

function difficultyFor(game) {
  return DIFFICULTIES[game.difficulty];
}

function userName(game, userId) {
  return game.players[userId]?.displayName || game.players[userId]?.username || "Player";
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

function formatItems(player) {
  if (!player.items.length) return "None";

  const counts = new Map();
  for (const item of player.items) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([item, count]) => `${ITEM_INFO[item].symbol} ${ITEM_INFO[item].label}${count > 1 ? ` x${count}` : ""}`)
    .join("  ·  ");
}

function buildChallengePanel(challenge, state = "pending", ticketChannel = null) {
  const difficulty = DIFFICULTIES[challenge.difficulty];

  let heading;
  let status;

  if (state === "pending") {
    heading = "# BUCKSHOT — CHALLENGE";
    status = `<@${challenge.targetId}>, choose **Accept** or **Decline**. The challenger can **Cancel Request** at any time before you answer.`;
  } else if (state === "accepted") {
    heading = "# BUCKSHOT — ACCEPTED";
    status = `<@${challenge.targetId}> accepted the challenge. The private game ticket has been created: ${ticketChannel}`;
  } else if (state === "declined") {
    heading = "# BUCKSHOT — DECLINED";
    status = `<@${challenge.targetId}> declined the challenge from <@${challenge.challengerId}>.`;
  } else if (state === "cancelled") {
    heading = "# BUCKSHOT — CANCELLED";
    status = `<@${challenge.challengerId}> cancelled the challenge before it was accepted.`;
  } else {
    heading = "# BUCKSHOT — EXPIRED";
    status = "This challenge expired before a response was received.";
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
        `**Winner:** Not decided — the match decides the winner.`
      ),
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      new TextDisplayBuilder().setContent(status)
    );

  if (state === "pending") {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        actionButton(`challenge:accept:${challenge.id}`, "Accept", ButtonStyle.Secondary),
        actionButton(`challenge:decline:${challenge.id}`, "Decline", ButtonStyle.Secondary),
        actionButton(`challenge:cancel:${challenge.id}`, "Cancel Request", ButtonStyle.Danger)
      )
    );
  }

  return container;
}

function buildGamePanel(game) {
  const [p1, p2] = Object.values(game.players);
  const difficulty = difficultyFor(game);
  const turnName = game.finished ? "Match Finished" : userName(game, game.turnId);
  const winnerLine = game.finished
    ? `### Winner: ${userName(game, game.winnerId)}`
    : `### Turn: ${turnName}`;

  const chamberText = game.suddenDeath
    ? `${game.shells.length} shells remaining · Sudden Death`
    : `${game.shells.length} shells remaining`;

  const container = new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# BUCKSHOT\n**${difficulty.label}**  ·  **Round ${game.round}/${difficulty.rounds}**`
      ),
      new TextDisplayBuilder().setContent(
        `${winnerLine}\n\n` +
        `**${userName(game, p1.id)}**\n${heartDisplay(p1)}\n\n` +
        `**${userName(game, p2.id)}**\n${heartDisplay(p2)}\n\n` +
        `**Chamber:** ${chamberText}`
      ),
      new TextDisplayBuilder().setContent(
        game.finished
          ? `**Final result**\n${userName(game, p1.id)}: ${p1.hp}/${p1.maxHp} hearts\n${userName(game, p2.id)}: ${p2.hp}/${p2.maxHp} hearts`
          : `**${userName(game, game.turnId)}'s items**\n${formatItems(game.players[game.turnId])}`
      ),
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

    for (const item of current.items) {
      counts.set(item, (counts.get(item) || 0) + 1);
    }

    const visibleItems = [...counts.keys()].slice(0, 10);

    for (let i = 0; i < visibleItems.length; i += 5) {
      const row = new ActionRowBuilder();
      for (const item of visibleItems.slice(i, i + 5)) {
        const count = counts.get(item);
        row.addComponents(
          actionButton(
            `game:item:${item}:${game.id}`,
            `${ITEM_INFO[item].label}${count > 1 ? ` x${count}` : ""}`,
            ButtonStyle.Secondary
          )
        );
      }
      container.addActionRowComponents(row);
    }
  }

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      actionButton(`game:close:${game.id}`, "Close Ticket", ButtonStyle.Secondary)
    )
  );

  return container;
}

function buildGuidePanels() {
  const page1 = new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# BUCKSHOT — GAME GUIDE • 1/4"),
      new TextDisplayBuilder().setContent(
        "## What the game is\n" +
        "Buckshot is a private, two-player, turn-based chamber game. One player challenges another, the bot creates a private ticket after the challenge is accepted, and the entire match is played with buttons. The bot is the referee: it secretly stores the shell order, checks whose turn it is, tracks every heart, gives items, resolves damage, advances rounds, and announces the winner."
      ),
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      new TextDisplayBuilder().setContent(
        "## Starting a match\n" +
        "Run `/buckshot challenge @player difficulty:<difficulty>`. The challenge message identifies the **Challenger**, **Opponent**, **Difficulty**, **Rounds**, starting hearts, and the current winner status. The challenged player can press **Accept** or **Decline**. The challenger has a separate **Cancel Request** button, so a request can be withdrawn before it is accepted. Requests expire after 2 minutes if nobody answers."
      ),
      new TextDisplayBuilder().setContent(
        "## What happens after Accept\n" +
        "The bot creates a private text ticket under the Buckshot Tickets category. The two players and the bot can see it. The game starts immediately in that ticket. The opening message tells you the difficulty, total number of rounds, starting hearts, and which player receives the first turn."
      )
    );

  const page2 = new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# BUCKSHOT — GAME GUIDE • 2/4"),
      new TextDisplayBuilder().setContent(
        "## Hearts & rounds\n" +
        "Every match starts with **4 hearts per player**. A round is one complete chamber. When all shells in that chamber have been fired or ejected, the round ends. At the beginning of the next round, each player's **maximum hearts decreases by 1**, but never below **2 hearts**. Your current hearts are not refilled between rounds. For example, 4/4 can become 3/3 maximum health when Round 2 starts; later rounds can settle at the 2-heart minimum."
      ),
      new TextDisplayBuilder().setContent(
        "## Reading the hearts\n" +
        "The game panel always shows filled and empty heart symbols plus the exact number, such as `♥ ♥ ♥ ♡  3/4`. This means the player currently has 3 hearts and can have up to 4. If a later round lowers the maximum to 3, the panel changes to a 3-heart maximum. The health display is public to both players."
      ),
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      new TextDisplayBuilder().setContent(
        "## The chamber\n" +
        "At the beginning of each round, the bot secretly creates a randomized sequence containing **LIVE** and **BLANK** shells. You do not see the sequence. You only see how many shells remain. The exact next shell can be learned only through an item that reveals information. When the chamber reaches zero, the bot automatically creates the next round unless you have reached the final round."
      ),
      new TextDisplayBuilder().setContent(
        "## Taking a turn\n" +
        "Only the player whose name appears on the **Turn** line can interact with the shooting and item buttons. If the other player presses one, the bot rejects it. On a normal shot, the chamber's current shell is removed. A live shell deals damage; a blank deals no damage. Shooting the opponent normally passes the turn. Shooting yourself with a blank lets you keep the turn, which can be strategically valuable."
      )
    );

  const page3 = new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# BUCKSHOT — GAME GUIDE • 3/4"),
      new TextDisplayBuilder().setContent(
        "## Items\n" +
        "**Magnifier** — privately reveals whether the current shell is LIVE or BLANK. It does not remove the shell.\n" +
        "**Beer** — privately tells you the shell type and ejects that shell. The turn then passes.\n" +
        "**Cigarettes** — restores 1 heart, up to your current maximum, then the turn passes.\n" +
        "**Hand Saw** — arms your next LIVE shot for 2 damage instead of 1, then the turn passes.\n" +
        "**Handcuffs** — marks the opponent to lose their next turn.\n" +
        "**Burner Phone** — privately reveals the type of a random future shell, then the turn passes.\n" +
        "**Inverter** — flips the current shell from LIVE to BLANK or BLANK to LIVE, then the turn passes.\n" +
        "**Adrenaline** — steals one random item from the opponent, then the turn passes."
      ),
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      new TextDisplayBuilder().setContent(
        "## Important item behavior\n" +
        "Private information from Magnifier and Burner Phone is shown only to the player who used the item. Public game state is updated in the main game panel. Items are consumed when successfully used. If an item cannot be used because the required chamber state is unavailable, the bot can return the item instead of silently deleting it."
      ),
      new TextDisplayBuilder().setContent(
        "## Strategy basics\n" +
        "You are balancing two kinds of information: health and shell knowledge. A known blank can let you safely choose a self-shot and keep control of the turn. A known live shell can force a risky decision or make the Hand Saw valuable. Ejecting a shell can remove information you do not want the opponent to exploit, while an Inverter can change a known result before someone fires it."
      )
    );

  const page4 = new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# BUCKSHOT — GAME GUIDE • 4/4"),
      new TextDisplayBuilder().setContent(
        "## Difficulties\n" +
        "**Easy — 2 rounds:** smaller chambers and a smaller item pool. Built for quick matches.\n" +
        "**Normal — 4 rounds:** the standard match length with a wider item pool.\n" +
        "**Hard — 6 rounds:** longer survival, larger chambers, more dangerous shell ratios, and advanced items.\n" +
        "**Extreme — 8 rounds:** the longest standard match, largest chambers, the broadest item pool, and the most pressure from shrinking maximum hearts."
      ),
      new TextDisplayBuilder().setContent(
        "## How a player wins\n" +
        "There are two normal ways to win. First, if your opponent reaches **0 hearts**, they are eliminated immediately and you win. Second, if the final scheduled round ends while both players are still alive, the bot compares their remaining hearts. The player with more hearts wins the match. If the final round ends in an exact health tie, the bot starts **Sudden Death**: both players are placed at 1 heart and a short chamber is loaded. The first elimination decides the winner, so there is no draw."
      ),
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      new TextDisplayBuilder().setContent(
        "## Ending a ticket\n" +
        "The final game panel displays the winner and the final health totals. A separate result message identifies the **Winner** and the defeated player. Once the match is over, either player can press **Close Ticket** to remove the private game channel. A moderator with Manage Channels permission can also close it."
      ),
      new TextDisplayBuilder().setContent(
        "## Commands\n" +
        "`/buckshot challenge @player difficulty:<difficulty>` — send a challenge.\n" +
        "`/buckshot guide` — open this detailed guide.\n" +
        "`/buckshot rules` — legacy alias that opens the same guide.\n\n" +
        "The game itself does not require typed commands after the ticket opens; use the buttons in the black Components V2 panel."
      )
    );

  return [page1, page2, page3, page4];
}

function buildResultPanel(game, reason = "") {
  const winner = game.players[game.winnerId];
  const loserId = oppositePlayerId(game, game.winnerId);
  const loser = game.players[loserId];

  return new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# BUCKSHOT — GAME OVER"),
      new TextDisplayBuilder().setContent(
        `${reason ? `${reason}\n\n` : ""}` +
        `**Winner:** ${userName(game, winner.id)}\n` +
        `**Defeated:** ${userName(game, loser.id)}\n\n` +
        `**Final health**\n` +
        `${userName(game, winner.id)} — ${heartDisplay(winner)}\n` +
        `${userName(game, loser.id)} — ${heartDisplay(loser)}\n\n` +
        `**Difficulty:** ${difficultyFor(game).label}`
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
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      }
    ]
  });
}

async function createGameTicket(guild, challenge) {
  const category = await getOrCreateTicketCategory(guild);
  const gameId = `${Date.now()}_${challenge.id}`;
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
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      {
        id: challenge.challengerId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      },
      {
        id: challenge.targetId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages
        ]
      }
    ]
  });

  const game = {
    id: gameId,
    channelId: channel.id,
    challengerId: challenge.challengerId,
    targetId: challenge.targetId,
    difficulty: challenge.difficulty,
    round: 1,
    roundStartedAt: Date.now(),
    turnId: Math.random() < 0.5 ? challenge.challengerId : challenge.targetId,
    shells: [],
    players: {
      [challenge.challengerId]: {
        id: challenge.challengerId,
        hp: STARTING_HP,
        maxHp: STARTING_HP,
        items: [],
        sawArmed: false
      },
      [challenge.targetId]: {
        id: challenge.targetId,
        hp: STARTING_HP,
        maxHp: STARTING_HP,
        items: [],
        sawArmed: false
      }
    },
    skippedTurn: new Set(),
    finished: false,
    winnerId: null,
    suddenDeath: false,
    messageId: null
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

  await channel.send({
    components: [
      new ContainerBuilder()
        .setAccentColor(BLACK)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## Match Started\n` +
            `**Challenger:** <@${game.challengerId}>\n` +
            `**Opponent:** <@${game.targetId}>\n` +
            `**Difficulty:** ${DIFFICULTIES[game.difficulty].label}\n` +
            `**Rounds:** ${DIFFICULTIES[game.difficulty].rounds}\n` +
            `**Starting hearts:** ${STARTING_HP} each\n` +
            `**First turn:** <@${game.turnId}>\n\n` +
            "The winner is determined by elimination or final-round health."
          )
        )
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { users: [game.challengerId, game.targetId, game.turnId] }
  });

  return { channel, game };
}

async function refreshGameMessage(game) {
  const channel = await client.channels.fetch(game.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const message = await channel.messages.fetch(game.messageId).catch(() => null);
  if (!message) return;

  await message.edit({
    components: [buildGamePanel(game)],
    flags: MessageFlags.IsComponentsV2
  });
}

function finishGame(game, winnerId) {
  game.finished = true;
  game.winnerId = winnerId;
  activeUsers.delete(game.challengerId);
  activeUsers.delete(game.targetId);
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

function determineFinalWinner(game) {
  const [p1, p2] = Object.values(game.players);
  if (p1.hp > p2.hp) return p1.id;
  if (p2.hp > p1.hp) return p2.id;
  return null;
}

function beginSuddenDeath(game) {
  game.suddenDeath = true;
  game.round += 1;

  for (const player of Object.values(game.players)) {
    player.maxHp = 1;
    player.hp = 1;
    player.items = [];
    player.sawArmed = false;
  }

  game.shells = shuffle(["live", "blank", "live", "blank"]);
}

function advanceRoundOrFinish(game) {
  if (game.finished) return { type: "finished" };

  const difficulty = difficultyFor(game);

  if (game.suddenDeath) return { type: "none" };

  if (game.round >= difficulty.rounds) {
    const winnerId = determineFinalWinner(game);

    if (winnerId) {
      finishGame(game, winnerId);
      return { type: "finished" };
    }

    beginSuddenDeath(game);
    return { type: "sudden_death" };
  }

  game.round += 1;
  prepareRound(game);
  return { type: "next_round" };
}

async function announceRoundChange(channel, game, result, reason = "") {
  if (result.type === "next_round") {
    const difficulty = difficultyFor(game);
    await channel.send({
      components: [
        new ContainerBuilder()
          .setAccentColor(BLACK)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `## Round ${game.round} Begins\n` +
              `${reason ? `${reason}\n\n` : ""}` +
              `**Difficulty:** ${difficulty.label}\n` +
              `**Round:** ${game.round}/${difficulty.rounds}\n` +
              `Each player's maximum hearts dropped by 1, down to a minimum of ${MIN_ROUND_HP}.\n\n` +
              `**${userName(game, game.challengerId)}:** ${heartDisplay(game.players[game.challengerId])}\n` +
              `**${userName(game, game.targetId)}:** ${heartDisplay(game.players[game.targetId])}\n\n` +
              `<@${game.turnId}> starts the new round.`
            )
          )
      ],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { users: [game.turnId] }
    });
  }

  if (result.type === "sudden_death") {
    await channel.send({
      components: [
        new ContainerBuilder()
          .setAccentColor(BLACK)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `## Sudden Death\n${reason ? `${reason}\n\n` : ""}` +
              "The final scheduled round ended in a health tie. Both players are now at **1 heart**. A short chamber has been loaded. The next elimination decides the winner."
            )
          )
      ],
      flags: MessageFlags.IsComponentsV2
    });
  }
}

async function resolveRoundIfEmpty(interaction, game, reason = "") {
  if (game.shells.length > 0) return false;

  const result = advanceRoundOrFinish(game);

  if (result.type === "finished") {
    await interaction.channel.send({
      components: [buildResultPanel(game, reason)],
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

async function handleShot(interaction, game, targetSelf) {
  if (game.finished) {
    return interaction.reply({ content: "This game is already finished.", flags: MessageFlags.Ephemeral });
  }

  if (interaction.user.id !== game.turnId) {
    return interaction.reply({ content: "It is not your turn.", flags: MessageFlags.Ephemeral });
  }

  if (!game.shells.length) {
    const result = advanceRoundOrFinish(game);
    await refreshGameMessage(game);
    return interaction.reply({
      content: result.type === "finished" ? "The match has finished." : "The next round has already started. The game panel was refreshed.",
      flags: MessageFlags.Ephemeral
    });
  }

  const shooter = game.players[game.turnId];
  const opponentId = oppositePlayerId(game, game.turnId);
  const targetId = targetSelf ? game.turnId : opponentId;
  const target = game.players[targetId];

  const shell = game.shells.shift();
  const damage = shell === "live" ? (shooter.sawArmed ? 2 : 1) : 0;
  shooter.sawArmed = false;

  let resultText;

  if (shell === "live") {
    target.hp = Math.max(0, target.hp - damage);
    resultText = `**${userName(game, game.turnId)}** fired a **LIVE** shell at **${userName(game, targetId)}** and dealt **${damage} damage**.`;
  } else {
    resultText = `**${userName(game, game.turnId)}** fired a **BLANK** shell${targetSelf ? " at themselves" : " at the opponent"}.`;
  }

  if (target.hp <= 0) {
    finishGame(game, shooter.id);

    await interaction.update({
      components: [buildGamePanel(game)],
      flags: MessageFlags.IsComponentsV2
    });

    await interaction.channel.send({
      components: [buildResultPanel(game, resultText)],
      flags: MessageFlags.IsComponentsV2
    });
    return;
  }

  if (!(shell === "blank" && targetSelf)) {
    const skipped = passTurn(game, game.turnId);
    if (skipped) resultText += ` **${userName(game, opponentId)}'s turn was skipped.**`;
  }

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

  const roundEnded = await resolveRoundIfEmpty(interaction, game, resultText);
  if (!roundEnded) await refreshGameMessage(game);
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

async function handleItem(interaction, game, item) {
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
  const opponentId = oppositePlayerId(game, interaction.user.id);
  const opponent = game.players[opponentId];

  if (item === "magnifier") {
    if (!game.shells.length) {
      player.items.push(item);
      return privateItemResult(interaction, "Magnifier", "The chamber is empty. The item was returned to you.");
    }
    await privateItemResult(interaction, "Magnifier", `The current shell is **${shellLabel(game.shells[0])}**.`);
    await refreshGameMessage(game);
    return;
  }

  if (item === "beer") {
    if (!game.shells.length) {
      player.items.push(item);
      return privateItemResult(interaction, "Beer", "The chamber is empty. The item was returned to you.");
    }
    const shell = game.shells.shift();
    await privateItemResult(interaction, "Beer", `You ejected a **${shellLabel(shell)}** shell.`);
    passTurn(game, interaction.user.id);
    if (await resolveRoundIfEmpty(interaction, game, `${userName(game, interaction.user.id)} ejected the final shell of the round.`)) return;
    await refreshGameMessage(game);
    return;
  }

  if (item === "cigarettes") {
    const before = player.hp;
    player.hp = Math.min(player.maxHp, player.hp + 1);
    await privateItemResult(interaction, "Cigarettes", `You restored **${plural(player.hp - before, "heart")}**.`);
    passTurn(game, interaction.user.id);
    await refreshGameMessage(game);
    return;
  }

  if (item === "saw") {
    player.sawArmed = true;
    await privateItemResult(interaction, "Hand Saw", "Your next **LIVE** shot deals **2 damage**. The turn passes after arming it.");
    passTurn(game, interaction.user.id);
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
        ? `The opponent's pending skipped turn was consumed immediately. **${userName(game, game.turnId)}** retains the turn.`
        : `**${userName(game, opponentId)}** will lose their next turn.`
    );
    await refreshGameMessage(game);
    return;
  }

  if (item === "phone") {
    if (game.shells.length < 2) {
      player.items.push(item);
      return privateItemResult(interaction, "Burner Phone", "There are not enough shells ahead for a future reading. The item was returned to you.");
    }

    const maxLookAhead = Math.min(3, game.shells.length - 1);
    const position = 1 + Math.floor(Math.random() * maxLookAhead);
    const shell = game.shells[position];

    await privateItemResult(
      interaction,
      "Burner Phone",
      `A shell **${position + 1} positions ahead** is **${shellLabel(shell)}**.`
    );

    passTurn(game, interaction.user.id);
    await refreshGameMessage(game);
    return;
  }

  if (item === "inverter") {
    if (!game.shells.length) {
      player.items.push(item);
      return privateItemResult(interaction, "Inverter", "The chamber is empty. The item was returned to you.");
    }

    game.shells[0] = game.shells[0] === "live" ? "blank" : "live";
    await privateItemResult(interaction, "Inverter", "The current shell has been flipped.");
    passTurn(game, interaction.user.id);
    await refreshGameMessage(game);
    return;
  }

  if (item === "adrenaline") {
    if (!opponent.items.length) {
      player.items.push(item);
      return privateItemResult(interaction, "Adrenaline", "The opponent has no item to steal, so Adrenaline was returned to you.");
    }

    const stolenIndex = Math.floor(Math.random() * opponent.items.length);
    const stolen = opponent.items.splice(stolenIndex, 1)[0];
    player.items.push(stolen);

    await privateItemResult(interaction, "Adrenaline", `You stole **${ITEM_INFO[stolen].label}**.`);
    passTurn(game, interaction.user.id);
    await refreshGameMessage(game);
    return;
  }

  player.items.push(item);
  return interaction.reply({
    content: "That item is not implemented yet, so it was returned to you.",
    flags: MessageFlags.Ephemeral
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

  activeUsers.delete(game.challengerId);
  activeUsers.delete(game.targetId);
  games.delete(game.id);

  await interaction.reply({
    content: "Closing the Buckshot ticket...",
    flags: MessageFlags.Ephemeral
  });

  await sleep(700);
  await interaction.channel.delete("Buckshot game closed");
}

async function updateChallengeAsCancelled(interaction, challenge, state, messageText) {
  challenges.delete(challenge.id);

  await interaction.update({
    components: [buildChallengePanel(challenge, state, null)],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { users: [challenge.challengerId, challenge.targetId] }
  });

  return messageText;
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "buckshot") return;

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === "guide" || subcommand === "rules") {
        for (const panel of buildGuidePanels()) {
          await interaction.channel.send({
            components: [panel],
            flags: MessageFlags.IsComponentsV2
          });
        }
        return interaction.reply({
          content: "The full Buckshot guide has been posted in this channel.",
          flags: MessageFlags.Ephemeral
        });
      }

      if (subcommand === "challenge") {
        const target = interaction.options.getUser("player", true);
        const difficulty = interaction.options.getString("difficulty", true);
        const challenger = interaction.user;

        if (!DIFFICULTIES[difficulty]) {
          return interaction.reply({ content: "That difficulty is not available.", flags: MessageFlags.Ephemeral });
        }
        if (target.bot) {
          return interaction.reply({ content: "You cannot challenge a bot.", flags: MessageFlags.Ephemeral });
        }
        if (target.id === challenger.id) {
          return interaction.reply({ content: "You cannot challenge yourself.", flags: MessageFlags.Ephemeral });
        }
        if (activeUsers.has(challenger.id)) {
          return interaction.reply({ content: "You are already in a Buckshot game.", flags: MessageFlags.Ephemeral });
        }
        if (activeUsers.has(target.id)) {
          return interaction.reply({ content: "That player is already in a Buckshot game.", flags: MessageFlags.Ephemeral });
        }

        const duplicate = [...challenges.values()].find(
          c => c.guildId === interaction.guildId &&
            ((c.challengerId === challenger.id && c.targetId === target.id) ||
             (c.challengerId === target.id && c.targetId === challenger.id))
        );

        if (duplicate) {
          return interaction.reply({
            content: "There is already a pending Buckshot challenge between these players.",
            flags: MessageFlags.Ephemeral
          });
        }

        const challenge = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          guildId: interaction.guildId,
          challengerId: challenger.id,
          targetId: target.id,
          difficulty,
          channelId: interaction.channelId
        };

        challenges.set(challenge.id, challenge);

        await interaction.reply({
          components: [buildChallengePanel(challenge)],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { users: [challenger.id, target.id] }
        });

        setTimeout(() => {
          if (!challenges.has(challenge.id)) return;
          challenges.delete(challenge.id);

          client.channels.fetch(challenge.channelId)
            .then(async channel => {
              if (!channel?.isTextBased()) return;
              const messages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
              const pending = messages?.find(
                message => message.author.id === client.user.id &&
                  message.components?.some(row => row.components?.some(component => component.customId === `challenge:accept:${challenge.id}`))
              );
              if (!pending) return;

              await pending.edit({
                components: [buildChallengePanel(challenge, "expired")],
                flags: MessageFlags.IsComponentsV2
              }).catch(() => {});
            })
            .catch(() => {});
        }, CHALLENGE_TIMEOUT_MS);
      }
    }

    if (!interaction.isButton()) return;

    const parts = interaction.customId.split(":");
    const scope = parts[0];
    const action = parts[1];

    if (scope === "challenge") {
      const challengeId = parts[2];
      const challenge = challenges.get(challengeId);

      if (!challenge) {
        return interaction.reply({ content: "That challenge is no longer active.", flags: MessageFlags.Ephemeral });
      }

      if (action === "cancel") {
        if (interaction.user.id !== challenge.challengerId) {
          return interaction.reply({ content: "Only the challenger can cancel this request.", flags: MessageFlags.Ephemeral });
        }

        challenges.delete(challenge.id);
        return interaction.update({
          components: [buildChallengePanel(challenge, "cancelled")],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { users: [challenge.challengerId, challenge.targetId] }
        });
      }

      if (interaction.user.id !== challenge.targetId) {
        return interaction.reply({ content: "Only the challenged player can accept or decline this.", flags: MessageFlags.Ephemeral });
      }

      if (action === "accept") {
        if (activeUsers.has(challenge.challengerId) || activeUsers.has(challenge.targetId)) {
          challenges.delete(challenge.id);
          return interaction.update({
            components: [buildChallengePanel(challenge, "cancelled")],
            flags: MessageFlags.IsComponentsV2
          });
        }

        challenges.delete(challenge.id);
        const { channel } = await createGameTicket(interaction.guild, challenge);

        return interaction.update({
          components: [buildChallengePanel(challenge, "accepted", channel.toString())],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { users: [challenge.challengerId, challenge.targetId] }
        });
      }

      if (action === "decline") {
        challenges.delete(challenge.id);
        return interaction.update({
          components: [buildChallengePanel(challenge, "declined")],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { users: [challenge.challengerId, challenge.targetId] }
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

      if (!game) {
        return interaction.reply({ content: "This game no longer exists.", flags: MessageFlags.Ephemeral });
      }

      if (interaction.channelId !== game.channelId) {
        return interaction.reply({ content: "That game is in another ticket.", flags: MessageFlags.Ephemeral });
      }

      if (actionName === "shoot_enemy") return handleShot(interaction, game, false);
      if (actionName === "shoot_self") return handleShot(interaction, game, true);
      if (actionName === "item") return handleItem(interaction, game, item);
      if (actionName === "close") return closeGameTicket(interaction, game);
    }
  } catch (error) {
    console.error(error);

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: "Something went wrong while processing that action.",
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    } else {
      await interaction.reply({
        content: "Something went wrong while processing that action.",
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
  }
});

client.login(process.env.BOT_TOKEN);
