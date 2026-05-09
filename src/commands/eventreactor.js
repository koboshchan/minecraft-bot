function createEventReactorController(options) {
  const {
    getManagedBot,
    hasManagedBot,
    sortCommands,
    craftCommands,
    debugLog = () => {}
  } = options;

  const reactorStates = new Map();

  const TRIGGERS = new Set(['item_pickup', 'inventory_full', 'open_chest', 'low_health']);
  const REACTIONS = new Set([
    'say_in_chat',
    'run_command',
    'toggle_feature',
    'enable_feature',
    'disable_feature',
    'show_notification'
  ]);
  const FEATURES = new Set(['craft', 'sort']);

  function ticksToMillis(ticks) {
    const clamped = Math.max(0, Number.isFinite(ticks) ? ticks : 0);
    return clamped * 50;
  }

  function isInventoryFull(bot) {
    const inv = bot.inventory;
    if (!inv || !Array.isArray(inv.slots)) return false;

    const start = Number.isFinite(inv.inventoryStart) ? inv.inventoryStart : 9;
    const end = Number.isFinite(inv.inventoryEnd) ? inv.inventoryEnd : 45;

    for (let i = start; i < end; i++) {
      if (!inv.slots[i]) return false;
    }

    return true;
  }

  function isLowHealth(bot, threshold) {
    const health = Number(bot.health);
    if (!Number.isFinite(health)) return false;
    return health <= threshold;
  }

  function maybeTrigger(state, eventName) {
    if (!state.enabled) return;
    if (state.config.triggerEvent !== eventName) return;

    const cooldownMs = ticksToMillis(state.config.cooldownTicks);
    const now = Date.now();
    if (cooldownMs > 0 && now - state.lastTriggerAt < cooldownMs) {
      return;
    }

    runReaction(state, eventName);
    state.lastTriggerAt = now;
  }

  function runFeatureReaction(state, mode) {
    const botName = state.botName;
    const feature = state.config.targetFeature;

    if (feature === 'craft' && craftCommands) {
      if (mode === 'toggle') {
        if (craftCommands.isCrafterEnabled(botName)) {
          craftCommands.handleCraftCommand([botName, 'disable']);
        } else {
          craftCommands.handleCraftCommand([botName, 'enable']);
        }
        return;
      }

      craftCommands.handleCraftCommand([botName, mode]);
      return;
    }

    if (feature === 'sort' && sortCommands) {
      if (mode === 'toggle') {
        if (sortCommands.isSorterEnabled(botName)) {
          sortCommands.handleSortCommand([botName, 'disable']);
        } else {
          sortCommands.handleSortCommand([botName, 'enable']);
        }
        return;
      }

      sortCommands.handleSortCommand([botName, mode]);
    }
  }

  function runReaction(state, eventName) {
    const bot = state.bot;

    switch (state.config.reaction) {
      case 'say_in_chat': {
        const message = state.config.chatMessage.trim();
        if (message) bot.chat(message);
        break;
      }
      case 'run_command': {
        const cmd = state.config.command.trim();
        if (!cmd) break;
        bot.chat(cmd.startsWith('/') ? cmd : `/${cmd}`);
        break;
      }
      case 'toggle_feature': {
        runFeatureReaction(state, 'toggle');
        break;
      }
      case 'enable_feature': {
        runFeatureReaction(state, 'enable');
        break;
      }
      case 'disable_feature': {
        runFeatureReaction(state, 'disable');
        break;
      }
      case 'show_notification': {
        debugLog(`eventreactor ${state.botName}: triggered by ${eventName}`);
        break;
      }
      default:
        break;
    }
  }

  function attachReactor(state) {
    const { bot } = state;

    state.onCollect = (collector) => {
      if (!state.enabled || !bot.entity || !collector) return;
      if (collector.id !== bot.entity.id) return;
      maybeTrigger(state, 'item_pickup');
    };

    state.onWindowOpen = () => {
      if (!state.enabled) return;
      maybeTrigger(state, 'open_chest');
    };

    state.checkInterval = setInterval(() => {
      if (!state.enabled) return;

      if (state.config.triggerEvent === 'inventory_full' && isInventoryFull(bot)) {
        maybeTrigger(state, 'inventory_full');
      }

      if (state.config.triggerEvent === 'low_health' && isLowHealth(bot, state.config.healthThreshold)) {
        maybeTrigger(state, 'low_health');
      }
    }, 1000);

    bot.on('playerCollect', state.onCollect);
    bot.on('windowOpen', state.onWindowOpen);
  }

  function detachReactor(state) {
    if (state.checkInterval) {
      clearInterval(state.checkInterval);
      state.checkInterval = null;
    }

    if (state.onCollect) {
      state.bot.removeListener('playerCollect', state.onCollect);
      state.onCollect = null;
    }

    if (state.onWindowOpen) {
      state.bot.removeListener('windowOpen', state.onWindowOpen);
      state.onWindowOpen = null;
    }
  }

  function enableEventReactor(botName) {
    if (reactorStates.has(botName)) {
      return `EventReactor already enabled for ${botName}`;
    }

    const bot = getManagedBot(botName);
    if (!bot) {
      return `Bot ${botName} not found`;
    }

    const state = {
      botName,
      bot,
      enabled: true,
      lastTriggerAt: 0,
      checkInterval: null,
      onCollect: null,
      onWindowOpen: null,
      config: {
        triggerEvent: 'item_pickup',
        reaction: 'say_in_chat',
        chatMessage: 'EventReactor triggered!',
        command: 'spawn',
        targetFeature: 'craft',
        healthThreshold: 6,
        cooldownTicks: 20
      }
    };

    attachReactor(state);
    reactorStates.set(botName, state);
    return `EventReactor enabled for ${botName}`;
  }

  function disableEventReactor(botName) {
    const state = reactorStates.get(botName);
    if (!state) return false;

    state.enabled = false;
    detachReactor(state);
    reactorStates.delete(botName);
    return true;
  }

  function disableAllEventReactors() {
    for (const botName of reactorStates.keys()) {
      disableEventReactor(botName);
    }
  }

  function isEventReactorEnabled(botName) {
    return reactorStates.has(botName);
  }

  function getStatus(botName) {
    const state = reactorStates.get(botName);
    if (!state) return `EventReactor is not enabled for ${botName}`;

    const cfg = state.config;
    return `EventReactor ${botName}: event=${cfg.triggerEvent} reaction=${cfg.reaction} feature=${cfg.targetFeature} cooldownTicks=${cfg.cooldownTicks} health=${cfg.healthThreshold}`;
  }

  function setConfig(botName, field, value) {
    const state = reactorStates.get(botName);
    if (!state) {
      return `EventReactor is not enabled for ${botName}`;
    }

    if (field === 'event') {
      const eventValue = String(value || '').toLowerCase();
      if (!TRIGGERS.has(eventValue)) {
        return `Invalid event. Use: ${Array.from(TRIGGERS).join(', ')}`;
      }
      state.config.triggerEvent = eventValue;
      return `EventReactor event set to ${eventValue} for ${botName}`;
    }

    if (field === 'reaction') {
      const reactionValue = String(value || '').toLowerCase();
      if (!REACTIONS.has(reactionValue)) {
        return `Invalid reaction. Use: ${Array.from(REACTIONS).join(', ')}`;
      }
      state.config.reaction = reactionValue;
      return `EventReactor reaction set to ${reactionValue} for ${botName}`;
    }

    if (field === 'message') {
      const msg = String(value || '').trim();
      if (!msg) return 'Message cannot be empty';
      state.config.chatMessage = msg;
      return `EventReactor message updated for ${botName}`;
    }

    if (field === 'command') {
      const cmd = String(value || '').trim();
      if (!cmd) return 'Command cannot be empty';
      state.config.command = cmd;
      return `EventReactor command updated for ${botName}`;
    }

    if (field === 'feature') {
      const featureValue = String(value || '').toLowerCase();
      if (!FEATURES.has(featureValue)) {
        return `Invalid feature. Use: ${Array.from(FEATURES).join(', ')}`;
      }
      state.config.targetFeature = featureValue;
      return `EventReactor feature set to ${featureValue} for ${botName}`;
    }

    if (field === 'health') {
      const threshold = Number(value);
      if (!Number.isFinite(threshold) || threshold < 1 || threshold > 20) {
        return 'Health must be between 1 and 20';
      }
      state.config.healthThreshold = threshold;
      return `EventReactor low-health threshold set to ${threshold} for ${botName}`;
    }

    if (field === 'cooldown') {
      const ticks = Number(value);
      if (!Number.isFinite(ticks) || ticks < 0 || ticks > 200) {
        return 'Cooldown must be between 0 and 200 ticks';
      }
      state.config.cooldownTicks = Math.floor(ticks);
      return `EventReactor cooldown set to ${state.config.cooldownTicks} ticks for ${botName}`;
    }

    return 'Unknown setting. Use: event|reaction|message|command|feature|health|cooldown';
  }

  function handleEventReactorCommand(parts) {
    const botName = parts[0];
    const sub = String(parts[1] || '').toLowerCase();

    if (!botName || !sub) {
      return 'Usage: +eventreactor <botname> <enable|disable|status|set> ...';
    }

    if (!hasManagedBot(botName)) {
      return `Bot ${botName} not found`;
    }

    if (sub === 'enable') {
      return enableEventReactor(botName);
    }

    if (sub === 'disable') {
      return disableEventReactor(botName)
        ? `EventReactor disabled for ${botName}`
        : `EventReactor is not enabled for ${botName}`;
    }

    if (sub === 'status') {
      return getStatus(botName);
    }

    if (sub === 'set') {
      const field = String(parts[2] || '').toLowerCase();
      const value = parts.slice(3).join(' ');
      if (!field || !value) {
        return 'Usage: +eventreactor <botname> set <event|reaction|message|command|feature|health|cooldown> <value>';
      }

      return setConfig(botName, field, value);
    }

    return 'Usage: +eventreactor <botname> <enable|disable|status|set> ...';
  }

  return {
    handleEventReactorCommand,
    disableEventReactor,
    disableAllEventReactors,
    isEventReactorEnabled
  };
}

module.exports = createEventReactorController;
