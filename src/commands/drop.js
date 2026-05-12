function createDropCommandController(options) {
  const { getManagedBot, hasManagedBot, debugLog = () => {} } = options;

  async function dropAll(botName, bot) {
    try {
      const items = bot.inventory.items();
      if (items.length === 0) return;

      let droppedStacks = 0;
      // Drop all items sequentially and quickly using the drop window shortcut
      for (const item of items) {
        try {
          await bot.clickWindow(item.slot, 1, 4);
          droppedStacks++;
        } catch (e) {
          debugLog(`Failed to drop slot ${item.slot}: ${e.message}`);
        }
      }
      debugLog(`drop finished for ${botName}: stacks=${droppedStacks}`);
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

    dropAll(botName, bot).catch(e => {
        debugLog(`drop catch error: ${e.message}`);
    });

    return `Dropping all items for ${botName}`;
  }

  return {
    handleDropCommand
  };
}

module.exports = createDropCommandController;
