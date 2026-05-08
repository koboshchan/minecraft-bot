function createBotCommandManager(options) {
  const { createBot, onBeforeRemove, debugLog = () => {} } = options;
  const managedBots = new Map();
  const managedBotConfigs = new Map();
  const reconnectTimers = new Map();
  const intentionallyRemoving = new Set();

  const DEFAULT_REJOIN_MS = 10000;
  const TOO_FAST_REJOIN_MS = 30000;

  function getRejoinDelay(bot) {
    const reason = String(bot?.__lastKickReasonText || '').toLowerCase();
    if (reason.includes('logging in too fast') || reason.includes('too fast')) {
      return TOO_FAST_REJOIN_MS;
    }

    return DEFAULT_REJOIN_MS;
  }

  function attachManagedBotLifecycle(botName, bot) {
    bot.on('end', () => {
      if (intentionallyRemoving.has(botName)) {
        return;
      }

      if (!managedBotConfigs.has(botName)) {
        return;
      }

      managedBots.delete(botName);

      if (reconnectTimers.has(botName)) {
        return;
      }

      const delay = getRejoinDelay(bot);
      debugLog(`bot-rejoin scheduled: ${botName} in ${delay}ms`);

      const timer = setTimeout(() => {
        reconnectTimers.delete(botName);

        if (intentionallyRemoving.has(botName) || !managedBotConfigs.has(botName)) {
          return;
        }

        const serverConfig = managedBotConfigs.get(botName);
        const freshBot = createBot(botName, serverConfig);
        managedBots.set(botName, freshBot);
        attachManagedBotLifecycle(botName, freshBot);
        debugLog(`bot-rejoin attempt: ${botName}`);
      }, delay);

      reconnectTimers.set(botName, timer);
    });
  }

  function addManagedBot(botName, serverConfig) {
    if (managedBotConfigs.has(botName)) {
      debugLog(`bot-add skipped, already exists: ${botName}`);
      return { ok: false, message: `Bot ${botName} already exists` };
    }

    intentionallyRemoving.delete(botName);
    managedBotConfigs.set(botName, serverConfig);
    const bot = createBot(botName, serverConfig);
    managedBots.set(botName, bot);
    attachManagedBotLifecycle(botName, bot);
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

    const bot = managedBots.get(botName);

    if (onBeforeRemove) {
      onBeforeRemove(botName);
    }

    if (bot) {
      bot.end('Removed by command center');
    }

    managedBots.delete(botName);
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
    for (const bot of managedBots.values()) {
      callback(bot);
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

  return {
    handleBotCommand,
    getManagedBot,
    hasManagedBot,
    forEachManagedBot,
    removeManagedBot,
    getManagedBotNames
  };
}

module.exports = createBotCommandManager;
