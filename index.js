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

// challengeId -> challenge
const challenges = new Map();

// gameId -> game
const games = new Map();

// userId -> gameId
const activeUsers = new Map();

const BLACK = 0x000000;
const MAX_HP = 4;
const CHALLENGE_TIMEOUT_MS = 60_000;

const ITEM_INFO = {
  magnifier: { label: "Magnifier", emoji: "⌕" },
  beer: { label: "Beer", emoji: "−" },
  cigarettes: { label: "Cigarettes", emoji: "＋" },
  saw: { label: "Hand Saw", emoji: "⌁" },
  handcuffs: { label: "Handcuffs", emoji: "∥" },
  phone: { label: "Burner Phone", emoji: "⌂" },
  inverter: { label: "Inverter", emoji: "↕" },
  adrenaline: { label: "Adrenaline", emoji: "◇" }
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

function hpBar(hp) {
  return `${"■".repeat(Math.max(0, hp))}${"□".repeat(Math.max(0, MAX_HP - hp))} ${hp}/${MAX_HP}`;
}

function userName(game, userId) {
  return game.players[userId]?.displayName || game.players[userId]?.username || "Player";
}

function shellLabel(shell) {
  return shell === "live" ? "LIVE" : "BLANK";
}

function randomShells() {
  // A compact, game-friendly chamber: 6–8 shells, mixed whenever possible.
  const count = 6 + Math.floor(Math.random() * 3);
  let liveCount = 1 + Math.floor(Math.random() * (count - 1));
  let blankCount = count - liveCount;

  // Avoid an extreme chamber on purpose.
  if (liveCount === 0) liveCount = 1;
  if (blankCount === 0) blankCount = 1;

  return shuffle([
    ...Array.from({ length: liveCount }, () => "live"),
    ...Array.from({ length: blankCount }, () => "blank")
  ]);
}

function giveRoundItems(game) {
  for (const playerId of Object.keys(game.players)) {
    const amount = 2 + Math.floor(Math.random() * 3);
    const possible = Object.keys(ITEM_INFO);

    for (let i = 0; i < amount; i++) {
      const item = possible[Math.floor(Math.random() * possible.length)];
      game.players[playerId].items.push(item);
    }
  }
}

function formatItems(player) {
  if (!player.items.length) return "None";

  return player.items
    .map(item => `${ITEM_INFO[item].emoji} ${ITEM_INFO[item].label}`)
    .join("  ·  ");
}

function actionButton(customId, label, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}

function buildChallengePanel(challenge, acceptedChannel = null) {
  const target = `<@${challenge.targetId}>`;
  const challenger = `<@${challenge.challengerId}>`;

  const container = new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# BUCKSHOT"),
      new TextDisplayBuilder().setContent(
        acceptedChannel
          ? `### Challenge Accepted\n${target} accepted the challenge from ${challenger}.\n\nGame ticket: ${acceptedChannel}`
          : `### Incoming Challenge\n${challenger} has challenged ${target}.\n\n${target}, choose whether to accept.`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        actionButton(
          `challenge:accept:${challenge.id}`,
          "Accept",
          ButtonStyle.Secondary,
          Boolean(acceptedChannel)
        ),
        actionButton(
          `challenge:decline:${challenge.id}`,
          "Decline",
          ButtonStyle.Secondary,
          Boolean(acceptedChannel)
        )
      )
    );

  return container;
}

function buildGamePanel(game) {
  const p1 = Object.values(game.players)[0];
  const p2 = Object.values(game.players)[1];

  const turnName = userName(game, game.turnId);
  const chamberText = game.shells.length
    ? `${game.shells.length} shell${game.shells.length === 1 ? "" : "s"} remaining`
    : "Reloading...";

  const turnText = game.finished
    ? `### ${userName(game, game.winnerId)} wins`
    : `### ${turnName}'s turn`;

  const container = new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# BUCKSHOT"),
      new TextDisplayBuilder().setContent(
        `${turnText}\n\n` +
        `**${userName(game, p1.id)}**\n${hpBar(p1.hp)}\n\n` +
        `**${userName(game, p2.id)}**\n${hpBar(p2.hp)}\n\n` +
        `**Chamber:** ${chamberText}`
      ),
      new TextDisplayBuilder().setContent(
        `**${userName(game, game.turnId)}'s items**\n${formatItems(game.players[game.turnId])}`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );

  const playerActive = !game.finished;

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      actionButton(
        `game:shoot_enemy:${game.id}`,
        "Shoot Opponent",
        ButtonStyle.Secondary,
        !playerActive
      ),
      actionButton(
        `game:shoot_self:${game.id}`,
        "Shoot Self",
        ButtonStyle.Danger,
        !playerActive
      )
    )
  );

  const itemRows = [];
  const counts = new Map();
  for (const item of game.players[game.turnId].items) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  const visibleItems = [...counts.keys()];

  // Up to two action rows of items, five buttons each.
  for (let i = 0; i < visibleItems.length && i < 10; i += 5) {
    const rowItems = visibleItems.slice(i, i + 5);
    const row = new ActionRowBuilder();

    for (const item of rowItems) {
      row.addComponents(
        actionButton(
          `game:item:${item}:${game.id}`,
          ITEM_INFO[item].label,
          ButtonStyle.Secondary,
          !playerActive
        )
      );
    }

    itemRows.push(row);
  }

  for (const row of itemRows) {
    container.addActionRowComponents(row);
  }

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      actionButton(`game:close:${game.id}`, "Close Ticket", ButtonStyle.Secondary, false)
    )
  );

  return container;
}

