require('dotenv').config();

const crypto = require('crypto');
const mineflayer = require('mineflayer');
const createBotCommandManager = require('./commands/bot');
const handleSayCommand = require('./commands/say');
const handleSlashCommand = require('./commands/command');
const createSortCommandController = require('./commands/sort');
const createSaveLoadController = require('./commands/save');
const createCraftCommandController = require('./commands/craft');

const COMMAND_PREFIX = '+';
const CENTER_BOT_NAME = process.env.CENTER_BOT_NAME || 'command-center';
const SERVER_IP = process.env.SERVER_IP;
const DEBUG = /^(1|true|yes|on)$/i.test(process.env.DEBUG || '');
const AUTH_ANYWAYS = /^(1|true|yes|on)$/i.test(process.env.AUTH_ANYWAYS || '');
const ADMIN_SET = new Set(
  (process.env.ADMIN || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
);

if (!SERVER_IP) {
  console.error('SERVER_IP is required in .env');
  process.exit(1);
}

if (ADMIN_SET.size === 0) {
  console.error('ADMIN is required in .env (comma separated usernames)');
  process.exit(1);
}

let sortCommands = null;

function debugLog(message, extra) {
  if (!DEBUG) {
    return;
  }

  if (typeof extra === 'undefined') {
    console.log(`[debug] ${message}`);
    return;
  }

  console.log(`[debug] ${message}`, extra);
}

function parseServerAddress(serverAddress) {
  const [host, portRaw] = serverAddress.split(':');
  const parsedPort = Number(portRaw);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 25565;

  return { host, port };
}

function derivePassword(botName, serverIp) {
  const hash = crypto.createHash('sha256').update(`${botName}${serverIp}bot`).digest('hex');
  return hash.slice(0, 8);
}

function isAdmin(username) {
  return ADMIN_SET.has(username);
}

function whisperFrom(bot, username, message) {
  bot.chat(`/w ${username} ${message}`);
}

function getCompletionStrings(matches) {
  return (matches || [])
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }

      return item.match || item.text || item.command || '';
    })
    .map((value) => String(value).trim().replace(/^\//, '').toLowerCase())
    .filter(Boolean);
}

function tabComplete(bot, value) {
  return new Promise((resolve, reject) => {
    bot.tabComplete(value, (error, matches) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(matches || []);
    }, false, true);
  });
}

function attachAutoAuthFlow(bot, serverIp) {
  let authTried = false;

  bot.on('spawn', async () => {
    if (authTried) {
      return;
    }

    authTried = true;

    try {
      if (AUTH_ANYWAYS) {
        const password = derivePassword(bot.username, serverIp);
        debugLog(`auth-run ${bot.username}: AUTH_ANYWAYS enabled, issuing /register then /login`);
        bot.chat(`/register ${password}`);
        setTimeout(() => {
          bot.chat(`/login ${password}`);
        }, 1500);
        return;
      }

      const matches = await tabComplete(bot, '/');
      const commands = new Set(getCompletionStrings(matches));
      const hasRegister = commands.has('register');
      const hasLogin = commands.has('login');

      debugLog(`auth-check ${bot.username}: register=${hasRegister} login=${hasLogin}`);

      if (!hasRegister || !hasLogin) {
        return;
      }

      const password = derivePassword(bot.username, serverIp);
      debugLog(`auth-run ${bot.username}: issuing /register then /login`);
      bot.chat(`/register ${password}`);
      setTimeout(() => {
        bot.chat(`/login ${password}`);
      }, 1500);
    } catch (error) {
      console.warn(`[${bot.username}] auth command check failed: ${error.message}`);
    }
  });
}

