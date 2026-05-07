function createCraftCommandController(options) {
  const { getManagedBot, hasManagedBot, debugLog = () => {} } = options;
  const craftStates = new Map();

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

  function inventorySignature(bot) {
    return bot.inventory.items()
      .map((item) => `${item.slot}:${item.type}:${item.count}`)
      .sort()
      .join('|');
  }

  function tossStackAsync(bot, item, beforeSignature) {
    return new Promise((resolve, reject) => {
      let finished = false;

      const end = (result) => {
        if (finished) return;
        finished = true;
        clearInterval(poll);
        clearTimeout(timeout);
        resolve(result);
      };

      bot.toss(item.type, item.metadata ?? null, item.count, (error) => {
        if (error) {
          if (finished) return;
          finished = true;
          clearInterval(poll);
          clearTimeout(timeout);
          reject(error);
          return;
        }
        end({ changed: inventorySignature(bot) !== beforeSignature, source: 'callback' });
      });

      const poll = setInterval(() => {
        if (inventorySignature(bot) !== beforeSignature) {
          end({ changed: true, source: 'inventory-change' });
        }
      }, 25);

      const timeout = setTimeout(() => end({ changed: false, source: 'timeout' }), 350);
    });
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

  function getItemFramesNearPosition(bot, pos, radius = 4) {
    const frames = [];
    for (const entity of Object.values(bot.entities)) {
      if (!entity || !entity.position) continue;
      if (!isItemFrameEntity(bot, entity)) continue;
      const dx = entity.position.x - pos.x;
      const dy = entity.position.y - pos.y;
      const dz = entity.position.z - pos.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > radius) continue;
      const itemData = readItemFrameItemData(bot, entity);
      if (!itemData || (!itemData.itemName && !Number.isFinite(itemData.itemId))) {
        debugLog(`craft frame near table but item unreadable`, {
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
    if (!state.enabled || state.running) return;
    if (!bot.entity || !bot.inventory) return;

    state.running = true;

    try {
      const craftingTable = findCraftingTable(bot);
      if (!craftingTable) {
        debugLog(`craft pass ${bot.username}: no crafting table found within range`);
        return;
      }

      debugLog(`craft pass ${bot.username}: crafting table at ${craftingTable.position}`);

      const frames = getItemFramesNearPosition(bot, craftingTable.position);
      if (frames.length === 0) {
        debugLog(`craft pass ${bot.username}: no item frames near crafting table`);
        return;
      }

      const targetFrame = frames[0];
      const targetItemId = resolveFrameItemId(bot, targetFrame);

      if (targetItemId === null) {
        debugLog(`craft pass ${bot.username}: could not resolve item id from frame`, targetFrame);
        return;
      }

      debugLog(
        `craft pass ${bot.username}: target item id=${targetItemId} name=${targetFrame.itemName ?? 'unknown'}`
      );

      // Always face the item frame first; craft and toss without changing look direction.
      await bot.lookAt(targetFrame.entity.position.offset(0, 0.5, 0), true).catch(() => {});
      await sleep(150);

      const recipes = bot.recipesFor(targetItemId, null, 1, craftingTable);
      if (recipes.length === 0) {
        debugLog(`craft pass ${bot.username}: no craftable recipe for item ${targetItemId}`);
        return;
      }

      const recipe = recipes[0];
      debugLog(`craft pass ${bot.username}: crafting with recipe`, {
        result: recipe.result,
        requiresTable: recipe.requiresTable
      });

      const stackSize = Math.floor(64 / (recipe.result.count || 1));
      const craftCount = Math.min(stackSize, maxCraftableCount(bot, recipe));
      if (craftCount <= 0) {
        debugLog(`craft pass ${bot.username}: not enough ingredients`);
        return;
      }

      // Close any window left open from a previous failed craft attempt.
      if (bot.currentWindow) {
        bot.closeWindow(bot.currentWindow);
        await sleep(200);
      }

      debugLog(`craft pass ${bot.username}: craftCount=${craftCount}`);

      // Craft one at a time, tossing immediately after each craft so items never
      // build up in inventory (avoids confusing ingredients with output).
      for (let i = 0; i < craftCount && state.enabled; i++) {
        if (bot.currentWindow) {
          bot.closeWindow(bot.currentWindow);
          await sleep(100);
        }

        const snapBefore = inventorySignature(bot);
        const countSnap = new Map();
        for (const item of bot.inventory.items()) {
          countSnap.set(item.type, (countSnap.get(item.type) || 0) + item.count);
        }

        await bot.craft(recipe, 1, craftingTable);
        await sleep(100);

        // Toss only types that increased since this single craft.
        const newTypes = [];
        for (const item of bot.inventory.items()) {
          const before = countSnap.get(item.type) || 0;
          if (item.count > before && !newTypes.includes(item.type)) {
            newTypes.push(item.type);
          }
        }

        for (const type of newTypes) {
          let stagnant = 0;
          while (state.enabled) {
            const stack = bot.inventory.items().find((it) => it.type === type);
            if (!stack) break;
            const beforeToss = inventorySignature(bot);
            let tossResult;
            try {
              tossResult = await tossStackAsync(bot, stack, beforeToss);
            } catch (err) {
              debugLog(`craft toss failed ${bot.username}: ${err.message}`);
              break;
            }
            if (!tossResult.changed) {
              stagnant += 1;
              if (stagnant >= 2) break;
            } else {
              stagnant = 0;
            }
          }
        }
      }

      debugLog(`craft pass ${bot.username}: done`);
    } catch (error) {
      console.warn(`[${bot.username}] craft pass error: ${error.message}`);
      // Close any stuck window and pause before retrying to let the server recover.
      try {
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
      } catch (_) {}
      await sleep(3000);
    } finally {
      state.running = false;
    }
  }

  function scheduleCraftPass(bot, state) {
    if (!state.enabled) return;
    if (state.running) return;
    runCraftPass(bot, state).catch((error) => {
      console.warn(`[${bot.username}] craft pass failed: ${error.message}`);
    });
  }

  function enableCrafter(botName) {
    if (craftStates.has(botName)) {
      return { ok: false, message: `Crafter already enabled for ${botName}` };
    }

    const bot = getManagedBot(botName);
    if (!bot) {
      return { ok: false, message: `Bot ${botName} not found` };
    }

    const state = { enabled: true, running: false, bot };

    const interval = setInterval(() => scheduleCraftPass(bot, state), 2000);
    state.interval = interval;

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
    if (state.interval) clearInterval(state.interval);
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
