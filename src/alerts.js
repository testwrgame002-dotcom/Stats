const {
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType
} = require("discord.js");

const MESSAGE_LIFETIME = 12 * 60 * 60 * 1000;
const CRASH_TIMEOUT = 45 * 60 * 1000;
const UPDATE_INTERVAL = 10 * 60 * 1000;

const crashTimers = new Map();
const USERS_CACHE = new Map();
const USERS_CACHE_TTL = 5 * 60 * 1000;

let ACTIVE_ROLES_CACHE = null;
let ACTIVE_ROLES_CACHE_TS = 0;
const ACTIVE_ROLES_CACHE_TTL = 60 * 1000;
const inactivityStreaks = new Map();

// ================= REDIS KEYS =================

function usersKey(group) {
  return `users:${group}`;
}

function onlineKey(group) {
  return `online:${group}`;
}
function activeRolesKey() {
  return "active_roles";
}

async function getActiveRole(redis, discordId) {
  try {
    const now = Date.now();

    if (
      ACTIVE_ROLES_CACHE &&
      now - ACTIVE_ROLES_CACHE_TS < ACTIVE_ROLES_CACHE_TTL
    ) {
      return ACTIVE_ROLES_CACHE[String(discordId)] || null;
    }

    const data = await redis.hgetall(activeRolesKey());

    if (!data || typeof data !== "object") {
      ACTIVE_ROLES_CACHE = {};
      ACTIVE_ROLES_CACHE_TS = now;
      return null;
    }

    ACTIVE_ROLES_CACHE = data;
    ACTIVE_ROLES_CACHE_TS = now;

    return data[String(discordId)] || null;
  } catch (err) {
    console.error("getActiveRole error:", err);
    return null;
  }
}

async function hasActiveRivalDuoRole(redis, discordId) {
  const activeRole = await getActiveRole(redis, discordId);
  return activeRole === "Rival_Duo";
}

