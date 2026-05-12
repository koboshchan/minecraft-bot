function createDropCommandController(options) {
  const { getManagedBot, hasManagedBot, debugLog = () => {} } = options;

  async function dropAll(botName, bot) {
    try {
      const items = bot.inventory.items();
      if (items.length === 0) return;

      // Drop all items without a delay
      for (const item of items) {
        if (bot.tossStack) {
          bot.tossStack(item).catch(() => {});
        } else {
          bot.toss(item.type, item.metadata, item.count).catch(() => {});
        }
      }
      debugLog(`drop finished for ${botName}: stacks=${items.length}`);
    } catch (error) {
      debugLog(`drop failed for ${botName}: ${error.message}`);
    }
  }

  function handleDropCommand(parts) {
    const botName = parts[0];

    if (!botName) {
      return 'Usage: +drop <botname>';
    }

    if (!hasManagedBot(botName)) {
      return `Bot ${botName} not found`;
    }

    const bot = getManagedBot(botName);
    if (!bot || !bot.inventory) {
      return `Bot ${botName} is not ready`;
    }

    if (bot.inventory.items().length === 0) {
      return `No items to drop for ${botName}`;
    }

    dropAll(botName, bot);

    return `Dropping all items for ${botName}`;
  }

  return {
    handleDropCommand
  };
}

module.exports = createDropCommandController;
