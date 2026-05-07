function createBotCommandManager(options) {
  const { createBot, onBeforeRemove, debugLog = () => {} } = options;
  const managedBots = new Map();

  function addManagedBot(botName, serverConfig) {
    if (managedBots.has(botName)) {
      debugLog(`bot-add skipped, already exists: ${botName}`);
      return { ok: false, message: `Bot ${botName} already exists` };
    }

    const bot = createBot(botName, serverConfig);
    managedBots.set(botName, bot);
    debugLog(`bot-add success: ${botName}`);
    return { ok: true, message: `Added bot ${botName}` };
  }

  function removeManagedBot(botName) {
    const bot = managedBots.get(botName);
    if (!bot) {
      debugLog(`bot-remove skipped, missing: ${botName}`);
      return { ok: false, message: `Bot ${botName} does not exist` };
    }

    if (onBeforeRemove) {
      onBeforeRemove(botName);
    }

    bot.end('Removed by command center');
    managedBots.delete(botName);
    debugLog(`bot-remove success: ${botName}`);
    return { ok: true, message: `Removed bot ${botName}` };
  }

  function listManagedBots() {
    const names = Array.from(managedBots.keys());
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
    return managedBots.has(botName);
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
    return Array.from(managedBots.keys());
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
