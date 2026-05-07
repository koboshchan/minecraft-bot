function handleSayCommand(parts, context) {
  const { getManagedBot, debugLog = () => {} } = context;
  const botName = parts[0];
  const text = parts.slice(1).join(' ');

  if (!botName || !text) {
    return 'Usage: +say <botname> <message>';
  }

  const bot = getManagedBot(botName);
  if (!bot) {
    debugLog(`say failed: bot missing ${botName}`);
    return `Bot ${botName} does not exist`;
  }

  debugLog(`say from ${botName}: ${text}`);
  bot.chat(text);
  return `Sent message from ${botName}`;
}

module.exports = handleSayCommand;
