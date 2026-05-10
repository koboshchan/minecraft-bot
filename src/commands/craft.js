function createCraftCommandController(options) {
  const { getManagedBot, hasManagedBot, debugLog = () => {} } = options;
  const craftStates = new Map();
  const TICKS_PER_SECOND = 20;
  const RECIPE_CACHE_TTL_TICKS = 200;
  const RECIPE_CACHE_TTL_MS = (RECIPE_CACHE_TTL_TICKS / TICKS_PER_SECOND) * 1000;

  function normalizeItemName(name) {
    if (!name) return '';
    const value = String(name).trim().toLowerCase();
    const parts = value.split(':');
    return parts[parts.length - 1];
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomDelay(base, jitter) {
    const delta = Math.floor((Math.random() * 2 - 1) * jitter);
    return Math.max(50, base + delta);
  }

  async function sleepJitter(base, jitter) {
    await sleep(randomDelay(base, jitter));
  }

  async function lookAtJitter(bot, basePos) {
    const jx = (Math.random() * 2 - 1) * 0.07;
    const jy = (Math.random() * 2 - 1) * 0.05;
    const jz = (Math.random() * 2 - 1) * 0.07;
    await bot.lookAt(basePos.offset(jx, jy, jz), true).catch(() => {});
  }

  function getRegistryFromBot(bot) {
    return bot.registry || bot.game?.registry || null;
  }

  function getItemIdByName(bot, name) {
    const registry = getRegistryFromBot(bot);
    const entry = registry?.itemsByName?.[name];
    return entry && Number.isFinite(entry.id) ? entry.id : null;
  }

  function getItemNameFromId(bot, itemId) {
    const registry = getRegistryFromBot(bot);
    if (!registry || !Array.isArray(registry.items)) return null;

    const indexed = registry.items[itemId];
    if (indexed && typeof indexed.name === 'string') return indexed.name;

    const found = registry.items.find((item) => item && item.id === itemId);
    return found ? found.name : null;
  }

  function getEntityTypeName(bot, entity) {
    const registry = getRegistryFromBot(bot);
    const typeId = Number(entity?.type);
    let fromRegistry = null;

    if (Array.isArray(registry?.entities)) {
      fromRegistry = registry.entities.find((entry) => entry && entry.id === typeId) || null;
    } else if (registry?.entities && typeof registry.entities === 'object') {
      for (const entry of Object.values(registry.entities)) {
        if (entry && entry.id === typeId) {
          fromRegistry = entry;
          break;
        }
      }
    }

    if (fromRegistry && fromRegistry.name) {
      return String(fromRegistry.name).toLowerCase();
    }

    return String(entity?.name || entity?.displayName || '').toLowerCase();
  }

  function getFrameEntityTypeIds(bot) {
    const registry = getRegistryFromBot(bot);
    const ids = new Set();
    if (!registry?.entitiesByName) return ids;

    const itemFrame = registry.entitiesByName.item_frame;
    const glowItemFrame = registry.entitiesByName.glow_item_frame;
    if (itemFrame && Number.isFinite(itemFrame.id)) ids.add(itemFrame.id);
    if (glowItemFrame && Number.isFinite(glowItemFrame.id)) ids.add(glowItemFrame.id);
    return ids;
  }

  function isItemFrameEntity(bot, entity) {
    const ids = getFrameEntityTypeIds(bot);
    if (ids.has(entity?.type)) return true;

    const typeName = getEntityTypeName(bot, entity);
    return (
      typeName.includes('item_frame') ||
      typeName.includes('item frame') ||
      typeName.includes('glow_item_frame')
    );
  }

  function inventorySignature(bot) {
    return bot.inventory.items()
      .map((item) => `${item.slot}:${item.type}:${item.count}`)
      .sort()
      .join('|');
  }

  function tossStackAsync(bot, item, beforeSignature) {
    return new Promise((resolve, reject) => {
      let done = false;

      const finish = (result) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timeout);
        resolve(result);
      };

      try {
        bot.toss(item.type, item.metadata ?? null, item.count, (error) => {
          if (error) {
            if (done) return;
            done = true;
            clearInterval(poll);
            clearTimeout(timeout);
            reject(error);
            return;
          }

          finish({ changed: inventorySignature(bot) !== beforeSignature, source: 'callback' });
        });
      } catch (error) {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timeout);
        reject(error);
      }

      const poll = setInterval(() => {
        if (inventorySignature(bot) !== beforeSignature) {
          finish({ changed: true, source: 'inventory-change' });
        }
      }, 75);

      const timeout = setTimeout(() => {
        finish({ changed: false, source: 'timeout' });
      }, 1200);
    });
  }

  function findCraftingTable(bot, maxDistance = 6) {
    const registry = getRegistryFromBot(bot);
    const tableBlock = registry?.blocksByName?.crafting_table;
    if (!tableBlock) return null;
    return bot.findBlock({ matching: tableBlock.id, maxDistance });
  }

  function scanFrameCandidates(node, candidates, seen) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    const nameKeys = ['name', 'itemName', 'identifier', 'namespacedName', 'resourceLocation'];
    for (const key of nameKeys) {
      const value = node[key];
      if (typeof value === 'string' && value.trim()) {
        candidates.push({ type: 'name', value: value.trim(), weight: 3 });
      }
    }

    const hasStackLikeShape =
      Object.prototype.hasOwnProperty.call(node, 'count') ||
      Object.prototype.hasOwnProperty.call(node, 'itemCount') ||
      Object.prototype.hasOwnProperty.call(node, 'metadata') ||
      Object.prototype.hasOwnProperty.call(node, 'nbtData') ||
      Object.prototype.hasOwnProperty.call(node, 'present');

    if (Number.isFinite(node.itemId)) {
      candidates.push({ type: 'id', value: Number(node.itemId), weight: 5 });
    }

    if (hasStackLikeShape && Number.isFinite(node.id)) {
      candidates.push({ type: 'id', value: Number(node.id), weight: 4 });
    }

    if (hasStackLikeShape && typeof node.id === 'string' && node.id.trim()) {
      const parsed = Number(node.id);
      if (Number.isFinite(parsed)) {
        candidates.push({ type: 'id', value: parsed, weight: 4 });
      }
    }

    const directValue = Object.prototype.hasOwnProperty.call(node, 'value') ? node.value : null;
    if (directValue && typeof directValue === 'object') {
      scanFrameCandidates(directValue, candidates, seen);
    }

    for (const child of Object.values(node)) {
      if (!child) continue;
      if (Array.isArray(child)) {
        for (const entry of child) {
          scanFrameCandidates(entry, candidates, seen);
        }
      } else if (typeof child === 'object') {
        scanFrameCandidates(child, candidates, seen);
      }
    }
  }

  function resolveFrameItemData(bot, entity) {
    if (!entity || !Array.isArray(entity.metadata)) return null;

    const candidates = [];
    const seen = new Set();
    for (const entry of entity.metadata) {
      scanFrameCandidates(entry, candidates, seen);
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.weight - a.weight);

    const skipNames = new Set(['item_frame', 'glow_item_frame', 'item frame', 'player']);

    for (const candidate of candidates) {
      if (candidate.type === 'name') {
        const normalized = normalizeItemName(candidate.value);
        if (!normalized || skipNames.has(normalized)) continue;

        const id = getItemIdByName(bot, normalized);
        if (Number.isFinite(id)) {
          return { itemId: id, itemName: normalized };
        }
      }
    }

    for (const candidate of candidates) {
      if (candidate.type !== 'id') continue;
      const name = getItemNameFromId(bot, candidate.value);
      if (!name) {
        // Keep id-only frames usable on servers with custom items that are not
        // present in registry.items by name.
        return { itemId: candidate.value, itemName: null };
      }
      return { itemId: candidate.value, itemName: normalizeItemName(name) };
    }

    return null;
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

      const itemData = resolveFrameItemData(bot, entity);
      if (!itemData || !Number.isFinite(itemData.itemId)) {
        continue;
      }

      frames.push({ entity, distance, itemId: itemData.itemId, itemName: itemData.itemName });
    }

    frames.sort((a, b) => a.distance - b.distance);
    return frames;
  }

  function normalizeIngredientEntry(ingredient) {
    if (!ingredient) return null;

    if (Array.isArray(ingredient)) {
      for (const option of ingredient) {
        if (option && Number.isFinite(option.id) && option.id !== -1) {
          return option;
        }
      }
      return null;
    }

    if (typeof ingredient === 'object' && Number.isFinite(ingredient.id) && ingredient.id !== -1) {
      return ingredient;
    }

    return null;
  }

  function getRecipeAnalysis(recipe) {
    const required = new Map();
    let confident = false;

    if (Array.isArray(recipe.delta) && recipe.delta.length > 0) {
      for (const delta of recipe.delta) {
        if (!delta || delta.id == null || delta.id === -1 || delta.count >= 0) continue;
        required.set(delta.id, (required.get(delta.id) || 0) + Math.abs(delta.count));
      }
      return {
        required,
        confident: required.size > 0,
        source: 'delta'
      };
    }

    const ingredients = [];
    let unresolved = false;

    if (Array.isArray(recipe.inShape)) {
      for (const row of recipe.inShape) {
        if (!Array.isArray(row)) continue;
        for (const ingredient of row) {
          const normalized = normalizeIngredientEntry(ingredient);
          if (normalized) {
            ingredients.push(normalized);
          } else if (ingredient) {
            unresolved = true;
          }
        }
      }
    } else if (Array.isArray(recipe.ingredients)) {
      for (const ingredient of recipe.ingredients) {
        const normalized = normalizeIngredientEntry(ingredient);
        if (normalized) {
          ingredients.push(normalized);
        } else if (ingredient) {
          unresolved = true;
        }
      }
    }

    for (const ingredient of ingredients) {
      // Crafting grid entries are one unit per slot.
      required.set(ingredient.id, (required.get(ingredient.id) || 0) + 1);
    }

    confident = required.size > 0 && !unresolved;
    return {
      required,
      confident,
      source: 'shape-or-ingredients'
    };
  }

  function maxCraftableCount(bot, recipe) {
    const analysis = getRecipeAnalysis(recipe);
    const required = analysis.required;
    if (required.size === 0) return 0;

    let max = Infinity;
    for (const [itemId, needed] of required) {
      const have = bot.inventory.count(itemId, null);
      max = Math.min(max, Math.floor(have / needed));
    }

    return Number.isFinite(max) ? max : 0;
  }

  function recipeIngredientIds(recipe) {
    const analysis = getRecipeAnalysis(recipe);
    return {
      ids: new Set(analysis.required.keys()),
      confident: analysis.confident,
      source: analysis.source
    };
  }

  async function tossItemType(bot, itemType, state) {
    let stagnant = 0;

    while (state.enabled) {
      const stack = bot.inventory.items().find((item) => item.type === itemType);
      if (!stack) break;

      const beforeSignature = inventorySignature(bot);
      let result;
      try {
        result = await tossStackAsync(bot, stack, beforeSignature);
      } catch (error) {
        debugLog(`craft toss failed ${bot.username}: ${error.message}`);
        break;
      }

      if (!result.changed) {
        stagnant += 1;
        if (stagnant >= 3) break;
      } else {
        stagnant = 0;
      }

      await sleepJitter(130, 60);
    }
  }

  async function tossOutput(bot, recipe, state) {
    const outputId = recipe?.result?.id;
    if (!Number.isFinite(outputId)) return;
    await tossItemType(bot, outputId, state);
  }

  async function tossGarbage(bot, recipe, state) {
    const ingredientInfo = recipeIngredientIds(recipe);
    if (!ingredientInfo.confident) {
      debugLog(`craft pass ${bot.username}: skip garbage toss (uncertain ingredient map source=${ingredientInfo.source})`);
      return;
    }

    const keep = ingredientInfo.ids;
    const outputId = recipe?.result?.id;
    if (Number.isFinite(outputId)) {
      keep.add(outputId);
    }

    const garbageTypes = [...new Set(
      bot.inventory.items()
        .filter((item) => !keep.has(item.type))
        .map((item) => item.type)
    )];

    for (const type of garbageTypes) {
      if (!state.enabled) break;
      await tossItemType(bot, type, state);
    }
  }

  function getCraftTarget(bot, craftingTable) {
    const frames = getItemFramesNearPosition(bot, craftingTable.position);

    for (const frame of frames) {
      let recipes = bot.recipesFor(frame.itemId, null, 1, craftingTable);
      if ((!recipes || recipes.length === 0) && typeof bot.recipesAll === 'function') {
        recipes = bot.recipesAll(frame.itemId, null, craftingTable);
      }
      if (recipes.length === 0) continue;

      return {
        frame,
        itemId: frame.itemId,
        recipe: recipes[0]
      };
    }

    if (frames.length > 0) {
      debugLog(`craft target scan ${bot.username}: no recipes for nearby frames`,
        frames.slice(0, 8).map((frame) => `${frame.itemName || 'id-only'}#${frame.itemId}`)
      );
    }

    return null;
  }

  async function runCraftPass(bot, state) {
    if (!state.enabled || state.running) return;
    if (!bot.entity || !bot.inventory) return;

    state.running = true;
    try {
      const craftingTable = findCraftingTable(bot);
      if (!craftingTable) {
        debugLog(`craft pass ${bot.username}: no crafting table found`);
        return;
      }

      const target = getCraftTarget(bot, craftingTable);
      if (!target) {
        debugLog(`craft pass ${bot.username}: no craftable frame target found`);
        state.cachedRecipeItemId = null;
        state.cachedRecipe = null;
        state.cachedRecipeAtMs = 0;
        return;
      }

      if (!state.enabled) return;

      await lookAtJitter(bot, target.frame.entity.position.offset(0, 0.5, 0));
      await sleepJitter(140, 70);

      const nowMs = Date.now();
      const cacheExpired =
        !state.cachedRecipeAtMs || (nowMs - state.cachedRecipeAtMs) >= RECIPE_CACHE_TTL_MS;

      if (state.cachedRecipeItemId !== target.itemId || cacheExpired) {
        state.cachedRecipeItemId = target.itemId;
        state.cachedRecipe = target.recipe;
        state.cachedRecipeAtMs = nowMs;
      }

      const recipe = state.cachedRecipe;
      if (!recipe) return;

      const initialCraftCount = maxCraftableCount(bot, recipe);
      if (initialCraftCount <= 0) {
        debugLog(`craft pass ${bot.username}: missing ingredients for target ${target.itemId}`);
        return;
      }

      if (bot.currentWindow) {
        bot.closeWindow(bot.currentWindow);
        await sleepJitter(220, 80);
      }

      if (!state.enabled) return;

      try {
        await bot.craft(recipe, initialCraftCount, craftingTable);
      } catch (error) {
        const message = String(error?.message || '').toLowerCase();
        const inventoryLikelyFull =
          message.includes('inventory') || message.includes('full') || message.includes('space');

        if (!inventoryLikelyFull) throw error;

        debugLog(`craft pass ${bot.username}: inventory full, draining and retrying once`);
        await tossOutput(bot, recipe, state);
        await sleepJitter(150, 60);

        if (!state.enabled) return;

        if (bot.currentWindow) {
          bot.closeWindow(bot.currentWindow);
          await sleepJitter(120, 50);
        }

        const retryCraftCount = maxCraftableCount(bot, recipe);
        if (retryCraftCount > 0) {
          await bot.craft(recipe, retryCraftCount, craftingTable);
        }
      }

      if (!state.enabled) return;

      await sleepJitter(110, 40);
      await tossOutput(bot, recipe, state);
      await tossGarbage(bot, recipe, state);

      debugLog(
        `craft pass ${bot.username}: done item=${target.itemId} frame=${target.frame.itemName || 'unknown'}`
      );
    } catch (error) {
      console.warn(`[${bot.username}] craft pass error: ${error.message}`);
      try {
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
      } catch (_) {}
      await sleepJitter(2000, 600);
    } finally {
      state.running = false;
    }
  }

  function scheduleNextPass(bot, state) {
    if (!state.enabled) return;

    const delay = randomDelay(500, 250);
    state.timeout = setTimeout(() => {
      runCraftPass(bot, state)
        .catch((error) => {
          console.warn(`[${bot.username}] craft pass failed: ${error.message}`);
        })
        .finally(() => {
          scheduleNextPass(bot, state);
        });
    }, delay);
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
      timeout: null,
      cachedRecipeItemId: null,
      cachedRecipe: null,
      cachedRecipeAtMs: 0
    };

    craftStates.set(botName, state);
    scheduleNextPass(bot, state);
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
    if (state.timeout) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }

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
    const sub = String(parts[1] || '').toLowerCase();

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