function createBot(botName, serverConfig) {
  debugLog(`create-bot ${botName} at ${serverConfig.host}:${serverConfig.port}`);

  const bot = mineflayer.createBot({
    host: serverConfig.host,
    port: serverConfig.port,
    username: botName,
    physicsEnabled: true
  });

  attachAutoAuthFlow(bot, SERVER_IP);

  bot.on('login', () => {
    console.log(`[${bot.username}] logged in`);
    debugLog(`event login ${bot.username}`);
  });

  bot.on('end', () => {
    if (sortCommands) {
      sortCommands.disableSorter(bot.username);
    }
    if (craftCommands) {
      craftCommands.disableCrafter(bot.username);
    }
    console.log(`[${bot.username}] disconnected`);
    debugLog(`event end ${bot.username}`);
  });

  bot.on('kicked', (reason) => {
    console.log(`[${bot.username}] kicked: ${reason}`);
    debugLog(`event kicked ${bot.username}`, reason);
  });

  bot.on('error', (error) => {
    console.error(`[${bot.username}] error:`, error.message);
  });

  return bot;
}

const botCommands = createBotCommandManager({
  createBot,
  debugLog,
  onBeforeRemove: (botName) => {
    if (sortCommands) {
      sortCommands.disableSorter(botName);
    }
  }
});

sortCommands = createSortCommandController({
  getManagedBot: botCommands.getManagedBot,
  hasManagedBot: botCommands.hasManagedBot,
  debugLog
});

const saveLoadCommands = createSaveLoadController({
  botCommands,
  sortCommands,
  serverConfig: parseServerAddress(SERVER_IP),
  debugLog
});

const craftCommands = createCraftCommandController({
  getManagedBot: botCommands.getManagedBot,
  hasManagedBot: botCommands.hasManagedBot,
  debugLog
});

function parseControlCommand(message) {
  if (!message.startsWith(COMMAND_PREFIX)) {
    return null;
  }

  const trimmed = message.trim();
  const body = trimmed.slice(COMMAND_PREFIX.length).trim();
  if (!body) {
    return null;
  }

  const parts = body.split(/\s+/);
  const command = (parts.shift() || '').toLowerCase();

  return { command, parts, body };
}

function main() {
  const serverConfig = parseServerAddress(SERVER_IP);
  debugLog(`config auth_anyways=${AUTH_ANYWAYS}`);
  const commandCenter = createBot(CENTER_BOT_NAME, serverConfig);

  commandCenter.on('chat', (username, message) => {
    if (username === commandCenter.username) {
      return;
    }

    const parsed = parseControlCommand(message);
    if (!parsed) {
      return;
    }

    debugLog(`command-received from ${username}: ${message}`);

    if (!isAdmin(username)) {
      debugLog(`command-denied for non-admin ${username}: ${message}`);
      whisperFrom(commandCenter, username, 'You dont have permition to use this command.');
      return;
    }

    let result;

    if (parsed.command === 'bot') {
      result = botCommands.handleBotCommand(parsed.parts, { serverConfig });
    } else if (parsed.command === 'say') {
      result = handleSayCommand(parsed.parts, {
        getManagedBot: botCommands.getManagedBot,
        debugLog
      });
    } else if (parsed.command === 'command') {
      result = handleSlashCommand(parsed.parts, {
        getManagedBot: botCommands.getManagedBot,
        debugLog
      });
    } else if (parsed.command === 'sort') {
      result = sortCommands.handleSortCommand(parsed.parts);
    } else if (parsed.command === 'save') {
      result = saveLoadCommands.handleSaveCommand(parsed.parts);
    } else if (parsed.command === 'load') {
      result = saveLoadCommands.handleLoadCommand(parsed.parts);
    } else if (parsed.command === 'craft') {
      result = craftCommands.handleCraftCommand(parsed.parts);
    } else {
      result = 'Unknown command';
    }

    debugLog(`command-result for ${username}: ${result}`);

    whisperFrom(commandCenter, username, result);
  });

  process.on('SIGINT', () => {
    debugLog('received SIGINT, shutting down bots and sorters');
    sortCommands.disableAllSorters();
    craftCommands.disableAllCrafters();

    botCommands.forEachManagedBot((bot) => {
      bot.end('Shutting down');
    });

    commandCenter.end('Shutting down');
    process.exit(0);
  });
}

main();
