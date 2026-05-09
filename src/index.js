require('dotenv').config();

const crypto = require('crypto');
const mineflayer = require('mineflayer');
const createBotCommandManager = require('./commands/bot');
const handleSayCommand = require('./commands/say');
const createSortCommandController = require('./commands/sort');
const createSaveLoadController = require('./commands/save');
const createCraftCommandController = require('./commands/craft');
const createEventReactorController = require('./commands/eventreactor');

const COMMAND_PREFIX = '+';
const CENTER_BOT_NAME = process.env.CENTER_BOT_NAME || 'command-center';
const SERVER_IP = process.env.SERVER_IP;
const MINECRAFT_VERSION = process.env.MINECRAFT_VERSION || '1.21';
const DEBUG = /^(1|true|yes|on)$/i.test(process.env.DEBUG || '');
const AUTH_ANYWAYS = /^(1|true|yes|on)$/i.test(process.env.AUTH_ANYWAYS || '');
const AUTH_INITIAL_DELAY_MS = Number(process.env.AUTH_INITIAL_DELAY_MS || 500);
const AUTH_LOGIN_DELAY_MS = Number(process.env.AUTH_LOGIN_DELAY_MS || 800);
const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS || 10000);
const AUTH_WORLD_READY_WAIT_MS = 500;
const ADMIN_SET = new Set(
  (process.env.ADMIN || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
);

if (!SERVER_IP) {
  console.error('SERVER_IP is required in .env');
  process.exit(1);
}

if (ADMIN_SET.size === 0) {
  console.error('ADMIN is required in .env (comma separated usernames)');
  process.exit(1);
}

let sortCommands = null;
let craftCommands = null;
let eventReactorCommands = null;

function debugLog(message, extra) {
  if (!DEBUG) {
    return;
  }

  if (typeof extra === 'undefined') {
    console.log(`[debug] ${message}`);
    return;
  }

  console.log(`[debug] ${message}`, extra);
}

function parseServerAddress(serverAddress) {
  const [host, portRaw] = serverAddress.split(':');
  const parsedPort = Number(portRaw);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 25565;

  return { host, port };
}

function derivePassword(botName, serverIp) {
  const hash = crypto.createHash('sha256').update(`${botName}${serverIp}bot`).digest('hex');
  return hash.slice(0, 8);
}

function isAdmin(username) {
  return ADMIN_SET.has(username);
}

function whisperFrom(bot, username, message) {
  bot.chat(`/w ${username} ${message}`);
}

function getCompletionStrings(matches) {
  return (matches || [])
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }

      return item.match || item.text || item.command || '';
    })
    .map((value) => String(value).trim().replace(/^\//, '').toLowerCase())
    .filter(Boolean);
}

function tabComplete(bot, value) {
  return new Promise((resolve, reject) => {
    bot.tabComplete(value, (error, matches) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(matches || []);
    }, false, true);
  });
}

function formatReason(reason) {
  if (typeof reason === 'string') {
    return reason;
  }

  try {
    return JSON.stringify(reason);
  } catch (_) {
    return String(reason);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWorldReady(bot) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    const isPlayState = bot._client?.state === 'play';
    const hasWorld = Boolean(bot.world && bot.game?.dimension);
    const hasEntity = Boolean(bot.entity && bot.entity.position);
    if (isPlayState && hasWorld && hasEntity) {
      return true;
    }

    await sleep(250);
  }

  return false;
}

function sendAuthCommands(bot, password) {
  setTimeout(() => {
    if (bot._client?.state !== 'play') {
      debugLog(`auth-skip ${bot.username}: client not in play state before /register`);
      return;
    }

    bot.chat(`/register ${password}`);
    setTimeout(() => {
      if (bot._client?.state !== 'play') {
        debugLog(`auth-skip ${bot.username}: client not in play state before /login`);
        return;
      }

      bot.chat(`/login ${password}`);
    }, Math.max(0, AUTH_LOGIN_DELAY_MS));
  }, Math.max(0, AUTH_INITIAL_DELAY_MS));
}