function safeJsonParse(value, fallback = {}) {
  try {
    if (!value) return fallback;
    if (typeof value === "object") return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeId(id) {
  return String(id || "").replace(/\D/g, "");
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[*_`~|>]/g, "")
    .replace(/^@+/, "")
    .replace(/[:：]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getMessageText(message) {
  let content = message.content || "";

  if ((!content || content.trim() === "") && message.embeds?.length > 0) {
    const embed = message.embeds[0];

    content =
      embed.description ||
      embed.fields?.map(f => `${f.name}\n${f.value}`).join("\n") ||
      "";
  }

  return String(content || "").replace(/```/g, "").trim();
}

function extractHeartbeatName(content) {
  const lines = String(content || "")
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);

  if (!lines.length) return "";

  let firstLine = lines[0]
    .replace(/[*_`~]/g, "")
    .trim();

  const mentionName = firstLine.match(/^@([^\s]+)/);
  if (mentionName) return mentionName[1];

  firstLine = firstLine.replace(/[:：]+$/g, "").trim();

  return firstLine;
}

function namesMatch(heartbeatName, registeredName) {
  const hb = normalizeName(heartbeatName);
  const reg = normalizeName(registeredName);

  if (!hb || !reg) return false;

  if (hb === reg) return true;

  // Solo permitir includes si ambos nombres son largos.
  // Evita falsos positivos con nombres cortos como dog, zero, bank, etc.
  if (hb.length >= 5 && reg.length >= 5) {
    if (hb.includes(reg)) return true;
    if (reg.includes(hb)) return true;
  }

  return false;
}

function getUserGameIds(userData) {
  const ids = [];

  const mainId = normalizeId(userData.main_id);
  const secId = normalizeId(userData.sec_id);

  if (/^\d{16}$/.test(mainId)) ids.push(mainId);
  if (/^\d{16}$/.test(secId)) ids.push(secId);

  if (Array.isArray(userData.secondary_ids)) {
    for (const id of userData.secondary_ids) {
      const clean = normalizeId(id);
      if (/^\d{16}$/.test(clean)) ids.push(clean);
    }
  }

  if (Array.isArray(userData.sec_ids)) {
    for (const id of userData.sec_ids) {
      const clean = normalizeId(id);
      if (/^\d{16}$/.test(clean)) ids.push(clean);
    }
  }

  return [...new Set(ids)];
}

async function loadUsers(redis, group) {
  const now = Date.now();
  const cached = USERS_CACHE.get(group);

  if (cached && now - cached.ts < USERS_CACHE_TTL) {
    return cached.data;
  }

  const data = await redis.hgetall(usersKey(group));

  if (!data || typeof data !== "object") {
    USERS_CACHE.set(group, {
      ts: now,
      data: {}
    });

    return {};
  }

  const users = {};

  for (const discordId in data) {
    users[discordId] = safeJsonParse(data[discordId], {});
  }

  USERS_CACHE.set(group, {
    ts: now,
    data: users
  });

  return users;
}

async function loadOnlineIDs(redis, group) {
  const ids = await redis.smembers(onlineKey(group));

  if (!Array.isArray(ids)) return [];

  return ids
    .map(normalizeId)
    .filter(x => /^\d{16}$/.test(x));
}

async function removeOnlineIDs(redis, group, ids) {
  const cleanIds = ids
    .map(normalizeId)
    .filter(x => /^\d{16}$/.test(x));

  if (!cleanIds.length) return;

  await redis.srem(onlineKey(group), ...cleanIds);
}
async function addOnlineIDs(redis, group, ids) {
  const cleanIds = ids
    .map(normalizeId)
    .filter(x => /^\d{16}$/.test(x));

  if (!cleanIds.length) return;

  await redis.sadd(onlineKey(group), ...cleanIds);
}

// ================= RIVAL DUO HELPERS =================

const RIVAL_DUOS_KEY = "rival_duos"
const RIVAL_DUO_BY_USER_KEY = "rival_duo_by_user"
const RIVAL_DUO_GRACE_MS = 15 * 60 * 1000
const RIVAL_DUO_CRASH_TIMEOUT = 30 * 60 * 1000
const RIVAL_DUO_UPDATE_INTERVAL = 10 * 60 * 1000
const RIVAL_DUO_REQUIRED_TOTAL_INSTANCES = 6
const RIVAL_DUO_HEARTBEAT_TIMEOUT_MS = 45 * 60 * 1000;

function parseRivalJson(value, fallback = {}) {
  try {
    if (!value) return fallback
    if (typeof value === "object") return value
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function getRivalDuoMembers(duo) {
  return Object.entries(duo?.members || {}).map(([discordId, member]) => ({
    discordId,
    ...member
  }))
}

function displayRivalDuoName(duo) {
  const members = getRivalDuoMembers(duo)

  if (!members.length) return "Empty Duo"

  return members
    .map(m => m.name || m.heartbeatName || "Unknown")
    .join(" & ")
}

function normalizeRivalName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[*_`~|>]/g, "")
    .replace(/^@+/, "")
    .replace(/[:：]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function rivalNamesMatch(a, b) {
  const x = normalizeRivalName(a)
  const y = normalizeRivalName(b)

  if (!x || !y) return false
  if (x === y) return true

  if (x.length >= 5 && y.length >= 5) {
    if (x.includes(y)) return true
    if (y.includes(x)) return true
  }

  return false
}

async function loadAllRivalDuos(redis) {
  try {
    const data = await redis.hgetall(RIVAL_DUOS_KEY)

    if (!data || typeof data !== "object") return {}

    const out = {}

    for (const duoId in data) {
      out[duoId] = parseRivalJson(data[duoId], null)
    }

    return out
  } catch (err) {
    console.error("Error loading Rival Duos:", err)
    return {}
  }
}

async function saveRivalDuo(redis, duo) {
  if (!duo?.id) return false

  await redis.hset(RIVAL_DUOS_KEY, {
    [duo.id]: JSON.stringify(duo)
  })

  return true
}

async function getRivalDuoById(redis, duoId) {
  const raw = await redis.hget(RIVAL_DUOS_KEY, String(duoId))
  return parseRivalJson(raw, null)
}

async function getRivalDuoByUser(redis, discordId) {
  const raw = await redis.hget(RIVAL_DUO_BY_USER_KEY, String(discordId))

  if (!raw) return null

  const ref = parseRivalJson(raw, null)

  if (!ref?.duoId) return null

  return await getRivalDuoById(redis, ref.duoId)
}

async function findRivalDuoMemberByHeartbeatName(redis, heartbeatName) {
  const duos = await loadAllRivalDuos(redis)

  for (const duo of Object.values(duos)) {
    if (!duo) continue

    for (const member of getRivalDuoMembers(duo)) {
      const candidates = [
        member.name,
        member.heartbeatName,
        ...(Array.isArray(member.aliases) ? member.aliases : [])
      ].filter(Boolean)

      for (const candidate of candidates) {
        if (rivalNamesMatch(heartbeatName, candidate)) {
          return {
            duo,
            member,
            discordId: member.discordId
          }
        }
      }
    }
  }

  return null
}

async function removeRivalDuoIdsFromElite(redis, duo) {
  const ids = getRivalDuoMembers(duo)
    .map(m => normalizeId(m.gameId))
    .filter(x => /^\d{16}$/.test(x))

  if (!ids.length) return

  await redis.srem("online:Elite_Four", ...ids)
}

async function activateRivalDuoId(redis, duo, force = false) {
  const members = getRivalDuoMembers(duo)

  if (members.length < 2) {
    await removeRivalDuoIdsFromElite(redis, duo)

    duo.activeGameId = null
    duo.activeDiscordId = null
    duo.status = "waiting_partner"

    await saveRivalDuo(redis, duo)

    return {
      ok: false,
      waiting: true,
      message: "⏳ Waiting for reroll partner."
    }
  }

  const bothOnline = members.every(member => {
    return duo.onlineUsers?.[member.discordId] === true
  })

  if (!bothOnline) {
    await removeRivalDuoIdsFromElite(redis, duo)

    duo.activeGameId = null
    duo.activeDiscordId = null
    duo.status = "waiting_partner"

    await saveRivalDuo(redis, duo)

    return {
      ok: false,
      waiting: true,
      message: "⏳ Waiting for reroll partner."
    }
  }

  const now = Date.now()

  const shouldRotate =
    force ||
    !duo.lastRotationAt ||
    now - Number(duo.lastRotationAt || 0) >= 60 * 60 * 1000

  if (!duo.activeGameId || shouldRotate) {
    const index = Number(duo.activeIndex || 0) % members.length
    const activeMember = members[index]

    await removeRivalDuoIdsFromElite(redis, duo)

    duo.activeGameId = activeMember.gameId
    duo.activeDiscordId = activeMember.discordId
    duo.lastRotationAt = now
    duo.activeIndex = (index + 1) % members.length
    duo.status = "online"

    await redis.sadd("online:Elite_Four", activeMember.gameId)
    await saveRivalDuo(redis, duo)

    return {
      ok: true,
      waiting: false,
      message:
        `🟢 Rival Duo online in Elite Four.\n` +
        `Duo: **${displayRivalDuoName(duo)}**\n` +
        `Active ID: **${activeMember.gameId}**\n` +
        `Active user: <@${activeMember.discordId}>`
    }
  }

  await redis.sadd("online:Elite_Four", duo.activeGameId)
  await saveRivalDuo(redis, duo)

  return {
    ok: true,
    waiting: false,
    message:
      `🟢 Rival Duo already online.\n` +
      `Duo: **${displayRivalDuoName(duo)}**\n` +
      `Active ID: **${duo.activeGameId}**\n` +
      `Active user: <@${duo.activeDiscordId}>`
  }
}

async function setRivalDuoOnline(redis, discordId) {
  const duo = await getRivalDuoByUser(redis, discordId)

  if (!duo) {
    return {
      ok: false,
      message: "❌ You are not registered in a Rival Duo."
    }
  }

  if (!duo.onlineUsers) duo.onlineUsers = {}

  duo.onlineUsers[String(discordId)] = true

  await saveRivalDuo(redis, duo)

  return await activateRivalDuoId(redis, duo, false)
}

async function setRivalDuoOffline(redis, discordId, reason = "offline") {
  const duo = await getRivalDuoByUser(redis, discordId)

  if (!duo) {
    return {
      ok: false,
      message: "❌ You are not registered in a Rival Duo."
    }
  }

  await removeRivalDuoIdsFromElite(redis, duo)

  duo.onlineUsers = {}
  duo.activeGameId = null
  duo.activeDiscordId = null
  duo.status = "offline"
  duo.offlineReason = reason
  duo.offlineAt = Date.now()

  await saveRivalDuo(redis, duo)

  return {
    ok: true,
    message: `🔴 Rival Duo offline: **${displayRivalDuoName(duo)}**.`
  }
}

async function recordRivalDuoHeartbeat(redis, discordId, content) {
  const duo = await getRivalDuoByUser(redis, discordId)

  if (!duo) return null

  if (!duo.lastHeartbeatAt) duo.lastHeartbeatAt = {}
  if (!duo.lastHeartbeatStats) duo.lastHeartbeatStats = {}


  const packsMatch = String(content || "").match(/Packs:\s*(\d+)/i)

  const avgMatch =
    String(content || "").match(/Avg:\s*([\d.]+)\s*packs?\s*\/?\s*min/i) ||
    String(content || "").match(/Avg:\s*([\d.]+)/i)

 const numericInstances = getNumericOnlineInstances(content)
const totalNumericInstances = getTotalNumericInstances(content)

  duo.lastHeartbeatAt[String(discordId)] = Date.now()

duo.lastHeartbeatStats[String(discordId)] = {
  packs: Number(packsMatch?.[1] || 0),
  ppm: Number(avgMatch?.[1] || 0),
  activeInstances: numericInstances.length,
  totalInstances: totalNumericInstances.length,
  hasActiveNumeric: numericInstances.length > 0,
  updatedAt: Date.now()
}

  await saveRivalDuo(redis, duo)

  return duo
}

// CÁMBIALO PARA QUE QUEDE ASÍ:
function getRivalDuoHealth(duo) {
  const members = getRivalDuoMembers(duo);
  let totalInstances = 0;
  let missingActive = [];
  let missingHeartbeat = [];

  for (const member of members) {
    const stats = duo.lastHeartbeatStats?.[member.discordId];
    const lastHeartbeat = Number(duo.lastHeartbeatAt?.[member.discordId] || 0);

    const isFresh = lastHeartbeat && (Date.now() - lastHeartbeat < RIVAL_DUO_HEARTBEAT_TIMEOUT_MS);
    
    const memberTotal = Number(stats?.totalInstances || 0);
    totalInstances += memberTotal;

    const hasActiveNumeric = stats?.hasActiveNumeric === true;

    if (!isFresh) {
      missingHeartbeat.push(member);
    } else if (!hasActiveNumeric) {
      missingActive.push(member);
    }
  }

  return {
    members,
    totalInstances,
    missingActive,
    missingHeartbeat,
    // Activa la alerta si faltan bots, instancias activas, O si el total combinado es menor a 6
    hasMissingActive: missingActive.length > 0 || missingHeartbeat.length > 0 || totalInstances < RIVAL_DUO_REQUIRED_TOTAL_INSTANCES,
    hasEnoughTotalInstances: totalInstances >= RIVAL_DUO_REQUIRED_TOTAL_INSTANCES
  };
}
// CÁMBIALO PARA QUE QUEDE ASÍ:
async function sendRivalDuoAlertToBoth({
  guild,
  client,
  duo,
  championRoleId,
  categoryId,
  group,
  publicChannel,
  embed,
  content
}) {
  const members = getRivalDuoMembers(duo);

  for (const duoMember of members) {
    // Si no encuentra el miembro completo, generamos un fallback para que getOrCreatePersonalChannel no explote
    let member = await guild.members.fetch(duoMember.discordId).catch(() => null);
    if (!member) {
      member = { id: duoMember.discordId, user: { username: duoMember.name || "user" } };
    }

    const userData = {
      name: duoMember.name,
      heartbeatName: duoMember.heartbeatName,
      main_id: duoMember.gameId,
      role: "Rival Duo"
    };

    const userChannel = await getOrCreatePersonalChannel({
      guild,
      client,
      member,
      userData,
      discordId: duoMember.discordId,
      championRoleId,
      categoryId,
      group
    });

    if (userChannel) {
      if (embed) {
        await userChannel.send({ embeds: [embed] }).catch(() => {});
      } else if (content) {
        await userChannel.send({ content }).catch(() => {});
      }
    }
  }

  if (publicChannel) {
    if (embed) {
      await publicChannel.send({ embeds: [embed] }).catch(() => {});
    } else if (content) {
      await publicChannel.send({ content }).catch(() => {});
    }
  }
}

async function startRivalDuoOfflineTimer({
  redis,
  guild,
  client,
  duo,
  reason,
  detail,
  championRoleId,
  categoryId,
  group,
  publicChannel
}) {
  const timerKey = `rival_duo_alert:${duo.id}`;

  if (crashTimers.has(timerKey)) return;

  let elapsed = 0;

const startEmbed = new EmbedBuilder()
    .setColor(0xFFA500)
    .setDescription(
      `⚠️ Rival Duo **${displayRivalDuoName(duo)}** has an issue.\n\n` +
      `${detail}\n\n` +
      `Offline countdown started. If this is not fixed in **30 minutes**, both users will be set offline.`
    );

  await sendRivalDuoAlertToBoth({
    guild,
    client,
    duo,
    championRoleId,
    categoryId,
    group,
    publicChannel,
    embed: startEmbed
  });

  const interval = setInterval(async () => {
    const freshDuo = await getRivalDuoById(redis, duo.id);

    if (!freshDuo || freshDuo.status !== "online") {
      clearTimeout(timeout);
      clearInterval(interval);
      crashTimers.delete(timerKey);
      return;
    }

    const health = getRivalDuoHealth(freshDuo);

    const fixed =
      !health.hasMissingActive &&
      health.hasEnoughTotalInstances;

    if (fixed) {
      clearTimeout(timeout);
      clearInterval(interval);
      crashTimers.delete(timerKey);

      const fixedEmbed = new EmbedBuilder()
        .setColor(0x00ff88)
        .setDescription(
          `✅ Rival Duo **${displayRivalDuoName(freshDuo)}** is healthy again.\n` +
          `The offline countdown was cancelled.`
        );

      await sendRivalDuoAlertToBoth({
        guild,
        client,
        duo: freshDuo,
        championRoleId,
        categoryId,
        group,
        publicChannel,
        embed: fixedEmbed
      });

      return;
    }

    elapsed += RIVAL_DUO_UPDATE_INTERVAL;
    const remaining = Math.max(0, Math.ceil((RIVAL_DUO_CRASH_TIMEOUT - elapsed) / 60000));

    const updateEmbed = new EmbedBuilder()
      .setColor(0xFFA500)
      .setDescription(
        `⏳ Rival Duo **${displayRivalDuoName(freshDuo)}** countdown: **${remaining} minutes remaining**.\n\n` +
        `${detail}`
      );

    await sendRivalDuoAlertToBoth({
      guild,
      client,
      duo: freshDuo,
      championRoleId,
      categoryId,
      group,
      publicChannel,
      embed: updateEmbed
    });
  }, RIVAL_DUO_UPDATE_INTERVAL);

  const timeout = setTimeout(async () => {
    clearInterval(interval);

    const freshDuo = await getRivalDuoById(redis, duo.id);

    if (!freshDuo || freshDuo.status !== "online") {
      crashTimers.delete(timerKey);
      return;
    }

    const health = getRivalDuoHealth(freshDuo);

    const fixed =
      !health.hasMissingActive &&
      health.hasEnoughTotalInstances;

    if (fixed) {
      crashTimers.delete(timerKey);
      return;
    }

    await removeRivalDuoIdsFromElite(redis, freshDuo);

    freshDuo.onlineUsers = {};
    freshDuo.activeGameId = null;
    freshDuo.activeDiscordId = null;
    freshDuo.status = "offline";
    freshDuo.offlineReason = reason;
    freshDuo.offlineAt = Date.now();

    await saveRivalDuo(redis, freshDuo);

    const offlineEmbed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setDescription(
        `🚨 Rival Duo **${displayRivalDuoName(freshDuo)}** was set **OFFLINE**.\n\n` +
        `${detail}`
      );

    await sendRivalDuoAlertToBoth({
      guild,
      client,
      duo: freshDuo,
      championRoleId,
      categoryId,
      group,
      publicChannel,
      embed: offlineEmbed
    });

    crashTimers.delete(timerKey);
  }, RIVAL_DUO_CRASH_TIMEOUT);

  crashTimers.set(timerKey, { timeout, interval });
}

async function handleRivalDuoDedicatedAlerts({
  redis,
  guild,
  client,
  duo,
  championRoleId,
  categoryId,
  group,
  publicChannel
}) {
  if (!duo) return;
  if (duo.status !== "online") return;

  const members = getRivalDuoMembers(duo);
  if (members.length < 2) return;

  // Si acaban de ponerse online, no hacemos nada hasta que pase el tiempo de gracia (15 minutos)
  if (!duo.lastRotationAt) return;
  const onlineFor = Date.now() - Number(duo.lastRotationAt || 0);
  if (onlineFor < RIVAL_DUO_GRACE_MS) {
    return; 
  }

  const health = getRivalDuoHealth(duo);

  // 1. PRIORIDAD: Detectar si hay bots completamente apagados (Sin enviar heartbeat)
  if (health.missingHeartbeat.length > 0) {
    const missingNames = health.missingHeartbeat
      .map(m => `<@${m.discordId}>`)
      .join(", ");

    await startRivalDuoOfflineTimer({
      redis,
      guild,
      client,
      duo,
      reason: "rival_duo_missing_heartbeat_stream",
      detail:
        `🚨 **Atención:** El bot de inyección de: ${missingNames} **no está enviando heartbeats** a Discord.\n` +
        `Por favor, verifiquen si la consola se cerró o perdió conexión. Ambos deben transmitir pulsos de forma continua.`,
      championRoleId,
      categoryId,
      group,
      publicChannel
    });

    return;
  }

  // 2. SEGUNDA ALERTA: Envía pulsos, pero no tiene instancias numéricas activas
  if (health.missingActive.length > 0) {
    const missingNames = health.missingActive
      .map(m => `<@${m.discordId}>`)
      .join(", ");

    await startRivalDuoOfflineTimer({
      redis,
      guild,
      client,
      duo,
      reason: "rival_duo_no_active_numeric_heartbeat",
      detail:
        `⚠️ No active numeric instances were detected for: ${missingNames}.\n` +
        `Both Rival Duo users must keep numeric instances actively running.`,
      championRoleId,
      categoryId,
      group,
      publicChannel
    });

    return;
  }

  // 3. TERCERA ALERTA: Las instancias activas e inactivas de ambos no suman 6 en total
  if (!health.hasEnoughTotalInstances) {
    await startRivalDuoOfflineTimer({
      redis,
      guild,
      client,
      duo,
      reason: "rival_duo_not_enough_total_instances",
      detail:
        `Rival Duo requiere un mínimo de **6 instancias numéricas totales** para permanecer en Elite Four.\n` +
        `Total actual detectado en el sistema: **${health.totalInstances}/${RIVAL_DUO_REQUIRED_TOTAL_INSTANCES}**.`,
      championRoleId,
      categoryId,
      group,
      publicChannel
    });

    return;
  }
}

async function checkRivalDuoHeartbeatTimeouts(redis) {
  const duos = await loadAllRivalDuos(redis)
  const now = Date.now()

  for (const duo of Object.values(duos)) {
    if (!duo) continue

    const members = getRivalDuoMembers(duo)

    if (members.length < 2) continue
    if (duo.status !== "online") continue

    const staleMember = members.find(member => {
      const last = Number(duo.lastHeartbeatAt?.[member.discordId] || 0)

      if (!last) return true

      return now - last >= RIVAL_DUO_HEARTBEAT_TIMEOUT_MS
    })

    if (!staleMember) continue

    await removeRivalDuoIdsFromElite(redis, duo)

    duo.onlineUsers = {}
    duo.activeGameId = null
    duo.activeDiscordId = null
    duo.status = "offline"
    duo.offlineReason = `heartbeat_timeout_${staleMember.discordId}`
    duo.offlineAt = now

    await saveRivalDuo(redis, duo)

    console.log(
      `🔴 Rival Duo offline by heartbeat timeout: ${displayRivalDuoName(duo)} | stale user: ${staleMember.discordId}`
    )
  }
}


function getMainGameId(userData) {
  const mainId = normalizeId(userData.main_id);
  return /^\d{16}$/.test(mainId) ? mainId : null;
}
function getSecGameId(userData) {
  const secId = normalizeId(userData.sec_id);
  return /^\d{16}$/.test(secId) ? secId : null;
}

function isSpecificIdOnline(id, onlineIds) {
  const cleanId = normalizeId(id);

  return onlineIds
    .map(normalizeId)
    .includes(cleanId);
}

function getNumericOnlineInstances(content) {
  const online = getOnlineInstances(content);

  return online.filter(x =>
    x !== "main" &&
    x !== "none" &&
    /^\d+$/.test(x)
  );
}

function getNumericOfflineInstances(content) {
  const parsed = parseOffline(content);
  const match = String(content || "").match(/Offline:\s*([^\n\r]+)/i);

  if (!match) return [];

  return match[1]
    .split(",")
    .map(x => x.trim().toLowerCase())
    .filter(x => x !== "main" && x !== "none" && /^\d+$/.test(x));
}

function getTotalNumericInstances(content) {
  const online = getNumericOnlineInstances(content);
  const offline = getNumericOfflineInstances(content);

  return [...new Set([...online, ...offline])];
}

function getHeartbeatPPM(content) {
  const match = String(content || "").match(/Avg:\s*([\d.]+)\s*packs\/min/i);

  if (!match) return 0;

  return Number(match[1]) || 0;
}

function hasRequiredHeartbeatType(content) {
  const match = String(content || "").match(/^Type:\s*(.+)$/im);

  if (!match) return false;

  const typeValue = match[1].trim().toLowerCase();

  return typeValue === "inject wonderpick 96p+";
}

function hasActiveHeartbeat(content) {
  const numericInstances = getNumericOnlineInstances(content);
  const ppm = getHeartbeatPPM(content);
  const validType = hasRequiredHeartbeatType(content);

  return numericInstances.length > 0 && ppm > 0 && validType;
}

function isUserOnlineInRedis(userData, onlineIds) {
  const set = new Set(onlineIds.map(normalizeId));
  const userIds = getUserGameIds(userData);

  return userIds.some(id => set.has(id));
}

// ================= HEARTBEAT PARSERS =================

function getOnlineInstances(content) {
  const match = String(content || "").match(/Online:\s*([^\n\r]+)/i);
  if (!match) return [];

  return match[1]
    .split(",")
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);
}

function parseOffline(content) {
  const match = String(content || "").match(/Offline:\s*([^\n\r]+)/i);

  if (!match) {
    return {
      count: 0,
      hasMain: false
    };
  }

  const list = match[1]
    .split(",")
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);

  return {
    count: list.filter(x => x !== "main" && x !== "none").length,
    hasMain: list.includes("main")
  };
}

function isInactive(content) {
  const online = getOnlineInstances(content);

  if (!online.length) return false;

  if (online.includes("none")) return true;

  const numericInstances = online.filter(x =>
    x !== "main" &&
    x !== "none" &&
    /^\d+$/.test(x)
  );

  return numericInstances.length === 0;
}

function getGroupByHeartbeatChannel(groupConfig, channelId) {
  return Object.keys(groupConfig).find(
    group => groupConfig[group].heartbeatChannelId === channelId
  );
}

function findUserByHeartbeatName(users, heartbeatName) {
  for (const [discordId, userData] of Object.entries(users)) {
    const candidates = [
      userData.name,
      userData.heartbeatName,
      userData.username,
      userData.displayName,
      userData.display_name,
      ...(Array.isArray(userData.aliases) ? userData.aliases : [])
    ]
      .map(x => String(x || "").trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      if (namesMatch(heartbeatName, candidate)) {
        return [discordId, userData];
      }
    }
  }

  return null;
}

// ================= CHANNEL HELPERS =================

async function getOrCreatePersonalChannel({
  guild,
  client,
  member,
  userData,
  discordId,
  championRoleId,
  categoryId,
  group
}) {
  await guild.channels.fetch();
  const topicTag = `user:${discordId}`;

  const safeName = String(userData.heartbeatName || userData.name || member.user.username || "user")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "user";

  const desiredName = `personal-${safeName}`;

  // 1. Buscar canal por topic correcto
  let userChannel = guild.channels.cache.find(c =>
    c.type === ChannelType.GuildText &&
    c.topic === topicTag
  );

  if (userChannel) {
    return userChannel;
  }

  // 2. Buscar canal viejo por nombre personal y permisos del usuario
  const possibleChannels = guild.channels.cache.filter(c =>
    c.type === ChannelType.GuildText &&
    c.name.startsWith("personal-")
  );

for (const channel of possibleChannels.values()) {
  const permission = channel.permissionOverwrites.cache.get(discordId);

  const hasUserPermission =
    permission &&
    permission.allow.has(PermissionFlagsBits.ViewChannel);

  if (hasUserPermission) {
    userChannel = channel;

    // Reparar topic para evitar duplicados futuros
    await userChannel.setTopic(topicTag).catch(() => {});

    console.log(
      `♻️ Reusing old personal channel for ${userData.name || discordId}: #${userChannel.name}`
    );

    return userChannel;
  }
}

  // 3. Si no existe, crear canal nuevo
  const championRole = guild.roles.cache.get(championRoleId);

  const overwrites = [
    {
      id: guild.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    }
  ];

  if (championRole) {
    overwrites.push({
      id: championRole.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory
      ]
    });
  }

await guild.channels.fetch();

const existingAfterFetch = guild.channels.cache.find(c =>
  c.type === ChannelType.GuildText &&
  c.topic === topicTag
);

if (existingAfterFetch) {
  return existingAfterFetch;
}
  
  userChannel = await guild.channels.create({
    name: desiredName,
    type: ChannelType.GuildText,
    topic: topicTag,
    parent: categoryId,
    permissionOverwrites: overwrites
  });

  console.log(`✅ Personal channel created for ${userData.name || discordId} (${group})`);

  return userChannel;
}