function buildRulesPanel() {
  return new ContainerBuilder()
    .setAccentColor(BLACK)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# BUCKSHOT — RULES"),
      new TextDisplayBuilder().setContent(
        "Two players enter a private ticket. A chamber contains live and blank shells in a hidden order.\n\n" +
        "Shoot the opponent to damage them. Shoot yourself with a blank to keep your turn. " +
        "A live shell deals damage and normally passes the turn.\n\n" +
        "**Items**\n" +
        "⌕ Magnifier — privately reveals the current shell.\n" +
        "− Beer — ejects the current shell.\n" +
        "＋ Cigarettes — restores 1 HP.\n" +
        "⌁ Hand Saw — your next live shot deals +1 damage.\n" +
        "∥ Handcuffs — opponent loses their next turn.\n" +
        "⌂ Burner Phone — privately reveals a future shell.\n" +
        "↕ Inverter — flips the current shell.\n" +
        "◇ Adrenaline — steals a random item from the opponent."
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

  const channel = await guild.channels.create({
    name: `buckshot-${challengerMember.user.username}-${targetMember.user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 90),
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Buckshot game ${gameId}`,
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
    turnId: Math.random() < 0.5 ? challenge.challengerId : challenge.targetId,
    shells: randomShells(),
    players: {
      [challenge.challengerId]: {
        id: challenge.challengerId,
        hp: MAX_HP,
        items: [],
        sawArmed: false
      },
      [challenge.targetId]: {
        id: challenge.targetId,
        hp: MAX_HP,
        items: [],
        sawArmed: false
      }
    },
    skippedTurn: new Set(),
    finished: false,
    winnerId: null,
    messageId: null
  };

  giveRoundItems(game);
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
            `## Game Started\n<@${game.challengerId}> vs <@${game.targetId}>\n\n` +
            `<@${game.turnId}> goes first.\nAll shots, items and game state are controlled by the buttons above.`
          )
        )
    ],
    flags: MessageFlags.IsComponentsV2
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

function checkWinner(game) {
  const players = Object.values(game.players);
  const dead = players.find(player => player.hp <= 0);

  if (!dead) return false;

  const winner = players.find(player => player.id !== dead.id);
  finishGame(game, winner.id);
  return true;
}

function reloadIfNeeded(game) {
  if (game.shells.length > 0) return false;

  game.shells = randomShells();
  giveRoundItems(game);
  return true;
}

function passTurn(game, fromId) {
  let nextId = fromId === game.challengerId ? game.targetId : game.challengerId;

  if (game.skippedTurn.has(nextId)) {
    game.skippedTurn.delete(nextId);
    nextId = fromId;
  }

  game.turnId = nextId;
}

async function handleShot(interaction, game, targetSelf) {
  if (game.finished) {
    return interaction.reply({
      content: "This game is already finished.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (interaction.user.id !== game.turnId) {
    return interaction.reply({
      content: "It is not your turn.",
      flags: MessageFlags.Ephemeral
    });
  }

  reloadIfNeeded(game);

  const shooter = game.players[game.turnId];
  const opponentId = game.turnId === game.challengerId ? game.targetId : game.challengerId;
  const targetId = targetSelf ? game.turnId : opponentId;
  const target = game.players[targetId];

  const shell = game.shells.shift();
  const damage = shell === "live" ? (shooter.sawArmed ? 2 : 1) : 0;
  shooter.sawArmed = false;

  let text;

  if (shell === "live") {
    target.hp -= damage;
    text = `**${userName(game, game.turnId)}** fired a **LIVE** shell at **${userName(game, targetId)}** and dealt **${damage} damage**.`;
  } else {
    text = `**${userName(game, game.turnId)}** fired a **BLANK** shell.`;
  }

  if (checkWinner(game)) {
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
              `## Game Over\n${text}\n\n**${userName(game, game.winnerId)} wins.**`
            )
          )
      ],
      flags: MessageFlags.IsComponentsV2
    });

    return;
  }

  if (!(shell === "blank" && targetSelf)) {
    const oldTurn = game.turnId;
    passTurn(game, oldTurn);

    if (game.turnId === oldTurn && game.skippedTurn.has(opponentId) === false) {
      text += ` **The next turn was skipped.**`;
    }
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
          new TextDisplayBuilder().setContent(text)
        )
    ],
    flags: MessageFlags.IsComponentsV2
  });

  reloadIfNeeded(game);
  await refreshGameMessage(game);
}

