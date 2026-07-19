const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
const mineflayer = require('mineflayer');
const createSortCommandController = require('./commands/sort');
const createCraftCommandController = require('./commands/craft');
const createDropCommandController = require('./commands/drop');
const createEventReactorController = require('./commands/eventreactor');
const createStatusCommandController = require('./commands/status');
const injectCraftPlugin = require('./plugins/craft');

const {
  botName,
  serverConfig,
  minecraftVersion,
  authAnyways,
  authInitialDelayMs,
  authLoginDelayMs,
  serverIp
} = workerData;

const AUTH_WORLD_READY_WAIT_MS = 500;

function debugLog(message, extra) {
  parentPort.postMessage({ type: 'debug', message, extra });
}

function derivePassword(name, ip) {
  const hash = crypto.createHash('sha256').update(`${name}${ip}bot`).digest('hex');
  return hash.slice(0, 8);
}

function formatReason(reason) {
  if (typeof reason === 'string') return reason;
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

function getCompletionStrings(matches) {
  return (matches || [])
    .map((item) => {
      if (typeof item === 'string') return item;
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
    }, Math.max(0, authLoginDelayMs));
  }, Math.max(0, authInitialDelayMs));
}

function attachAutoAuthFlow(bot, ip) {
  let authSent = false;
  let ended = false;
  let authTimer = null;

  async function runAuthAttempt(triggerReason) {
    if (ended || authSent) return;

    try {
      const worldReady = await waitForWorldReady(bot);
      if (ended || authSent) return;

      debugLog(`auth-ready ${bot.username}: worldReady=${worldReady} trigger=${triggerReason}`);
      await sleep(AUTH_WORLD_READY_WAIT_MS);
      if (ended || authSent) return;

      if (bot._client?.state !== 'play') {
        debugLog(`auth-skip ${bot.username}: client left play state after readiness wait`);
        return;
      }

      if (authAnyways) {
        const password = derivePassword(bot.username, ip);
        debugLog(`auth-run ${bot.username}: authAnyways enabled, issuing /register then /login`);
        sendAuthCommands(bot, password);
        authSent = true;
        return;
      }

      const matches = await tabComplete(bot, '/');
      const commands = new Set(getCompletionStrings(matches));
      const hasRegister = commands.has('register');
      const hasLogin = commands.has('login');

      debugLog(`auth-check ${bot.username}: register=${hasRegister} login=${hasLogin}`);

      if (!hasRegister || !hasLogin) return;

      const password = derivePassword(bot.username, ip);
      debugLog(`auth-run ${bot.username}: issuing /register then /login`);
      sendAuthCommands(bot, password);
      authSent = true;
    } catch (error) {
      debugLog(`[${bot.username}] auth command check failed: ${error.message}`);
    }
  }

  function scheduleAuthAttempt(triggerReason) {
    if (ended || authSent) return;
    if (authTimer) {
      debugLog(`auth-schedule skip ${bot.username}: already scheduled trigger=${triggerReason}`);
      return;
    }

    authTimer = setTimeout(() => {
      authTimer = null;
      runAuthAttempt(triggerReason).catch((error) => {
        debugLog(`[${bot.username}] auth scheduling error: ${error.message}`);
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

// Instantiate bot
const bot = mineflayer.createBot({
  host: serverConfig.host,
  port: serverConfig.port,
  username: botName,
  version: minecraftVersion,
  physicsEnabled: false
});

injectCraftPlugin(bot);
attachAutoAuthFlow(bot, serverIp);

// Local controllers
const localBotHelpers = {
  getManagedBot: (name) => (name === botName ? bot : null),
  hasManagedBot: (name) => name === botName,
  debugLog
};

const sortCommands = createSortCommandController(localBotHelpers);
const craftCommands = createCraftCommandController(localBotHelpers);
const dropCommands = createDropCommandController(localBotHelpers);

const eventReactorCommands = createEventReactorController({
  ...localBotHelpers,
  sortCommands,
  craftCommands
});

const statusCommands = createStatusCommandController({
  ...localBotHelpers,
  sortCommands,
  craftCommands,
  eventReactorCommands
});

// Event reporting
bot.on('craft_debug', (msg) => {
  debugLog(`[craft] ${msg}`);
});

bot.on('login', () => {
  parentPort.postMessage({ type: 'login' });
});

bot.on('end', () => {
  sortCommands.disableAllSorters();
  if (craftCommands) craftCommands.disableAllCrafters();
  if (eventReactorCommands) eventReactorCommands.disableAllEventReactors();
  
  parentPort.postMessage({
    type: 'end',
    lastKickReasonText: bot.__lastKickReasonText || ''
  });
});

bot.on('kicked', (reason) => {
  const text = formatReason(reason);
  bot.__lastKickReasonText = text;
  parentPort.postMessage({ type: 'kicked', reasonText: text });
});

bot.on('error', (error) => {
  parentPort.postMessage({ type: 'error', message: error.message });
});

// Handle incoming commands from parent thread
parentPort.on('message', async (msg) => {
  const { type, command, parts } = msg;

  if (type === 'command') {
    let result = '';
    if (command === 'sort') {
      result = sortCommands.handleSortCommand(parts);
    } else if (command === 'craft') {
      result = craftCommands ? craftCommands.handleCraftCommand(parts) : 'Crafting disabled';
    } else if (command === 'drop') {
      result = dropCommands.handleDropCommand(parts);
    } else if (command === 'eventreactor' || command === 'er') {
      result = eventReactorCommands.handleEventReactorCommand(parts);
    } else if (command === 'status') {
      result = statusCommands.handleStatusCommand(parts);
    } else if (command === 'say') {
      const text = parts.slice(1).join(' ');
      if (text) {
        bot.chat(text);
        result = `Sent message from ${botName}`;
      } else {
        result = 'Usage: +say <botname> <message>';
      }
    } else {
      result = `Unknown sub-command: ${command}`;
    }

    // Report command execution result and updated feature statuses back to parent
    parentPort.postMessage({
      type: 'command-result',
      requestId: msg.requestId,
      result,
      features: {
        sorterEnabled: sortCommands.isSorterEnabled(botName),
        crafterEnabled: craftCommands ? craftCommands.isCrafterEnabled(botName) : false,
        eventReactorEnabled: eventReactorCommands ? eventReactorCommands.isEventReactorEnabled(botName) : false
      }
    });
  } else if (type === 'shutdown') {
    bot.end('Removed by command center');
    process.exit(0);
  }
});