function attachAutoAuthFlow(bot, serverIp) {
  let authSent = false;
  let ended = false;
  let authTimer = null;

  async function runAuthAttempt(triggerReason) {
    if (ended || authSent) {
      return;
    }

    try {
      const worldReady = await waitForWorldReady(bot);
      if (ended || authSent) {
        return;
      }

      debugLog(`auth-ready ${bot.username}: worldReady=${worldReady} trigger=${triggerReason}`);

      // World can report ready during proxy transitions; wait an extra 5 seconds
      // after readiness before issuing auth commands.
      await sleep(AUTH_WORLD_READY_WAIT_MS);
      if (ended || authSent) {
        return;
      }

      if (bot._client?.state !== 'play') {
        debugLog(`auth-skip ${bot.username}: client left play state after readiness wait`);
        return;
      }

      if (AUTH_ANYWAYS) {
        const password = derivePassword(bot.username, serverIp);
        debugLog(`auth-run ${bot.username}: AUTH_ANYWAYS enabled, issuing /register then /login`);
        sendAuthCommands(bot, password);
        authSent = true;
        return;
      }

      const matches = await tabComplete(bot, '/');
      const commands = new Set(getCompletionStrings(matches));
      const hasRegister = commands.has('register');
      const hasLogin = commands.has('login');

      debugLog(`auth-check ${bot.username}: register=${hasRegister} login=${hasLogin}`);

      if (!hasRegister || !hasLogin) {
        return;
      }

      const password = derivePassword(bot.username, serverIp);
      debugLog(`auth-run ${bot.username}: issuing /register then /login`);
      sendAuthCommands(bot, password);
      authSent = true;
    } catch (error) {
      console.warn(`[${bot.username}] auth command check failed: ${error.message}`);
    }
  }

  function scheduleAuthAttempt(triggerReason) {
    if (ended || authSent) {
      return;
    }

    if (authTimer) {
      debugLog(`auth-schedule skip ${bot.username}: already scheduled trigger=${triggerReason}`);
      return;
    }

    authTimer = setTimeout(() => {
      authTimer = null;
      runAuthAttempt(triggerReason).catch((error) => {
        console.warn(`[${bot.username}] auth scheduling error: ${error.message}`);
      });
    }, AUTH_WORLD_READY_WAIT_MS);

    debugLog(`auth-schedule ${bot.username}: trigger=${triggerReason} wait=${AUTH_WORLD_READY_WAIT_MS}ms`);
  }

  bot.on('login', () => {
    scheduleAuthAttempt('login');
  });

  bot.on('end', () => {
    ended = true;
    if (authTimer) {
      clearTimeout(authTimer);
      authTimer = null;
    }
  });
}

function createBot(botName, serverConfig) {
  debugLog(`create-bot ${botName} at ${serverConfig.host}:${serverConfig.port}`);

  const bot = mineflayer.createBot({
    host: serverConfig.host,
    port: serverConfig.port,
    username: botName,
    version: MINECRAFT_VERSION,
    physicsEnabled: true
  });

  attachAutoAuthFlow(bot, SERVER_IP);

  bot.on('login', () => {
    const displayName = bot.username || botName;
    console.log(`[${displayName}] logged in`);
    debugLog(`event login ${displayName}`);
  });

  bot.on('end', () => {
    const displayName = bot.username || botName;
    if (sortCommands) {
      sortCommands.disableSorter(botName);
    }
    if (craftCommands) {
      craftCommands.disableCrafter(botName);
    }
    if (eventReactorCommands) {
      eventReactorCommands.disableEventReactor(botName);
    }
    console.log(`[${displayName}] disconnected`);
    debugLog(`event end ${displayName}`);
  });

  bot.on('kicked', (reason) => {
    const displayName = bot.username || botName;
    const text = formatReason(reason);
    bot.__lastKickReasonText = text;
    console.log(`[${displayName}] kicked: ${text}`);
    debugLog(`event kicked ${displayName}`, text);
  });

  bot.on('error', (error) => {
    console.error(`[${bot.username}] error:`, error.message);
  });

  return bot;
}

const botCommands = createBotCommandManager({
  createBot,
  debugLog,
  onBeforeRemove: (botName) => {
    if (sortCommands) {
      sortCommands.disableSorter(botName);
    }
    if (craftCommands) {
      craftCommands.disableCrafter(botName);
    }
    if (eventReactorCommands) {
      eventReactorCommands.disableEventReactor(botName);
    }
  }
});

sortCommands = createSortCommandController({
  getManagedBot: botCommands.getManagedBot,
  hasManagedBot: botCommands.hasManagedBot,
  debugLog
});

