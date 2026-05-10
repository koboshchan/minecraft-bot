function createDropCommandController(options) {
  const { getManagedBot, hasManagedBot, debugLog = () => {} } = options;
  const activeDrops = new Set();

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function tossStackAsync(bot, item) {
    return new Promise((resolve, reject) => {
      try {
        bot.toss(item.type, item.metadata ?? null, item.count, (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function dropAll(botName, bot) {
    activeDrops.add(botName);
    let droppedStacks = 0;

    try {
      while (true) {
        if (!bot || !bot.inventory || bot._client?.state !== 'play') {
          break;
        }

        const stack = bot.inventory.items()[0];
        if (!stack) {
          break;
        }

        await tossStackAsync(bot, stack);
        droppedStacks += 1;
        await sleep(70);
      }

      debugLog(`drop finished for ${botName}: stacks=${droppedStacks}`);
    } catch (error) {
      debugLog(`drop failed for ${botName}: ${error.message}`);
    } finally {
      activeDrops.delete(botName);
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

    if (activeDrops.has(botName)) {
      return `Drop already in progress for ${botName}`;
    }

    const bot = getManagedBot(botName);
    if (!bot || !bot.inventory) {
      return `Bot ${botName} is not ready`;
    }

    if (bot.inventory.items().length === 0) {
      return `No items to drop for ${botName}`;
    }

    dropAll(botName, bot).catch((error) => {
      debugLog(`drop unexpected failure for ${botName}: ${error.message}`);
    });

    return `Dropping all items for ${botName}`;
  }

  return {
    handleDropCommand
  };
}

module.exports = createDropCommandController;