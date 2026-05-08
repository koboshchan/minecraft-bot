function createSortCommandController(options) {
  const { getManagedBot, hasManagedBot } = options;
  const { debugLog = () => {} } = options;
  const sorterStates = new Map();

  function normalizeItemName(name) {
    if (!name) {
      return '';
    }

    const value = String(name).trim().toLowerCase();
    const parts = value.split(':');
    return parts[parts.length - 1];
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sleepJitter(base, jitter) {
    const delta = Math.floor((Math.random() * 2 - 1) * jitter);
    return sleep(Math.max(50, base + delta));
  }

  // Adds tiny random noise to the look target so yaw/pitch are never identical
  // across repeated looks at the same entity (defeats AimModulo360 checks).
  async function lookAtJitter(bot, basePos) {
    const jx = (Math.random() * 2 - 1) * 0.07;
    const jy = (Math.random() * 2 - 1) * 0.05;
    const jz = (Math.random() * 2 - 1) * 0.07;
    await bot.lookAt(basePos.offset(jx, jy, jz), true).catch(() => {});
  }

  function tossStackAsync(bot, item, beforeSignature) {
    return new Promise((resolve, reject) => {
      let finished = false;

      const end = (result) => {
        if (finished) {
          return;
        }

        finished = true;
        clearInterval(poll);
        clearTimeout(timeout);
        resolve(result);
      };

      // Keep tosses serialized: concurrent toss() calls can corrupt mineflayer transfer state.
      bot.toss(item.type, item.metadata ?? null, item.count, (error) => {
        if (error) {
          if (finished) {
            return;
          }

          finished = true;
          clearInterval(poll);
          clearTimeout(timeout);
          reject(error);
          return;
        }

        const current = inventorySignature(bot);
        end({ changed: current !== beforeSignature, source: 'callback' });
      });

      const poll = setInterval(() => {
        const current = inventorySignature(bot);
        if (current !== beforeSignature) {
          end({ changed: true, source: 'inventory-change' });
        }
      }, 25);

      // Short cap: avoid hanging forever on servers that never fire toss callback.
      const timeout = setTimeout(() => {
        end({ changed: false, source: 'timeout' });
      }, 350);
    });
  }

  function inventorySignature(bot) {
    return bot
      .inventory
      .items()
      .map((item) => `${item.slot}:${item.type}:${item.count}`)
      .sort()
      .join('|');
  }

  function getRegistryFromBot(bot) {
    return bot.registry || bot.game?.registry || null;
  }

  function getEntityTypeNameFromId(bot, entityTypeId) {
    const registry = getRegistryFromBot(bot);
    if (!registry || !Array.isArray(registry.entities)) {
      return null;
    }

    const found = registry.entities.find((entity) => entity && entity.id === entityTypeId);
    return found ? String(found.name).toLowerCase() : null;
  }

  function getItemNameFromId(bot, itemId) {
    const registry = getRegistryFromBot(bot);
    if (!registry || !Array.isArray(registry.items)) {
      return null;
    }

    const indexed = registry.items[itemId];
    if (indexed && typeof indexed.name === 'string') {
      return indexed.name;
    }

    const found = registry.items.find((item) => item && item.id === itemId);
    return found ? found.name : null;
  }

  function collectItemCandidates(node, names, ids, seen) {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (seen.has(node)) {
      return;
    }

    seen.add(node);

    const nameKeys = ['name', 'itemName', 'identifier', 'namespacedName', 'resourceLocation'];
    for (const key of nameKeys) {
      const value = node[key];
      if (typeof value === 'string' && value.trim()) {
        names.push(value.trim());
      }
    }

    const idKeys = ['itemId', 'id', 'type', 'networkId', 'runtimeId'];
    for (const key of idKeys) {
      const value = node[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        ids.push(value);
      }
      if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
          ids.push(numeric);
        }
      }
    }

    for (const child of Object.values(node)) {
      if (!child) {
        continue;
      }

      if (Array.isArray(child)) {
        for (const entry of child) {
          collectItemCandidates(entry, names, ids, seen);
        }
        continue;
      }

      if (typeof child === 'object') {
        collectItemCandidates(child, names, ids, seen);
      }
    }
  }

  function resolveFrameItemFromCandidates(bot, names, ids) {
    for (const candidate of names) {
      const normalized = normalizeItemName(candidate);
      if (!normalized) {
        continue;
      }

      if (
        normalized === 'item_frame' ||
        normalized === 'glow_item_frame' ||
        normalized === 'item frame' ||
        normalized === 'player'
      ) {
        continue;
      }

      return { itemName: normalized, itemId: null };
    }

    for (const id of ids) {
      const name = getItemNameFromId(bot, id);
      if (name) {
        return { itemName: normalizeItemName(name), itemId: id };
      }
    }

    if (ids.length > 0) {
      return { itemName: null, itemId: ids[0] };
    }

    return null;
  }

  function readItemFrameItemData(bot, entity) {
    if (!entity || !Array.isArray(entity.metadata)) {
      return null;
    }

    const names = [];
    const ids = [];
    const seen = new Set();

    for (const entry of entity.metadata) {
      collectItemCandidates(entry, names, ids, seen);
      const value = entry && typeof entry === 'object' && 'value' in entry ? entry.value : null;
      collectItemCandidates(value, names, ids, seen);
    }

    return resolveFrameItemFromCandidates(bot, names, ids);
  }

  function getItemIdByName(bot, name) {
    const registry = getRegistryFromBot(bot);
    const entry = registry?.itemsByName?.[name];
    return entry && Number.isFinite(entry.id) ? entry.id : null;
  }

  function getFrameEntityTypeIds(bot) {
    const registry = getRegistryFromBot(bot);
    if (!registry || !registry.entitiesByName) {
      return new Set();
    }

    const ids = new Set();
    const itemFrame = registry.entitiesByName.item_frame;
    const glowItemFrame = registry.entitiesByName.glow_item_frame;

    if (itemFrame && Number.isFinite(itemFrame.id)) {
      ids.add(itemFrame.id);
    }

    if (glowItemFrame && Number.isFinite(glowItemFrame.id)) {
      ids.add(glowItemFrame.id);
    }

    return ids;
  }

  function getEntityTypeName(bot, entity) {
    const fromType = getEntityTypeNameFromId(bot, Number(entity?.type));
    if (fromType) {
      return fromType;
    }

    const raw = entity?.name || entity?.displayName || '';
    return String(raw).toLowerCase();
  }

  function isItemFrameEntity(bot, entity) {
    const frameTypeIds = getFrameEntityTypeIds(bot);
    if (frameTypeIds.has(entity?.type)) {
      return true;
    }

    const typeName = getEntityTypeName(bot, entity);
    return (
      typeName.includes('item_frame') ||
      typeName.includes('item frame') ||
      typeName.includes('glow_item_frame')
    );
  }

  function debugNearbyEntities(bot, maxDistance) {
    if (!bot.entity || !bot.entity.position) {
      return;
    }

    const nearby = [];
    for (const entity of Object.values(bot.entities)) {
      if (!entity || !entity.position) {
        continue;
      }

      const distance = bot.entity.position.distanceTo(entity.position);
      if (distance > maxDistance) {
        continue;
      }

      nearby.push({
        id: entity.id,
        type: entity.type,
        kind: entity.kind,
        name: entity.name,
        displayName: entity.displayName,
        resolvedTypeName: getEntityTypeName(bot, entity),
        distance: Number(distance.toFixed(2)),
        metadataEntries: Array.isArray(entity.metadata) ? entity.metadata.length : 0
      });
    }

    nearby.sort((a, b) => a.distance - b.distance);
    debugLog(`sort debug ${bot.username}: nearby entities`, nearby.slice(0, 12));
  }

  function getNearbyItemFrames(bot, maxDistance = 12) {
    const frames = [];

    if (!bot.entity || !bot.entity.position) {
      return frames;
    }

    for (const entity of Object.values(bot.entities)) {
      if (!entity || !entity.position) {
        continue;
      }

        if (!isItemFrameEntity(bot, entity)) {
        continue;
      }

      const distance = bot.entity.position.distanceTo(entity.position);
      if (distance > maxDistance) {
        continue;
      }

      const itemData = readItemFrameItemData(bot, entity);
      if (!itemData || (!itemData.itemName && !Number.isFinite(itemData.itemId))) {
        debugLog(`sort frame detected but item unreadable`, {
          bot: bot.username,
          entityId: entity.id,
          displayName: entity.displayName,
          type: entity.type,
          metadataEntries: Array.isArray(entity.metadata) ? entity.metadata.length : 0
        });
        continue;
      }

      frames.push({
        entity,
        itemName: itemData.itemName ? normalizeItemName(itemData.itemName) : null,
        itemId: Number.isFinite(itemData.itemId) ? itemData.itemId : null,
        distance
      });
    }

    return frames;
  }

  function chooseTargetFrame(frames, item, stoneId) {
    const normalized = normalizeItemName(item?.name);
    const itemTypeId = Number.isFinite(item?.type) ? item.type : null;

    const exactMatches = frames.filter((frame) => frame.itemName && frame.itemName === normalized);
    if (exactMatches.length > 0) {
      exactMatches.sort((a, b) => a.distance - b.distance);
      return exactMatches[0];
    }

    if (itemTypeId !== null) {
      const idMatches = frames.filter((frame) => Number.isFinite(frame.itemId) && frame.itemId === itemTypeId);
      if (idMatches.length > 0) {
        idMatches.sort((a, b) => a.distance - b.distance);
        return idMatches[0];
      }
    }

    const stoneFrames = frames.filter(
      (frame) =>
        frame.itemName === 'stone' ||
        (stoneId !== null && Number.isFinite(frame.itemId) && frame.itemId === stoneId)
    );
    if (stoneFrames.length > 0) {
      stoneFrames.sort((a, b) => a.distance - b.distance);
      return stoneFrames[0];
    }

    // Final fallback: use nearest known frame so sorter can still drain inventory when
    // frame labels are partially unreadable on this server version.
    const byDistance = [...frames].sort((a, b) => a.distance - b.distance);
    return byDistance[0] || null;
  }

  function getNextSortableStack(bot, frames, stoneId) {
    const items = bot.inventory.items();
    for (const item of items) {
      const target = chooseTargetFrame(frames, item, stoneId);
      if (target) {
        return { item, target };
      }
    }

    return null;
  }

  function getInventoryTypeGroups(bot) {
    const items = bot.inventory.items();
    const groups = new Map();

    for (const item of items) {
      const key = String(item.type);
      if (!groups.has(key)) {
        groups.set(key, {
          type: item.type,
          representative: item
        });
      }
    }

    return Array.from(groups.values());
  }

  async function runSortPass(bot, state) {
    if (!state.enabled || state.running) {
      return;
    }

    if (!bot.entity || !bot.inventory) {
      return;
    }

    state.running = true;

    try {
      const frames = getNearbyItemFrames(bot);
      debugLog(`sort pass ${bot.username}: frames=${frames.length}`);
      if (frames.length === 0) {
        state.noFramePasses = (state.noFramePasses || 0) + 1;
        if (state.noFramePasses % 10 === 0) {
          debugNearbyEntities(bot, 12);
        }
        return;
      }

      state.noFramePasses = 0;
      const stoneId = getItemIdByName(bot, 'stone');
      let totalTossed = 0;
      let cycle = 0;

      for (; cycle < 256 && state.enabled; cycle += 1) {
        const groups = getInventoryTypeGroups(bot);
        debugLog(`sort pass ${bot.username}: inventoryItems=${bot.inventory.items().length} cycle=${cycle}`);

        if (groups.length === 0) {
          break;
        }

        let tossedInCycle = 0;
      let lastFrameEntityId = null;

        for (const group of groups) {
          if (!state.enabled) {
            break;
          }

          const target = chooseTargetFrame(frames, group.representative, stoneId);
          if (!target) {
            debugLog(`sort skip ${bot.username}: no target for type ${group.type}`);
            continue;
          }

          // Only turn (and wait for physics) when the target frame changes.
          const needsTurn = target.entity.id !== lastFrameEntityId;
          if (needsTurn) {
            await lookAtJitter(bot, target.entity.position.offset(0, 0.5, 0));
            await sleepJitter(200, 80);
          }
          lastFrameEntityId = target.entity.id;

          let stagnantForType = 0;
          while (state.enabled) {
            const liveStack = bot.inventory.items().find((entry) => entry.type === group.type);
            if (!liveStack) {
              break;
            }

            try {
              debugLog(
                `sort toss ${bot.username}: ${liveStack.name}#${liveStack.type} -> frame(${target.itemName || 'id-only'}#${target.itemId})`
              );

              const tossResult = await lookAtFrameAndTossStack(bot, target, liveStack);
              if (!tossResult) {
                break;
              }

              if (!tossResult.changed) {
                stagnantForType += 1;
                debugLog(
                  `sort toss no-change ${bot.username}: type=${group.type} stagnant=${stagnantForType} source=${tossResult.source}`
                );
                if (stagnantForType >= 2) {
                  break;
                }
              } else {
                stagnantForType = 0;
                tossedInCycle += 1;
                totalTossed += 1;
              }
            } catch (error) {
              console.warn(`[${bot.username}] sort toss failed: ${error.message}`);
              break;
            }
          }
        }

        if (tossedInCycle === 0) {
          break;
        }
      }

      debugLog(`sort pass ${bot.username}: totalTossed=${totalTossed}`);
    } finally {
      state.running = false;

      if (state.pending && state.enabled) {
        state.pending = false;
        setImmediate(() => {
          runSortPass(bot, state).catch((error) => {
            console.warn(`[${bot.username}] sort pass failed: ${error.message}`);
          });
        });
      }
    }
  }

  function scheduleSortPass(bot, state) {
    if (!state.enabled) {
      return;
    }

    if (state.running) {
      state.pending = true;
      return;
    }

    runSortPass(bot, state).catch((error) => {
      console.warn(`[${bot.username}] sort pass failed: ${error.message}`);
    });
  }

  async function lookAtFrameAndTossStack(bot, target, item) {
    const liveStack = bot.inventory?.slots?.[item.slot];
    if (!liveStack) {
      return false;
    }

    const beforeSignature = inventorySignature(bot);
    const tossResult = await tossStackAsync(bot, liveStack, beforeSignature);
    return tossResult;
  }

  function disableSorter(botName) {
    const state = sorterStates.get(botName);
    if (!state) {
      debugLog(`sort disable skipped: not enabled for ${botName}`);
      return false;
    }

    state.enabled = false;

    if (state.interval) {
      clearInterval(state.interval);
    }

    if (state.onCollect) {
      state.bot.removeListener('playerCollect', state.onCollect);
    }

    sorterStates.delete(botName);
    debugLog(`sort disabled for ${botName}`);
    return true;
  }

  function disableAllSorters() {
    for (const botName of sorterStates.keys()) {
      disableSorter(botName);
    }
  }

  function enableSorter(botName) {
    const bot = getManagedBot(botName);
    if (!bot) {
      debugLog(`sort enable failed: bot missing ${botName}`);
      return { ok: false, message: `Bot ${botName} does not exist` };
    }

    if (sorterStates.has(botName)) {
      debugLog(`sort enable skipped: already enabled for ${botName}`);
      return { ok: false, message: `Sorter already enabled for ${botName}` };
    }

    const state = {
      bot,
      enabled: true,
      running: false,
      pending: false,
      noFramePasses: 0,
      interval: null,
      onCollect: null
    };

    state.onCollect = (...args) => {
      const collector = args[0];
      if (!state.enabled) {
        return;
      }

      if (!collector || !bot.entity || collector.id !== bot.entity.id) {
        return;
      }

      scheduleSortPass(bot, state);
    };

    bot.on('playerCollect', state.onCollect);

    // 20 ticks ~= 1 second at 20 TPS.
    state.interval = setInterval(() => {
      scheduleSortPass(bot, state);
    }, 1000);

    sorterStates.set(botName, state);
    debugLog(`sort enabled for ${botName}`);
    scheduleSortPass(bot, state);

    return { ok: true, message: `Sorter enabled for ${botName}` };
  }

  function handleSortCommand(parts) {
    const botName = parts[0];
    const mode = (parts[1] || '').toLowerCase();

    if (!botName || !mode) {
      return 'Usage: +sort <botname> <enable|disable>';
    }

    if (mode === 'enable') {
      debugLog(`sort command enable for ${botName}`);
      return enableSorter(botName).message;
    }

    if (mode === 'disable') {
      debugLog(`sort command disable for ${botName}`);
      if (!hasManagedBot(botName)) {
        return `Bot ${botName} does not exist`;
      }

      if (!disableSorter(botName)) {
        return `Sorter is not enabled for ${botName}`;
      }

      return `Sorter disabled for ${botName}`;
    }

    return 'Usage: +sort <botname> <enable|disable>';
  }

  function isSorterEnabled(botName) {
    return sorterStates.has(botName);
  }

  return {
    handleSortCommand,
    disableSorter,
    disableAllSorters,
    isSorterEnabled
  };
}

module.exports = createSortCommandController;
