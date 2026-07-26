const { Worker } = require('worker_threads');
const path = require('path');
const { parseViewDistance } = require('../config');

function createBotCommandManager(options) {
  const { onBeforeRemove, botStates, debugLog = () => {} } = options;
  const managedBots = new Map();
  const managedBotConfigs = new Map();
  const reconnectTimers = new Map();
  const intentionallyRemoving = new Set();

  const commandRequests = new Map();
  let nextRequestId = 1;

  const DEFAULT_REJOIN_MS = 10000;
  const TOO_FAST_REJOIN_MS = 30000;

  function getRejoinDelay(kickReason) {
    const reason = String(kickReason || '').toLowerCase();
    if (reason.includes('logging in too fast') || reason.includes('too fast')) {
      return TOO_FAST_REJOIN_MS;
    }

    return DEFAULT_REJOIN_MS;
  }

  function handleWorkerEnd(botName, lastKickReason) {
    if (intentionallyRemoving.has(botName)) {
      return;
    }

    if (!managedBotConfigs.has(botName)) {
      return;
    }

    // Clean up worker reference
    const worker = managedBots.get(botName);
    if (worker) {
      try {
        worker.terminate();
      } catch (_) {}
      managedBots.delete(botName);
    }

    if (reconnectTimers.has(botName)) {
      return;
    }

    const delay = getRejoinDelay(lastKickReason);
    debugLog(`bot-rejoin scheduled: ${botName} in ${delay}ms`);

    const timer = setTimeout(() => {
      reconnectTimers.delete(botName);

      if (intentionallyRemoving.has(botName) || !managedBotConfigs.has(botName)) {
        return;
      }

      spawnBotWorker(botName);
      debugLog(`bot-rejoin attempt: ${botName}`);
    }, delay);

    reconnectTimers.set(botName, timer);
  }

  function spawnBotWorker(botName) {
    const serverConfig = managedBotConfigs.get(botName);
    const worker = new Worker(path.resolve(__dirname, '../worker.js'), {
      workerData: {
        botName,
        serverConfig,
        minecraftVersion: process.env.MINECRAFT_VERSION || '1.21',
        authAnyways: /^(1|true|yes|on)$/i.test(process.env.AUTH_ANYWAYS || ''),
        authInitialDelayMs: Number(process.env.AUTH_INITIAL_DELAY_MS || 500),
        authLoginDelayMs: Number(process.env.AUTH_LOGIN_DELAY_MS || 800),
        serverIp: process.env.SERVER_IP,
        debug: process.env.DEBUG === 'true' || process.env.DEBUG === '1',
        viewDistance: parseViewDistance(process.env.VIEW_DISTANCE)
      }
    });

    managedBots.set(botName, worker);

    worker.on('message', (msg) => {
      if (msg.type === 'command-result') {
        const req = commandRequests.get(msg.requestId);
        if (req) {
          clearTimeout(req.timeout);
          commandRequests.delete(msg.requestId);
          if (msg.features && botStates) {
            botStates.set(botName, msg.features);
          }
          req.resolve(msg.result);
        }
      } else if (msg.type === 'debug') {
        debugLog(msg.message, msg.extra);
      } else if (msg.type === 'kicked') {
        console.log(`[${botName}] kicked: ${msg.reasonText}`);
        worker.__lastKickReasonText = msg.reasonText;
      } else if (msg.type === 'error') {
        console.error(`[${botName}] error: ${msg.message}`);
      } else if (msg.type === 'login') {
        console.log(`[${botName}] logged in`);
      } else if (msg.type === 'end') {
        console.log(`[${botName}] disconnected`);
        handleWorkerEnd(botName, worker.__lastKickReasonText || msg.lastKickReasonText || '');
      }
    });

    worker.on('error', (err) => {
      console.error(`[${botName}] worker thread error:`, err.message);
    });

    worker.on('exit', (code) => {
      debugLog(`[${botName}] worker thread exited with code ${code}`);
      handleWorkerEnd(botName, worker.__lastKickReasonText || '');
    });
  }

  function addManagedBot(botName, serverConfig) {
    if (managedBotConfigs.has(botName)) {
      debugLog(`bot-add skipped, already exists: ${botName}`);
      return { ok: false, message: `Bot ${botName} already exists` };
    }

    intentionallyRemoving.delete(botName);
    managedBotConfigs.set(botName, serverConfig);
    
    // Initialize default states in main thread
    botStates.set(botName, {
      sorterEnabled: false,
      crafterEnabled: false,
      eventReactorEnabled: false
    });

    spawnBotWorker(botName);
    debugLog(`bot-add success: ${botName}`);
    return { ok: true, message: `Added bot ${botName}` };
  }

  function removeManagedBot(botName) {
    if (!managedBotConfigs.has(botName)) {
      debugLog(`bot-remove skipped, missing: ${botName}`);
      return { ok: false, message: `Bot ${botName} does not exist` };
    }

    intentionallyRemoving.add(botName);

    if (reconnectTimers.has(botName)) {
      clearTimeout(reconnectTimers.get(botName));
      reconnectTimers.delete(botName);
    }

    managedBotConfigs.delete(botName);
    botStates.delete(botName);

    const worker = managedBots.get(botName);

    if (onBeforeRemove) {
      onBeforeRemove(botName);
    }

    if (worker) {
      worker.postMessage({ type: 'shutdown' });
      setTimeout(() => {
        try {
          worker.terminate();
        } catch (_) {}
      }, 500);
      managedBots.delete(botName);
    }

    debugLog(`bot-remove success: ${botName}`);
    return { ok: true, message: `Removed bot ${botName}` };
  }

  function listManagedBots() {
    const names = Array.from(managedBotConfigs.keys());
    debugLog(`bot-list count=${names.length}`);
    if (names.length === 0) {
      return 'No managed bots';
    }

    return `Managed bots: ${names.join(', ')}`;
  }

  function getManagedBot(botName) {
    return managedBots.get(botName);
  }

  function hasManagedBot(botName) {
    return managedBotConfigs.has(botName);
  }

  function forEachManagedBot(callback) {
    for (const worker of managedBots.values()) {
      callback(worker);
    }
  }

  function handleBotCommand(parts, context) {
    const { serverConfig } = context;
    const sub = (parts[0] || '').toLowerCase();

    if (sub === 'add') {
      const name = parts[1];
      if (!name) {
        return 'Usage: +bot add <botname>';
      }

      return addManagedBot(name, serverConfig).message;
    }

    if (sub === 'remove') {
      const name = parts[1];
      if (!name) {
        return 'Usage: +bot remove <botname>';
      }

      return removeManagedBot(name).message;
    }

    if (sub === 'list') {
      return listManagedBots();
    }

    return 'Usage: +bot add <botname> | +bot remove <botname> | +bot list';
  }

  function getManagedBotNames() {
    return Array.from(managedBotConfigs.keys());
  }

  function sendCommandToWorker(botName, command, parts) {
    const worker = managedBots.get(botName);
    if (!worker) {
      return Promise.resolve(`Bot ${botName} thread is not active`);
    }

    return new Promise((resolve) => {
      const requestId = nextRequestId++;
      const timeout = setTimeout(() => {
        commandRequests.delete(requestId);
        resolve(`Command +${command} timed out for ${botName}`);
      }, 15000);

      commandRequests.set(requestId, { resolve, timeout });
      worker.postMessage({ type: 'command', command, parts, requestId });
    });
  }

  return {
    handleBotCommand,
    getManagedBot,
    hasManagedBot,
    forEachManagedBot,
    removeManagedBot,
    getManagedBotNames,
    sendCommandToWorker
  };
}

module.exports = createBotCommandManager;
