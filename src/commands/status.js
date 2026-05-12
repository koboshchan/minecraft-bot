function createStatusCommandController(options) {
  const { getManagedBot, hasManagedBot, sortCommands, craftCommands, eventReactorCommands } = options;

  function handleStatusCommand(parts) {
    const botName = parts[0];

    if (!botName) {
      return 'Usage: +status <botname>';
    }

    if (!hasManagedBot(botName)) {
      return `Bot ${botName} not found`;
    }

    const bot = getManagedBot(botName);
    if (!bot || !bot.entity) {
      return `Bot ${botName} is not fully spawned yet.`;
    }

    const health = bot.health;
    const food = bot.food;
    const pos = bot.entity.position;
    const px = Math.floor(pos.x);
    const py = Math.floor(pos.y);
    const pz = Math.floor(pos.z);
    
    // XP and levels 
    const xpLevel = bot.experience ? bot.experience.level : 0;
    const xpPoints = bot.experience ? bot.experience.points : 0;

    const enabledFeatures = [];
    if (sortCommands && sortCommands.isSorterEnabled(botName)) enabledFeatures.push('Sorter');
    if (craftCommands && craftCommands.isCrafterEnabled(botName)) enabledFeatures.push('Crafter');
    if (eventReactorCommands && eventReactorCommands.isEventReactorEnabled(botName)) enabledFeatures.push('EventReactor');

    const featuresString = enabledFeatures.length > 0 ? enabledFeatures.join(', ') : 'None';

    return `Status [${botName}]: Position: ${px}, ${py}, ${pz} | Health: ${health}/20 | Hunger: ${food}/20 | XP: Lvl ${xpLevel} (${Math.round(xpPoints)} pts) | Enabled: ${featuresString}`;
  }

  return {
    handleStatusCommand
  };
}

module.exports = createStatusCommandController;
