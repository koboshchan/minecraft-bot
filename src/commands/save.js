const fs = require('fs');
const path = require('path');

const SETTINGS_DIR = path.resolve('./settings');
const DEFAULT_LOAD_JOIN_INTERVAL_MS = 5000;

function createSaveLoadController(options) {
  const { botCommands, sortCommands, craftCommands, serverConfig, debugLog = () => {} } = options;

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
      sorterEnabled: sortCommands.isSorterEnabled(botName),
      crafterEnabled: craftCommands ? craftCommands.isCrafterEnabled(botName) : false
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
    const waitMsRaw = parts[1];
    if (!name) {
      return 'Usage: +load <name> [waitMs]';
    }

    let waitMs = DEFAULT_LOAD_JOIN_INTERVAL_MS;
    if (typeof waitMsRaw !== 'undefined') {
      const parsed = Number(waitMsRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return 'Usage: +load <name> [waitMs] (waitMs must be a non-negative number)';
      }

      waitMs = Math.floor(parsed);
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

    const validEntries = data.bots.filter((entry) => entry && entry.name);
    const existing = [];
    const toAdd = [];

    for (const entry of validEntries) {
      if (botCommands.hasManagedBot(entry.name)) {
        existing.push(entry);
      } else {
        toAdd.push(entry);
      }
    }

    const applyFeatures = (entry) => {
      if (entry.sorterEnabled) {
        const sortResult = sortCommands.handleSortCommand([entry.name, 'enable']);
        debugLog(`load sort-enable: ${entry.name}`, sortResult);
      }

      if (entry.crafterEnabled && craftCommands) {
        const craftResult = craftCommands.handleCraftCommand([entry.name, 'enable']);
        debugLog(`load craft-enable: ${entry.name}`, craftResult);
      }
    };

    for (const entry of existing) {
      debugLog(`load bot-exists: ${entry.name}`);
      applyFeatures(entry);
    }

    toAdd.forEach((entry, index) => {
      const delay = index * waitMs;
      debugLog(`load bot-join scheduled: ${entry.name} in ${delay}ms`);
      setTimeout(() => {
        console.log(`[load] joining bot ${entry.name} (${index + 1}/${toAdd.length})`);
        const addResult = botCommands.handleBotCommand(['add', entry.name], { serverConfig });
        debugLog(`load bot-add: ${entry.name}`, addResult);
        applyFeatures(entry);
      }, delay);
    });

    debugLog(`load scheduled: ${name}`, {
      existing: existing.length,
      toAdd: toAdd.length,
      joinIntervalMs: waitMs
    });

    return `Load scheduled from ${name}.json: ${existing.length} existing bot(s) restored now, ${toAdd.length} bot(s) joining every ${waitMs}ms`;
  }

  return {
    handleSaveCommand,
    handleLoadCommand
  };
}

module.exports = createSaveLoadController;