async function sendGlobalHeartbeat(client, guild, channelId, group, userData, content) {
  const globalChannel = guild.channels.cache.get(channelId);
  if (!globalChannel) return;

  if (!client.globalHeartbeatMessages) {
    client.globalHeartbeatMessages = new Map();
  }

  const mapKey = `${group}:${normalizeName(userData.heartbeatName || userData.name || userData.username)}`;
  const existingMsgId = client.globalHeartbeatMessages.get(mapKey);

  const payload = {
    content: `\`\`\`\n${content}\n\`\`\``
  };

  if (existingMsgId) {
    const existing = await globalChannel.messages.fetch(existingMsgId).catch(() => null);

    if (existing) {
      await existing.edit(payload).catch(() => null);
      return;
    }
  }

  const sent = await globalChannel.send(payload);
  client.globalHeartbeatMessages.set(mapKey, sent.id);
}

// ================= CLEANUP =================

async function cleanOldMessages(client, publicAlertsChannelId) {
  const now = Date.now();

  for (const guild of client.guilds.cache.values()) {
    const personalChannels = guild.channels.cache.filter(c =>
      c.isTextBased() && c.name.startsWith("personal-")
    );

    for (const channel of personalChannels.values()) {
      const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (!messages) continue;

      for (const msg of messages.values()) {
        if (
          msg.author.id === client.user.id &&
          now - msg.createdTimestamp > MESSAGE_LIFETIME
        ) {
          await msg.delete().catch(() => {});
        }
      }
    }

if (publicAlertsChannelId) {
  const publicChannel = guild.channels.cache.get(publicAlertsChannelId);

  if (publicChannel) {
    const messages = await publicChannel.messages.fetch({ limit: 100 }).catch(() => null);

    if (messages) {
      for (const msg of messages.values()) {
        if (
          msg.author.id === client.user.id &&
          now - msg.createdTimestamp > MESSAGE_LIFETIME
        ) {
          await msg.delete().catch(() => {});
        }
      }
    }
  }
}
  }
}

