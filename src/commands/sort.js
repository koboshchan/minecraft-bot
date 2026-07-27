function createSortCommandController(options) {
  const { getManagedBot, hasManagedBot } = options;
  const { debugLog = () => {} } = options;
  const sorterStates = new Map();

  const SORT_STACK_PAUSE_MS = 20; // rate limit between dropped stacks
  const SORT_TURN_PAUSE_MS = 200; // settle after turning to a new frame
  const SORT_RETRY_PAUSE_MS = 500; // back off after a drop that did not take
  const SORT_MAX_DROPS_PER_PASS = 256;

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

  // Adds tiny random noise to the look target so yaw/pitch are never identical
  // across repeated looks at the same entity (defeats AimModulo360 checks).
  async function lookAtJitter(bot, basePos) {
    await new Promise((resolve) => {
      setTimeout(() => {
        bot.lookAt(basePos, true).catch(() => {}).finally(resolve);
      }, 50);
    });
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

  // Reads inventory live each call, so items picked up mid-pass are picked up
  // without a second pass. Prefers the type just dropped so consecutive stacks
  // of the same item reuse the current facing instead of alternating types.
  function findSortableStack(bot, skippedTypes, preferredType) {
    const items = bot.inventory.items();
    if (preferredType !== null) {
      const same = items.find((item) => item.type === preferredType && !skippedTypes.has(item.type));
      if (same) return same;
    }
    return items.find((item) => !skippedTypes.has(item.type)) || null;
  }

  async function runSortPass(bot, state) {
    if (!state.enabled || state.running) {
      return;
    }

    if (!bot.entity || !bot.inventory) {
      return;
    }

    // A window click here would target the open window, not the player
    // inventory, and land on the wrong slot. Let the next pass retry.
    if (bot.currentWindow) {
      debugLog(`sort skip ${bot.username}: another window is open`);
      return;
    }

    // dropClick is a no-op while something is on the cursor, which would look
    // like every type failing to drop.
    if (bot.inventory.selectedItem) {
      debugLog(`sort skip ${bot.username}: item held on cursor`);
      return;
    }

    state.running = true;

    try {
      const frames = state.frameCache || [];
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

      let dropped = 0;
      let lastFrameEntityId = null;
      let preferredType = null;
      const skippedTypes = new Set();

      while (state.enabled && dropped < SORT_MAX_DROPS_PER_PASS) {
        const stack = findSortableStack(bot, skippedTypes, preferredType);
        if (!stack) break;

        const target = chooseTargetFrame(frames, stack, stoneId);
        if (!target) {
          debugLog(`sort skip ${bot.username}: no target for type ${stack.type}`);
          skippedTypes.add(stack.type);
          continue;
        }

        // Only turn (and wait for physics) when the target frame changes. Different
        // item types can share a frame via the stone fallback, so this must key off
        // the frame, not the item type.
        if (target.entity.id !== lastFrameEntityId) {
          await lookAtJitter(bot, target.entity.position.offset(0, 0.5, 0));
          await sleep(SORT_TURN_PAUSE_MS);
          lastFrameEntityId = target.entity.id;
        }

        const slot = stack.slot;
        debugLog(
          `sort drop ${bot.username}: ${stack.name}#${stack.type} slot=${slot} -> frame(${target.itemName || 'id-only'}#${target.itemId})`
        );

        try {
          await bot.clickWindow(slot, 1, 4); // drop whole stack, one packet
        } catch (error) {
          console.warn(`[${bot.username}] sort drop failed: ${error.message}`);
          skippedTypes.add(stack.type);
          await sleep(SORT_RETRY_PAUSE_MS);
          continue;
        }

        // A successful drop nulls the slot locally. Anything still there means the
        // drop did not take; skip this type for the rest of the pass and let the
        // next pass retry once the server has re-synced.
        if (bot.inventory.slots[slot]) {
          debugLog(`sort drop no-change ${bot.username}: slot=${slot} type=${stack.type}`);
          skippedTypes.add(stack.type);
          await sleep(SORT_RETRY_PAUSE_MS);
          continue;
        }

        preferredType = stack.type;
        dropped += 1;
        await sleep(SORT_STACK_PAUSE_MS);
      }

      debugLog(`sort pass ${bot.username}: dropped=${dropped}`);
    } finally {
      state.running = false;

      if (state.pending && state.enabled) {
        state.pending = false;
        // Schedule next pass with a small delay to sync with tick rate and avoid fast loop packet spam
        setTimeout(() => {
          runSortPass(bot, state).catch((error) => {
            console.warn(`[${bot.username}] sort pass failed: ${error.message}`);
          });
        }, 100);
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

  function refreshItemFrameCache(bot, state) {
    if (!state.enabled) {
      return;
    }

    state.frameCache = getNearbyItemFrames(bot);
    debugLog(`sort cache refresh ${bot.username}: frames=${state.frameCache.length}`);
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

    if (state.cacheInterval) {
      clearInterval(state.cacheInterval);
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
      frameCache: [],
      interval: null,
      cacheInterval: null,
      onCollect: null
    };

    let lastCollectSortTime = 0;
    state.onCollect = (...args) => {
      const collector = args[0];
      if (!state.enabled) {
        return;
      }

      if (!collector || !bot.entity || collector.id !== bot.entity.id) {
        return;
      }

      const now = Date.now();
      if (now - lastCollectSortTime < 3000) {
        return;
      }
      lastCollectSortTime = now;

      scheduleSortPass(bot, state);
    };

    bot.on('playerCollect', state.onCollect);

    refreshItemFrameCache(bot, state);

    // 200 ticks ~= 10 seconds at 20 TPS.
    state.cacheInterval = setInterval(() => {
      refreshItemFrameCache(bot, state);
    }, 10000);

    // Keep sort pass cadence unchanged; frame detection is handled by cache refresh.
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
