require('dotenv').config();

const crypto = require('crypto');
const mineflayer = require('mineflayer');

const COMMAND_PREFIX = '+';
const CENTER_BOT_NAME = process.env.CENTER_BOT_NAME || 'command-center';
const SERVER_IP = process.env.SERVER_IP;
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

const managedBots = new Map();

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
      const matches = await tabComplete(bot, '/');
      const commands = new Set(getCompletionStrings(matches));
      const hasRegister = commands.has('register');
      const hasLogin = commands.has('login');

      if (!hasRegister || !hasLogin) {
        return;
      }

      const password = derivePassword(bot.username, serverIp);
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
  const bot = mineflayer.createBot({
    host: serverConfig.host,
    port: serverConfig.port,
    username: botName
  });

  attachAutoAuthFlow(bot, SERVER_IP);

  bot.on('login', () => {
    console.log(`[${bot.username}] logged in`);
  });

  bot.on('end', () => {
    console.log(`[${bot.username}] disconnected`);
  });

  bot.on('kicked', (reason) => {
    console.log(`[${bot.username}] kicked: ${reason}`);
  });

  bot.on('error', (error) => {
    console.error(`[${bot.username}] error:`, error.message);
  });

  return bot;
}

function addManagedBot(botName, serverConfig) {
  if (managedBots.has(botName)) {
    return { ok: false, message: `Bot ${botName} already exists` };
  }

  const bot = createBot(botName, serverConfig);
  managedBots.set(botName, bot);
  return { ok: true, message: `Added bot ${botName}` };
}

function removeManagedBot(botName) {
  const bot = managedBots.get(botName);
  if (!bot) {
    return { ok: false, message: `Bot ${botName} does not exist` };
  }

  bot.end('Removed by command center');
  managedBots.delete(botName);
  return { ok: true, message: `Removed bot ${botName}` };
}

function listManagedBots() {
  const names = Array.from(managedBots.keys());
  if (names.length === 0) {
    return 'No managed bots';
  }

  return `Managed bots: ${names.join(', ')}`;
}

function getManagedBot(botName) {
  return managedBots.get(botName);
}

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

function handleBotCommand(parts, serverConfig) {
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

function handleSayCommand(parts) {
  const botName = parts[0];
  const text = parts.slice(1).join(' ');

  if (!botName || !text) {
    return 'Usage: +say <botname> <message>';
  }

  const bot = getManagedBot(botName);
  if (!bot) {
    return `Bot ${botName} does not exist`;
  }

  bot.chat(text);
  return `Sent message from ${botName}`;
}

function handleSlashCommand(parts) {
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
    return `Bot ${botName} does not exist`;
  }

  bot.chat(slashCommand);
  return `Executed command on ${botName}`;
}

function main() {
  const serverConfig = parseServerAddress(SERVER_IP);
  const commandCenter = createBot(CENTER_BOT_NAME, serverConfig);

  commandCenter.on('chat', (username, message) => {
    if (username === commandCenter.username) {
      return;
    }

    const parsed = parseControlCommand(message);
    if (!parsed) {
      return;
    }

    if (!isAdmin(username)) {
      whisperFrom(commandCenter, username, "You dont have permition to use this command.");
      return;
    }

    let result;

    if (parsed.command === 'bot') {
      result = handleBotCommand(parsed.parts, serverConfig);
    } else if (parsed.command === 'say') {
      result = handleSayCommand(parsed.parts);
    } else if (parsed.command === 'command') {
      result = handleSlashCommand(parsed.parts);
    } else {
      result = 'Unknown command';
    }

    whisperFrom(commandCenter, username, result);
  });

  process.on('SIGINT', () => {
    for (const bot of managedBots.values()) {
      bot.end('Shutting down');
    }

    commandCenter.end('Shutting down');
    process.exit(0);
  });
}

main();
