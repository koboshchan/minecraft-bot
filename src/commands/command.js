function handleSlashCommand(parts, context) {
  const { getManagedBot, debugLog = () => {} } = context;
  const botName = parts[0];
  const slashCommand = parts.slice(1).join(' ');

  if (!botName || !slashCommand) {
    return 'Usage: +command <botname> </command args>';
  }

  if (!slashCommand.startsWith('/')) {
    return 'Command must start with /';
  }

  const bot = getManagedBot(botName);
  if (!bot) {
    debugLog(`command failed: bot missing ${botName}`);
    return `Bot ${botName} does not exist`;
  }

  debugLog(`command on ${botName}: ${slashCommand}`);
  bot.chat(slashCommand);
  return `Executed command on ${botName}`;
}

module.exports = handleSlashCommand;
