function createCraftCommandController(options) {
  const { getManagedBot, hasManagedBot, debugLog = () => {} } = options;
  const craftStates = new Map();

  const CRAFT_ACTIVE_INTERVAL_MS = 20;
  const CRAFT_IDLE_INTERVAL_MS = 500;
  const CRAFT_CHUNK_SIZES = [64, 32, 16, 8, 4, 2, 1];
  const CRAFT_MIN_CHUNK = 32;
  const TABLE_RESCAN_INTERVAL_MS = 1000;

  // ── shared helpers ────────────────────────────────────────────────────────

  function normalizeItemName(name) {
    if (!name) return '';
    const value = String(name).trim().toLowerCase();
    const parts = value.split(':');
    return parts[parts.length - 1];
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getRegistryFromBot(bot) {
    return bot.registry || bot.game?.registry || null;
  }

  function getEntityTypeNameFromId(bot, entityTypeId) {
    const registry = getRegistryFromBot(bot);
    if (!registry || !Array.isArray(registry.entities)) return null;
    const found = registry.entities.find((e) => e && e.id === entityTypeId);
    return found ? String(found.name).toLowerCase() : null;
  }

  function getItemNameFromId(bot, itemId) {
    const registry = getRegistryFromBot(bot);
    if (!registry || !Array.isArray(registry.items)) return null;
    const indexed = registry.items[itemId];
    if (indexed && typeof indexed.name === 'string') return indexed.name;
    const found = registry.items.find((item) => item && item.id === itemId);
    return found ? found.name : null;
  }

  function collectItemCandidates(node, names, ids, seen) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    const nameKeys = ['name', 'itemName', 'identifier', 'namespacedName', 'resourceLocation'];
    for (const key of nameKeys) {
      const value = node[key];
      if (typeof value === 'string' && value.trim()) names.push(value.trim());
    }

    const idKeys = ['itemId', 'id', 'type', 'networkId', 'runtimeId'];
    for (const key of idKeys) {
      const value = node[key];
      if (typeof value === 'number' && Number.isFinite(value)) ids.push(value);
      if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) ids.push(numeric);
      }
    }

    for (const child of Object.values(node)) {
      if (!child) continue;
      if (Array.isArray(child)) {
        for (const entry of child) collectItemCandidates(entry, names, ids, seen);
        continue;
      }
      if (typeof child === 'object') collectItemCandidates(child, names, ids, seen);
    }
  }

  function resolveFrameItemFromCandidates(bot, names, ids) {
    const skip = new Set(['item_frame', 'glow_item_frame', 'item frame', 'player']);
    for (const candidate of names) {
      const normalized = normalizeItemName(candidate);
      if (!normalized || skip.has(normalized)) continue;
      return { itemName: normalized, itemId: null };
    }
    for (const id of ids) {
      const name = getItemNameFromId(bot, id);
      if (name) return { itemName: normalizeItemName(name), itemId: id };
    }
    if (ids.length > 0) return { itemName: null, itemId: ids[0] };
    return null;
  }

  function readItemFrameItemData(bot, entity) {
    if (!entity || !Array.isArray(entity.metadata)) return null;
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

  function getFrameEntityTypeIds(bot) {
    const registry = getRegistryFromBot(bot);
    if (!registry || !registry.entitiesByName) return new Set();
    const ids = new Set();
    const itemFrame = registry.entitiesByName.item_frame;
    const glowItemFrame = registry.entitiesByName.glow_item_frame;
    if (itemFrame && Number.isFinite(itemFrame.id)) ids.add(itemFrame.id);
    if (glowItemFrame && Number.isFinite(glowItemFrame.id)) ids.add(glowItemFrame.id);
    return ids;
  }

  function getEntityTypeName(bot, entity) {
    const fromType = getEntityTypeNameFromId(bot, Number(entity?.type));
    if (fromType) return fromType;
    const raw = entity?.name || entity?.displayName || '';
    return String(raw).toLowerCase();
  }

  function isItemFrameEntity(bot, entity) {
    const frameTypeIds = getFrameEntityTypeIds(bot);
    if (frameTypeIds.has(entity?.type)) return true;
    const typeName = getEntityTypeName(bot, entity);
    return (
      typeName.includes('item_frame') ||
      typeName.includes('item frame') ||
      typeName.includes('glow_item_frame')
    );
  }

  function getItemIdByName(bot, name) {
    const registry = getRegistryFromBot(bot);
    const entry = registry?.itemsByName?.[name];
    return entry && Number.isFinite(entry.id) ? entry.id : null;
  }

  // ── craft-specific helpers ─────────────────────────────────────────────────

  function findCraftingTable(bot, maxDistance = 6) {
    const registry = getRegistryFromBot(bot);
    if (!registry || !registry.blocksByName) return null;
    const tableBlock = registry.blocksByName.crafting_table;
    if (!tableBlock) return null;
    return bot.findBlock({ matching: tableBlock.id, maxDistance });
  }

  // bot.findBlock scans every block of each candidate chunk section (~1.1ms per
  // call), which is far too expensive to repeat on every pass. The table does not
  // move, so remember where it is and re-validate that one position instead.
  function getCraftingTable(bot, state) {
    const registry = getRegistryFromBot(bot);
    const tableId = registry?.blocksByName?.crafting_table?.id;
    if (tableId === undefined) return null;

    if (state.tableCache) {
      const block = bot.blockAt(state.tableCache);
      if (block && block.type === tableId) return block;
      debugLog(`craft pass ${bot.username}: cached crafting table gone, rescanning`);
      state.tableCache = null;
    }

    // Bound the cost of rescanning when the table is genuinely missing.
    const now = Date.now();
    if (now - state.lastTableScanAt < TABLE_RESCAN_INTERVAL_MS) return null;
    state.lastTableScanAt = now;

    const found = findCraftingTable(bot);
    if (found) state.tableCache = found.position;
    return found;
  }

  function getItemFramesNearBot(bot, maxDistance = 12) {
    const frames = [];

    if (!bot.entity || !bot.entity.position) {
      return frames;
    }

    for (const entity of Object.values(bot.entities)) {
      if (!entity || !entity.position) continue;
      if (!isItemFrameEntity(bot, entity)) continue;

      const distance = bot.entity.position.distanceTo(entity.position);
      if (distance > maxDistance) continue;

      const itemData = readItemFrameItemData(bot, entity);
      if (!itemData || (!itemData.itemName && !Number.isFinite(itemData.itemId))) {
        debugLog(`craft frame near bot but item unreadable`, {
          bot: bot.username,
          entityId: entity.id,
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

    frames.sort((a, b) => a.distance - b.distance);
    return frames;
  }

  function resolveFrameItemId(bot, frame) {
    if (Number.isFinite(frame.itemId)) return frame.itemId;
    if (frame.itemName) return getItemIdByName(bot, frame.itemName);
    return null;
  }

  function maxCraftableCount(bot, recipe) {
    const counts = new Map();
    for (const item of bot.inventory.items()) {
      counts.set(item.type, (counts.get(item.type) || 0) + item.count);
    }

    const required = new Map();
    const ingredients = [];
    if (recipe.inShape) {
      for (const row of recipe.inShape) {
        for (const ing of row) {
          if (ing && ing.id !== -1) ingredients.push(ing);
        }
      }
    } else if (recipe.ingredients) {
      ingredients.push(...recipe.ingredients);
    }

    for (const ing of ingredients) {
      if (!ing || ing.id === -1) continue;
      required.set(ing.id, (required.get(ing.id) || 0) + 1);
    }

    if (required.size === 0) return 0;

    let max = Infinity;
    for (const [id, needed] of required) {
      const have = counts.get(id) || 0;
      max = Math.min(max, Math.floor(have / needed));
    }

    return max === Infinity ? 0 : max;
  }

  async function runCraftPass(bot, state) {
    if (!state.enabled || state.running) return false;
    if (!bot.entity || !bot.inventory) return false;

    state.running = true;

    try {
      const craftingTable = getCraftingTable(bot, state);
      if (!craftingTable) {
        debugLog(`craft pass ${bot.username}: no crafting table found within range`);
        return false;
      }

      debugLog(`craft pass ${bot.username}: crafting table at ${craftingTable.position}`);

      const targetFrame = state.frameCache?.[0] || null;
      if (!targetFrame) {
        debugLog(`craft pass ${bot.username}: no readable item frame close to bot`);
        return false;
      }
      const targetItemId = resolveFrameItemId(bot, targetFrame);

      if (targetItemId === null) {
        debugLog(`craft pass ${bot.username}: could not resolve item id from frame`, targetFrame);
        return false;
      }

      debugLog(
        `craft pass ${bot.username}: target item id=${targetItemId} name=${targetFrame.itemName ?? 'unknown'}`
      );

      // Always face the item frame first; craft and toss without changing look direction.
        await new Promise((resolve) => {
          setTimeout(() => {
            bot.lookAt(targetFrame.entity.position.offset(0, 0.5, 0), true).catch(() => {}).finally(resolve);
          }, 50);
        });
      const recipes = bot.recipesFor(targetItemId, null, 1, craftingTable);
      if (recipes.length === 0) {
        debugLog(`craft pass ${bot.username}: no craftable recipe for item ${targetItemId}`);
        return false;
      }

      const recipe = recipes[0];
      debugLog(`craft pass ${bot.username}: crafting with recipe`, {
        result: recipe.result,
        requiresTable: recipe.requiresTable
      });

      const stackSize = Math.floor(64 / (recipe.result.count || 1));
      const maxPerPass = 64;
      const ceiling = Math.min(stackSize, maxPerPass);
      const available = maxCraftableCount(bot, recipe);

      // Craft in 64- or 32-chunks and wait for ingredients to accumulate instead of
      // running tiny passes. Recipes whose output stack cannot hold 32 crafts fall
      // back to the largest power of 2 that fits.
      const minChunk = ceiling >= CRAFT_MIN_CHUNK ? CRAFT_MIN_CHUNK : 1;
      let craftCount = 0;
      for (const countVal of CRAFT_CHUNK_SIZES) {
        if (countVal >= minChunk && countVal <= ceiling && countVal <= available) {
          craftCount = countVal;
          break;
        }
      }

      if (craftCount <= 0) {
        if (state.lastWaitCount !== available) {
          state.lastWaitCount = available;
          debugLog(`craft pass ${bot.username}: waiting for ${minChunk} crafts, have ${available}`);
        }
        return false;
      }
      state.lastWaitCount = null;

      // Close any window left open from a previous failed craft attempt.
      if (bot.currentWindow) {
        bot.closeWindow(bot.currentWindow);
      }

      debugLog(`craft pass ${bot.username}: craftCount=${craftCount}`);

      const directDropCraftMethod = typeof bot.craftStackDrop === 'function'
        ? bot.craftStackDrop.bind(bot)
        : null;

      if (!directDropCraftMethod) {
        throw new Error('craftStackDrop not available');
      }

      await directDropCraftMethod(recipe, craftCount, craftingTable);
      debugLog(`craft pass ${bot.username}: dropped output directly from crafting window`);

      debugLog(`craft pass ${bot.username}: done`);
      return true;
    } catch (error) {
      console.warn(`[${bot.username}] craft pass error: ${error.message}`);
      // Close any stuck window and pause before retrying to let the server recover.
      try {
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
      } catch (_) {}
      await sleep(150);
      return false;
    } finally {
      state.running = false;
    }
  }

  function startCraftLoop(bot, state) {
    const tick = async () => {
      state.timer = null;
      if (!state.enabled) return;

      let delay = CRAFT_IDLE_INTERVAL_MS;
      try {
        const crafted = await runCraftPass(bot, state);
        delay = crafted ? CRAFT_ACTIVE_INTERVAL_MS : CRAFT_IDLE_INTERVAL_MS;
      } catch (error) {
        console.warn(`[${bot.username}] craft pass failed: ${error.message}`);
      }

      if (!state.enabled) return;
      state.timer = setTimeout(tick, delay);
    };

    state.timer = setTimeout(tick, CRAFT_ACTIVE_INTERVAL_MS);
  }

  function refreshCraftItemFrameCache(bot, state) {
    if (!state.enabled) {
      return;
    }

    state.frameCache = getItemFramesNearBot(bot);
    debugLog(`craft cache refresh ${bot.username}: frames=${state.frameCache.length}`);
  }

  function enableCrafter(botName) {
    if (craftStates.has(botName)) {
      return { ok: false, message: `Crafter already enabled for ${botName}` };
    }

    const bot = getManagedBot(botName);
    if (!bot) {
      return { ok: false, message: `Bot ${botName} not found` };
    }

    const state = {
      enabled: true,
      running: false,
      bot,
      frameCache: [],
      cacheInterval: null,
      timer: null,
      lastWaitCount: null,
      tableCache: null,
      lastTableScanAt: 0
    };

    refreshCraftItemFrameCache(bot, state);

    // 200 ticks ~= 10 seconds at 20 TPS.
    state.cacheInterval = setInterval(() => refreshCraftItemFrameCache(bot, state), 10000);

    // Self-rescheduling loop: fast while crafting, slow while waiting on ingredients.
    startCraftLoop(bot, state);

    craftStates.set(botName, state);
    debugLog(`craft enabled for ${botName}`);
    return { ok: true, message: `Crafter enabled for ${botName}` };
  }

  function disableCrafter(botName) {
    const state = craftStates.get(botName);
    if (!state) {
      debugLog(`craft disable skipped: not enabled for ${botName}`);
      return false;
    }

    state.enabled = false;
    if (state.timer) clearTimeout(state.timer);
    if (state.cacheInterval) clearInterval(state.cacheInterval);
    craftStates.delete(botName);
    debugLog(`craft disabled for ${botName}`);
    return true;
  }

  function disableAllCrafters() {
    for (const botName of craftStates.keys()) {
      disableCrafter(botName);
    }
  }

  function isCrafterEnabled(botName) {
    return craftStates.has(botName);
  }

  function handleCraftCommand(parts) {
    const botName = parts[0];
    const sub = (parts[1] || '').toLowerCase();

    if (!botName || !sub) {
      return 'Usage: +craft <botname> <enable|disable>';
    }

    if (!hasManagedBot(botName)) {
      return `Bot ${botName} not found`;
    }

    if (sub === 'enable') {
      return enableCrafter(botName).message;
    }

    if (sub === 'disable') {
      const ok = disableCrafter(botName);
      return ok ? `Crafter disabled for ${botName}` : `Crafter not enabled for ${botName}`;
    }

    return 'Usage: +craft <botname> <enable|disable>';
  }

  return {
    handleCraftCommand,
    disableCrafter,
    disableAllCrafters,
    isCrafterEnabled
  };
}

module.exports = createCraftCommandController;
