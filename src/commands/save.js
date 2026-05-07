const fs = require('fs');
const path = require('path');

const SETTINGS_DIR = path.resolve('./settings');

function createSaveLoadController(options) {
  const { botCommands, sortCommands, serverConfig, debugLog = () => {} } = options;

  function ensureSettingsDir() {
    if (!fs.existsSync(SETTINGS_DIR)) {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    }
  }

  function settingsPath(name) {
    const safe = path.basename(name);
    return path.join(SETTINGS_DIR, `${safe}.json`);
  }

  function handleSaveCommand(parts) {
    const name = parts[0];
    if (!name) {
      return 'Usage: +save <name>';
    }

    const botNames = botCommands.getManagedBotNames();
    const bots = botNames.map((botName) => ({
      name: botName,
      sorterEnabled: sortCommands.isSorterEnabled(botName)
    }));

    const data = { bots };

    try {
      ensureSettingsDir();
      fs.writeFileSync(settingsPath(name), JSON.stringify(data, null, 2), 'utf8');
      debugLog(`save success: ${name}`, data);
      return `Saved ${bots.length} bot(s) to ${name}.json`;
    } catch (error) {
      debugLog(`save error: ${error.message}`);
      return `Save failed: ${error.message}`;
    }
  }

  function handleLoadCommand(parts) {
    const name = parts[0];
    if (!name) {
      return 'Usage: +load <name>';
    }

    const filePath = settingsPath(name);
    let data;

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      data = JSON.parse(raw);
    } catch (error) {
      debugLog(`load error reading ${name}: ${error.message}`);
      return `Load failed: could not read ${name}.json`;
    }

    if (!Array.isArray(data.bots)) {
      return `Load failed: invalid format in ${name}.json`;
    }

    const results = [];

    for (const entry of data.bots) {
      if (!entry.name) {
        continue;
      }

      if (!botCommands.hasManagedBot(entry.name)) {
        const addResult = botCommands.handleBotCommand(['add', entry.name], { serverConfig });
        results.push(addResult);
        debugLog(`load bot-add: ${entry.name}`, addResult);
      } else {
        results.push(`${entry.name} already exists`);
      }

      if (entry.sorterEnabled) {
        const sortResult = sortCommands.handleSortCommand([entry.name, 'enable']);
        debugLog(`load sort-enable: ${entry.name}`, sortResult);
      }
    }

    debugLog(`load success: ${name}`, results);
    return `Loaded ${data.bots.length} bot(s) from ${name}.json`;
  }

  return {
    handleSaveCommand,
    handleLoadCommand
  };
}

module.exports = createSaveLoadController;
