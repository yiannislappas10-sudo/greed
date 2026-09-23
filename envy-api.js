const ENVY_API_URL = (process.env.ENVY_API_URL || "").replace(/\\/+$/, "");
const ENVY_API_KEY = process.env.ENVY_API_KEY || "";

function envyConfigured() {
  return Boolean(ENVY_API_URL && ENVY_API_KEY);
}

async function envyRequest(path, body) {
  if (!envyConfigured()) {
    throw new Error("ENVY_API_URL and ENVY_API_KEY must be configured for money-backed Buckshot.");
  }

  const response = await fetch(ENVY_API_URL + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + ENVY_API_KEY
    },
    body: JSON.stringify(body)
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok || !data.ok) {
    const error = new Error(data.error || `Envy API returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return data;
}

async function lockBuckshotWager(wagerId, guildId, playerAId, playerBId, amount) {
  return envyRequest("/v1/wagers/lock", {
    wager_id: wagerId,
    guild_id: guildId,
    player_a_id: playerAId,
    player_b_id: playerBId,
    amount
  });
}

async function settleBuckshotWager(wagerId, winnerId) {
  return envyRequest("/v1/wagers/settle", {
    wager_id: wagerId,
    winner_id: winnerId
  });
}

async function refundBuckshotWager(wagerId) {
  return envyRequest("/v1/wagers/refund", {
    wager_id: wagerId
  });
}

module.exports = {
  envyConfigured,
  lockBuckshotWager,
  settleBuckshotWager,
  refundBuckshotWager
};