craftCommands = createCraftCommandController({
  getManagedBot: botCommands.getManagedBot,
  hasManagedBot: botCommands.hasManagedBot,
  debugLog
});

eventReactorCommands = createEventReactorController({
  getManagedBot: botCommands.getManagedBot,
  hasManagedBot: botCommands.hasManagedBot,
  sortCommands,
  craftCommands,
  debugLog
});

const saveLoadCommands = createSaveLoadController({
  botCommands,
  sortCommands,
  craftCommands,
  serverConfig: parseServerAddress(SERVER_IP),
  debugLog
});

function parseControlCommand(message) {
  if (!message.startsWith(COMMAND_PREFIX)) {
    return null;
  }

  const trimmed = message.trim();
  const body = trimmed.slice(COMMAND_PREFIX.length).trim();
  if (!body) {
    return null;
  }

  const parts = body.split(/\s+/);
  const command = (parts.shift() || '').toLowerCase();

  return { command, parts, body };
}

function main() {
  const serverConfig = parseServerAddress(SERVER_IP);
  debugLog(`config auth_anyways=${AUTH_ANYWAYS}`);
  debugLog(`config minecraft_version=${MINECRAFT_VERSION}`);
  debugLog(`config auth_world_ready_wait_ms=${AUTH_WORLD_READY_WAIT_MS}`);
  debugLog(`config auth_initial_delay_ms=${AUTH_INITIAL_DELAY_MS} auth_login_delay_ms=${AUTH_LOGIN_DELAY_MS}`);
  debugLog(`config reconnect_delay_ms=${RECONNECT_DELAY_MS}`);

  let shuttingDown = false;
  let reconnectTimer = null;
  let commandCenter = null;

  function handleControlChat(username, message) {
    if (!commandCenter) {
      return;
    }

    if (username === commandCenter.username) {
      return;
    }

    const parsed = parseControlCommand(message);
    if (!parsed) {
      return;
    }

    debugLog(`command-received from ${username}: ${message}`);

    if (!isAdmin(username)) {
      debugLog(`command-denied for non-admin ${username}: ${message}`);
      whisperFrom(commandCenter, username, 'You dont have permition to use this command.');
      return;
    }

    let result;

    if (parsed.command === 'bot') {
      result = botCommands.handleBotCommand(parsed.parts, { serverConfig });
    } else if (parsed.command === 'say') {
      result = handleSayCommand(parsed.parts, {
        getManagedBot: botCommands.getManagedBot,
        debugLog
      });
    } else if (parsed.command === 'sort') {
      result = sortCommands.handleSortCommand(parsed.parts);
    } else if (parsed.command === 'save') {
      result = saveLoadCommands.handleSaveCommand(parsed.parts);
    } else if (parsed.command === 'load') {
      result = saveLoadCommands.handleLoadCommand(parsed.parts);
    } else if (parsed.command === 'craft') {
      result = craftCommands.handleCraftCommand(parsed.parts);
    } else if (parsed.command === 'eventreactor' || parsed.command === 'er') {
      result = eventReactorCommands.handleEventReactorCommand(parsed.parts);
    } else {
      result = 'Unknown command';
    }

    debugLog(`command-result for ${username}: ${result}`);

    whisperFrom(commandCenter, username, result);
  }

  function connectCommandCenter() {
    commandCenter = createBot(CENTER_BOT_NAME, serverConfig);
    commandCenter.on('chat', handleControlChat);

    commandCenter.on('end', () => {
      if (shuttingDown) {
        return;
      }

      if (reconnectTimer) {
        return;
      }

      debugLog(`command-center reconnect scheduled in ${RECONNECT_DELAY_MS}ms`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectCommandCenter();
      }, Math.max(1000, RECONNECT_DELAY_MS));
    });
  }

  connectCommandCenter();

  process.on('SIGINT', () => {
    shuttingDown = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    debugLog('received SIGINT, shutting down bots and sorters');
    sortCommands.disableAllSorters();
    craftCommands.disableAllCrafters();
    eventReactorCommands.disableAllEventReactors();

    botCommands.forEachManagedBot((bot) => {
      bot.end('Shutting down');
    });

    if (commandCenter) {
      commandCenter.end('Shutting down');
    }
    process.exit(0);
  });
}

main();