// ================= MAIN MODULE =================

// ================= MAIN MODULE =================

module.exports = (client, options) => {
  const {
    GROUP_CONFIG,
    CHAMPION_ROLE_ID,
    PUBLIC_ALERTS_CHANNEL_ID,
    redis
  } = options;

  // Mapa interno para guardar la hora exacta del último pulso recibido por cada usuario/ID
  const GLOBAL_LAST_HEARTBEAT_CACHE = new Map();

  // 1. INICIALIZACIÓN DE TEMPORIZADORES CUANDO EL BOT SE CONECTA
  client.once("ready", () => {
    console.log("✅ alerts.js loaded");

    // Ejecutar el escáner de inactividad estricto cada 5 minutos (Optimizado para Upstash)
    setInterval(checkAllHeartbeats, 5 * 60 * 1000);

    setInterval(
      () => cleanOldMessages(client, null),
      60 * 60 * 1000
    );
  });

  // 2. FUNCIÓN ESCÁNER: REVISA LOS 40 MINUTOS GLOBAL Y EL MÍNIMO DE 6 INSTANCIAS EN RIVAL DUOS
  async function checkAllHeartbeats() {
    const now = Date.now();

    for (const [group, config] of Object.entries(GROUP_CONFIG)) {
      const guild = client.guilds.cache.get(config.guildId);
      if (!guild) continue;

      const onlineIds = await loadOnlineIDs(redis, group);
      const users = await loadUsers(redis, group);

      for (const [discordId, userData] of Object.entries(users)) {
        if (isUserOnlineInRedis(userData, onlineIds)) {
          const lastHbTime = GLOBAL_LAST_HEARTBEAT_CACHE.get(String(discordId));
          
          if (lastHbTime && (now - lastHbTime >= 40 * 60 * 1000)) {
            const userGameIds = getUserGameIds(userData);
            await removeOnlineIDs(redis, group, userGameIds);
            
            if (await hasActiveRivalDuoRole(redis, discordId)) {
              await setRivalDuoOffline(redis, discordId, "heartbeat_missing_40min");
            }
            console.log(`🔴 [40 Min Timeout] Usuario ${userData.name || discordId} movido a OFFLINE inmediatamente por desaparecer.`);
          }
        }
      }
    }
    
    // CONTROL AUTOMÁTICO DE INSTANCIAS DE RIVAL DUOS (MÍNIMO 6)
    const duos = await loadAllRivalDuos(redis);
    for (const duo of Object.values(duos)) {
      if (!duo || duo.status !== "online") continue;
      
      const config = GROUP_CONFIG["Elite_Four"];
      if (!config) continue;

      const guild = client.guilds.cache.get(config.guildId);
      const publicChannel = guild?.channels.cache.get(PUBLIC_ALERTS_CHANNEL_ID);

      if (guild) {
        // Ejecutar la salud nativa del dúo
        await handleRivalDuoDedicatedAlerts({
          redis, guild, client, duo,
          championRoleId: CHAMPION_ROLE_ID,
          categoryId: config.categoryId,
          group: "Elite_Four",
          publicChannel
        });

        // REGLA DE ORO: Validar si cumplen con las 6 instancias usando la función que modificamos antes
        const health = getRivalDuoHealth(duo);
        const timerKey = `Elite_Four:rival_duo:${duo.id}`;

        if (health.hasMissingActive) {
          // Si no tiene el contador activo, lo iniciamos en este momento
          if (!crashTimers.has(timerKey)) {
            let elapsed = 0;
            const members = getRivalDuoMembers(duo);
            const firstMember = members[0];
            
            // Intentar obtener el canal personal del primer miembro para avisarles
            const memberObj = await guild.members.fetch(firstMember.discordId).catch(() => null);
            const userChannel = memberObj ? guild.channels.cache.find(c => c.name === `rival-${duo.id}`) : null;

            const alertDetail = health.totalInstances < 6 
              ? `Total instances dropped to **${health.totalInstances}/6**.` 
              : `A member heartbeat is stale or missing active status.`;

            const startEmbed = new EmbedBuilder()
              .setColor(0xFFA500)
              .setDescription(
                `⚠️ Rival Duo **${displayRivalDuoName(duo)}** has an issue.\n\n` +
                `🚨 *Detail:* ${alertDetail}\n\n` +
                `Offline countdown started. If this is not fixed in **30 minutes**, both users will be set offline.`
              );

            if (userChannel) await userChannel.send({ embeds: [startEmbed] }).catch(() => {});
            if (publicChannel) await publicChannel.send({ embeds: [startEmbed] }).catch(() => {});

            // Intervalo que actualiza el estado cada 5 minutos
            const interval = setInterval(async () => {
              const freshDuo = await getRivalDuoById(redis, duo.id);
              if (!freshDuo || freshDuo.status !== "online") {
                clearTimeout(timeout);
                clearInterval(interval);
                crashTimers.delete(timerKey);
                return;
              }

              const freshHealth = getRivalDuoHealth(freshDuo);
              if (!freshHealth.hasMissingActive) {
                clearTimeout(timeout);
                clearInterval(interval);
                crashTimers.delete(timerKey);
                
                const fixEmbed = new EmbedBuilder()
                  .setColor(0x00FF88)
                  .setDescription(`✅ Rival Duo **${displayRivalDuoName(duo)}** recovered requirements. Countdown stopped.`);
                if (userChannel) await userChannel.send({ embeds: [fixEmbed] }).catch(() => {});
                return;
              }

              elapsed += (5 * 60 * 1000); 
              const remaining = Math.max(0, Math.ceil((30 * 60 * 1000 - elapsed) / 60000));

              if (remaining % 5 === 0 && remaining > 0 && userChannel) { // Avisar cada 5 minutos para no spamear
                await userChannel.send({
                  content: `⏳ **${displayRivalDuoName(duo)}** countdown: **${remaining} minutes remaining**.`
                }).catch(() => {});
              }
            }, 5 * 60 * 1000);

            // Timeout finalizador a los 30 minutos
            const timeout = setTimeout(async () => {
              clearInterval(interval);
              crashTimers.delete(timerKey);

              const freshDuo = await getRivalDuoById(redis, duo.id);
              if (freshDuo && freshDuo.status === "online") {
                const result = await setRivalDuoOffline(redis, firstMember.discordId, "insufficient_instances");
                
                const red = new EmbedBuilder()
                  .setColor(0xFF0000)
                  .setDescription(`🚨 ${result.message}\nReason: Spent 30 minutes without fulfilling requirements (Minimum 6 active instances).`);

                if (userChannel) await userChannel.send({ embeds: [red] }).catch(() => {});
                if (publicChannel) await publicChannel.send({ embeds: [red] }).catch(() => {});
              }
            }, 30 * 60 * 1000);

            crashTimers.set(timerKey, { timeout, interval });
          }
        } else {
          // Si el dúo está totalmente sano, nos aseguramos de limpiar cualquier contador viejo
          if (crashTimers.has(timerKey)) {
            const timer = crashTimers.get(timerKey);
            clearTimeout(timer.timeout);
            clearInterval(timer.interval);
            crashTimers.delete(timerKey);
          }
        }
      }
    }
    
    await checkRivalDuoHeartbeatTimeouts(redis);
  }

  // 3. HEARTBEAT PROCESSING ON MESSAGE CREATE
  client.on("messageCreate", async (message) => {
    try {
      const group = getGroupByHeartbeatChannel(GROUP_CONFIG, message.channel.id);
      if (!group) return;

      const content = getMessageText(message);
      if (!content) return;

      const heartbeatName = extractHeartbeatName(content);
      if (!heartbeatName) return;

      const users = await loadUsers(redis, group);

      let entry = findUserByHeartbeatName(users, heartbeatName);
      let isRivalDuo = false;
      let rivalDuoData = null;

      if (!entry && group === "Elite_Four") {
        const duoEntry = await findRivalDuoMemberByHeartbeatName(redis, heartbeatName);

        if (duoEntry) {
          isRivalDuo = true;
          rivalDuoData = duoEntry.duo;

          entry = [
            duoEntry.discordId,
            {
              name: duoEntry.member.name,
              heartbeatName: duoEntry.member.heartbeatName,
              main_id: duoEntry.member.gameId,
              aliases: duoEntry.member.aliases || [],
              role: "Rival Duo"
            }
          ];
        }
      }

      if (!entry) {
        console.log(`⚠️ alerts.js did not find user: "${heartbeatName}" in ${group}`);
        return;
      }

      let [discordId, userData] = entry;
      let activeRivalDuoRole = false;

      if (group === "Elite_Four") {
        activeRivalDuoRole = await hasActiveRivalDuoRole(redis, discordId);

        if (activeRivalDuoRole && !isRivalDuo) {
          const duoEntry = await findRivalDuoMemberByHeartbeatName(redis, heartbeatName);

          if (duoEntry) {
            isRivalDuo = true;
            rivalDuoData = duoEntry.duo;
            discordId = duoEntry.discordId;

            userData = {
              name: duoEntry.member.name,
              heartbeatName: duoEntry.member.heartbeatName,
              main_id: duoEntry.member.gameId,
              aliases: duoEntry.member.aliases || [],
              role: "Rival Duo"
            };
          }
        }
      }

      GLOBAL_LAST_HEARTBEAT_CACHE.set(String(discordId), Date.now());

      console.log(`✅ alerts.js match: heartbeat="${heartbeatName}" -> ${userData.name || "Unknown"} (${discordId})`);

      const guild = message.guild;
      if (!guild) return;

      const member = await guild.members.fetch(discordId).catch(() => null);
      if (!member) return;

      const config = GROUP_CONFIG[group];
      const userChannel = await getOrCreatePersonalChannel({
        guild, client, member, userData, discordId,
        championRoleId: CHAMPION_ROLE_ID,
        categoryId: config?.categoryId,
        group
      });

      await userChannel.send({
        content: `📡 **Heartbeat Update for ${userData.name || member.displayName}**\n🏷️ **Group:** ${config?.label || group}\n\n\`\`\`\n${content}\n\`\`\``
      });

// CORRECCIÓN AQUÍ: Guardar el pulso de Rival Duo de forma segura
      if (isRivalDuo) {
        const freshDuo = await recordRivalDuoHeartbeat(redis, discordId, content);
        if (freshDuo) {
          rivalDuoData = freshDuo; // Actualizamos la referencia local con los datos más frescos de Redis
          await handleRivalDuoDedicatedAlerts({
            redis, guild, client, duo: freshDuo,
            championRoleId: CHAMPION_ROLE_ID,
            categoryId: config?.categoryId,
            group, publicChannel: null
          });
        }
      }

      const publicChannel = guild.channels.cache.get(PUBLIC_ALERTS_CHANNEL_ID) || null;
      let onlineIds = await loadOnlineIDs(redis, group);

      // Extraer la línea de Online para usuarios normales
      const onlineLine = content.split('\n').find(line => line.toLowerCase().includes('online:')) || '';
      const hasOnlineNumericInstances = /\d/.test(onlineLine);

      // ====== CORRECCIÓN DE LOGICA INACTIVE =====
      // Si es Rival Duo, evaluamos la salud usando estrictamente el rivalDuoData actualizado por Redis
      const inactive = isRivalDuo && rivalDuoData
        ? (getRivalDuoHealth(rivalDuoData).hasMissingActive || !hasActiveHeartbeat(content))
        : (!hasOnlineNumericInstances || !hasActiveHeartbeat(content));
      // ===========================================

      const timerKey = isRivalDuo && rivalDuoData
        ? `${group}:rival_duo:${rivalDuoData.id}`
        : `${group}:${discordId}`;

      if (inactive) {
        const freshOnlineIds = await loadOnlineIDs(redis, group);
        let stillOnline = isUserOnlineInRedis(userData, freshOnlineIds);

        if (isRivalDuo && rivalDuoData) {
          const freshDuo = await getRivalDuoById(redis, rivalDuoData.id);
          stillOnline = freshDuo?.status === "online";
        }

        if (stillOnline && !crashTimers.has(timerKey)) {
          let elapsed = 0;
          const currentTimeout = isRivalDuo ? (30 * 60 * 1000) : CRASH_TIMEOUT;

          const alertDetail = isRivalDuo 
            ? `Rival Duo requirements dropped (Incomplete instances or missing heartbeat).`
            : `No active numeric instances detected in your Online stream.`;

          await userChannel.send({
            content: `⏳ ${member} **🚨 Issue Detected:** ${alertDetail}\nInactivity countdown triggered **immediately**. You have **${currentTimeout / 60000} minutes** to restore your setup before being set offline.`
          });

          const interval = setInterval(async () => {
            let freshOnline = isUserOnlineInRedis(userData, await loadOnlineIDs(redis, group));

            if (isRivalDuo && rivalDuoData) {
              const freshDuo = await getRivalDuoById(redis, rivalDuoData.id);
              freshOnline = freshDuo?.status === "online";
            }

            if (!freshOnline) {
              clearTimeout(timeout);
              clearInterval(interval);
              crashTimers.delete(timerKey);
              await userChannel.send({ content: `✅ ${member} Countdown stopped. System is already offline.` }).catch(() => {});
              return;
            }

            elapsed += UPDATE_INTERVAL;
            const remaining = Math.max(0, Math.ceil((currentTimeout - elapsed) / 60000));

            if (remaining > 0) {
              await userChannel.send({ content: `⏳ ${member} Countdown tracking: **${remaining} minutes remaining**.` }).catch(() => {});
            }
          }, UPDATE_INTERVAL);

          const timeout = setTimeout(async () => {
            clearInterval(interval);
            crashTimers.delete(timerKey);

            let freshOnline = isUserOnlineInRedis(userData, await loadOnlineIDs(redis, group));
            if (isRivalDuo && rivalDuoData) {
              const freshDuo = await getRivalDuoById(redis, rivalDuoData.id);
              freshOnline = freshDuo?.status === "online";
            }

            if (!freshOnline) return;

            if (isRivalDuo) {
              const result = await setRivalDuoOffline(redis, discordId, "insufficient_requirements");
              const redDuo = new EmbedBuilder()
                .setColor(0xFF0000)
                .setDescription(`🚨 **Rival Duo Forced Offline**\n${result.message}\n\n*Reason:* Spent 30 minutes without fulfilling active requirements.`);

              await userChannel.send({ embeds: [redDuo] }).catch(() => {});
              if (publicChannel) await publicChannel.send({ embeds: [redDuo] }).catch(() => {});
              return;
            }

            const idsToRemove = getUserGameIds(userData);
            await removeOnlineIDs(redis, group, idsToRemove);

            const redNormal = new EmbedBuilder()
              .setColor(0xFF0000)
              .setDescription(`🚨 ${member} has been processed **OFFLINE**. Spent 45 minutes with 0 numeric instances online.`);

            await userChannel.send({ embeds: [redNormal] }).catch(() => {});
            if (publicChannel) await publicChannel.send({ embeds: [redNormal] }).catch(() => {});

          }, currentTimeout);

          crashTimers.set(timerKey, { timeout, interval });
        }
      } else {
        if (crashTimers.has(timerKey)) {
          const timer = crashTimers.get(timerKey);
          clearTimeout(timer.timeout);
          clearInterval(timer.interval);
          crashTimers.delete(timerKey);

          await userChannel.send({
            content: `✅ ${member} System restored! Active numeric setups recovered. Countdown safely cancelled.`
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error("🔥 alerts.js error:", err);
    }
  });
};