async function handleItem(interaction, game, item) {
  if (game.finished) {
    return interaction.reply({
      content: "This game is already finished.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (interaction.user.id !== game.turnId) {
    return interaction.reply({
      content: "It is not your turn.",
      flags: MessageFlags.Ephemeral
    });
  }

  const player = game.players[interaction.user.id];
  const itemIndex = player.items.indexOf(item);

  if (itemIndex === -1) {
    return interaction.reply({
      content: "You do not have that item.",
      flags: MessageFlags.Ephemeral
    });
  }

  player.items.splice(itemIndex, 1);

  const opponentId =
    interaction.user.id === game.challengerId
      ? game.targetId
      : game.challengerId;
  const opponent = game.players[opponentId];

  if (item === "magnifier") {
    reloadIfNeeded(game);
    const shell = game.shells[0];

    // Private V2 response so the opponent cannot see the information.
    await interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(BLACK)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `## Magnifier\nThe current shell is **${shellLabel(shell)}**.`
            )
          )
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    });

  } else if (item === "beer") {
    reloadIfNeeded(game);
    const shell = game.shells.shift();

    await interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(BLACK)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `## Beer\nYou ejected a **${shellLabel(shell)}** shell.`
            )
          )
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    });

    // Ejecting a shell passes the turn.
    passTurn(game, interaction.user.id);
    reloadIfNeeded(game);
    await refreshGameMessage(game);

  } else if (item === "cigarettes") {
    const before = player.hp;
    player.hp = Math.min(MAX_HP, player.hp + 1);

    await interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(BLACK)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `## Cigarettes\nYou restored **${player.hp - before} HP**.`
            )
          )
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    });

    // Healing uses the turn.
    passTurn(game, interaction.user.id);
    await refreshGameMessage(game);

  } else if (item === "saw") {
    player.sawArmed = true;

    await interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(BLACK)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "## Hand Saw\nYour next **LIVE** shot deals **2 damage**."
            )
          )
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    });

    // Saw arms the next shot but still consumes the turn.
    passTurn(game, interaction.user.id);
    await refreshGameMessage(game);

  } else if (item === "handcuffs") {
    game.skippedTurn.add(opponentId);

    await interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(BLACK)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `## Handcuffs\n**${userName(game, opponentId)}** will lose their next turn.`
            )
          )
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    });

    game.turnId = opponentId;
    await refreshGameMessage(game);

  } else if (item === "phone") {
    if (game.shells.length < 2) reloadIfNeeded(game);

    const maxLookAhead = Math.min(3, Math.max(0, game.shells.length - 1));
    const position = maxLookAhead === 0
      ? 0
      : 1 + Math.floor(Math.random() * maxLookAhead);

    const shell = game.shells[position];

    await interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(BLACK)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `## Burner Phone\nA shell **${position + 1} positions ahead** is **${shellLabel(shell)}**.`
            )
          )
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    });

    passTurn(game, interaction.user.id);
    await refreshGameMessage(game);

  } else if (item === "inverter") {
    reloadIfNeeded(game);

    game.shells[0] = game.shells[0] === "live" ? "blank" : "live";

    await interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(BLACK)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "## Inverter\nThe current shell has been flipped."
            )
          )
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    });

    passTurn(game, interaction.user.id);
    await refreshGameMessage(game);

  } else if (item === "adrenaline") {
    if (!opponent.items.length) {
      player.items.push(item);
      return interaction.reply({
        components: [
          new ContainerBuilder()
            .setAccentColor(BLACK)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                "## Adrenaline\nThe opponent has no item to steal, so Adrenaline was returned to you."
              )
            )
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      });
    }

    const stolenIndex = Math.floor(Math.random() * opponent.items.length);
    const stolen = opponent.items.splice(stolenIndex, 1)[0];
    player.items.push(stolen);

    await interaction.reply({
      components: [
        new ContainerBuilder()
          .setAccentColor(BLACK)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `## Adrenaline\nYou stole **${ITEM_INFO[stolen].label}**.`
            )
          )
      ],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
    });

    passTurn(game, interaction.user.id);
    await refreshGameMessage(game);
  }
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

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "buckshot") return;

      if (interaction.options.getSubcommand() === "rules") {
        return interaction.reply({
          components: [buildRulesPanel()],
          flags: MessageFlags.IsComponentsV2
        });
      }

      if (interaction.options.getSubcommand() === "challenge") {
        const target = interaction.options.getUser("player", true);
        const challenger = interaction.user;

        if (target.bot) {
          return interaction.reply({
            content: "You cannot challenge a bot.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (target.id === challenger.id) {
          return interaction.reply({
            content: "You cannot challenge yourself.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (activeUsers.has(challenger.id)) {
          return interaction.reply({
            content: "You are already in a Buckshot game.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (activeUsers.has(target.id)) {
          return interaction.reply({
            content: "That player is already in a Buckshot game.",
            flags: MessageFlags.Ephemeral
          });
        }

        const duplicate = [...challenges.values()].find(
          c =>
            c.guildId === interaction.guildId &&
            c.challengerId === challenger.id &&
            c.targetId === target.id
        );

        if (duplicate) {
          return interaction.reply({
            content: "You already have a pending challenge against that player.",
            flags: MessageFlags.Ephemeral
          });
        }

        const challenge = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          guildId: interaction.guildId,
          challengerId: challenger.id,
          targetId: target.id,
          channelId: interaction.channelId
        };

        challenges.set(challenge.id, challenge);

        const challengePingPanel = new ContainerBuilder()
          .setAccentColor(BLACK)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`<@${challenger.id}> <@${target.id}>`),
            new TextDisplayBuilder().setContent(
              `# BUCKSHOT\n### Incoming Challenge\n` +
              `<@${challenger.id}> has challenged <@${target.id}>.\n\n` +
              `<@${target.id}>, choose whether to accept.`
            )
          )
          .addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
          )
          .addActionRowComponents(
            new ActionRowBuilder().addComponents(
              actionButton(`challenge:accept:${challenge.id}`, "Accept", ButtonStyle.Secondary),
              actionButton(`challenge:decline:${challenge.id}`, "Decline", ButtonStyle.Secondary)
            )
          );

        await interaction.reply({
          components: [challengePingPanel],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: {
            users: [challenger.id, target.id]
          }
        });

        setTimeout(() => {
          if (challenges.has(challenge.id)) {
            challenges.delete(challenge.id);
          }
        }, CHALLENGE_TIMEOUT_MS);
      }
    }

    if (interaction.isButton()) {
      const [scope, action, value, extra] = interaction.customId.split(":");

      if (scope === "challenge") {
        const challenge = challenges.get(value);

        if (!challenge) {
          return interaction.reply({
            content: "That challenge has expired.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (interaction.user.id !== challenge.targetId) {
          return interaction.reply({
            content: "Only the challenged player can answer this.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (action === "accept") {
          if (activeUsers.has(challenge.challengerId) || activeUsers.has(challenge.targetId)) {
            challenges.delete(challenge.id);
            return interaction.update({
              components: [
                new ContainerBuilder()
                  .setAccentColor(BLACK)
                  .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                      "## Challenge Cancelled\nOne of the players is already in another game."
                    )
                  )
              ],
              flags: MessageFlags.IsComponentsV2
            });
          }

          challenges.delete(challenge.id);

          const { channel } = await createGameTicket(interaction.guild, challenge);

          await interaction.update({
            components: [buildChallengePanel(challenge, channel.toString())],
            flags: MessageFlags.IsComponentsV2
          });

          return;
        }

        if (action === "decline") {
          challenges.delete(challenge.id);

          return interaction.update({
            components: [
              new ContainerBuilder()
                .setAccentColor(BLACK)
                .addTextDisplayComponents(
                  new TextDisplayBuilder().setContent(
                    `## Challenge Declined\n<@${challenge.targetId}> declined the challenge from <@${challenge.challengerId}>.`
                  )
                )
            ],
            flags: MessageFlags.IsComponentsV2
          });
        }
      }

      if (scope === "game") {
        const actionName = action;
        const gameId = actionName === "item" ? extra : value;
        const game = games.get(gameId);

        if (!game) {
          return interaction.reply({
            content: "This game no longer exists.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (
          interaction.channelId !== game.channelId &&
          actionName !== "close"
        ) {
          return interaction.reply({
            content: "That game is in another ticket.",
            flags: MessageFlags.Ephemeral
          });
        }

        if (actionName === "shoot_enemy") {
          return handleShot(interaction, game, false);
        }

        if (actionName === "shoot_self") {
          return handleShot(interaction, game, true);
        }

        if (actionName === "item") {
          return handleItem(interaction, game, value);
        }

        if (actionName === "close") {
          return closeGameTicket(interaction, game);
        }
      }
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
