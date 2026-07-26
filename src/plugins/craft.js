const assert = require('assert');
const { once } = require('mineflayer/lib/promise_utils');

module.exports = injectCraftPlugin;

function injectCraftPlugin(bot) {
  const Item = require('prismarine-item')(bot.registry);
  const Recipe = require('prismarine-recipe')(bot.registry).Recipe;
  const CLICK_SLEEP_MS = 1;
  const PLACE_SIZES = [64, 32];
  let windowCraftingTable;

  function closeCraftingWindow() {
    if (windowCraftingTable) {
      bot.closeWindow(windowCraftingTable);
      windowCraftingTable = undefined;
    }
  }

  async function getCraftWindow(craftingTable) {
    if (!craftingTable) return bot.inventory;

    if (!windowCraftingTable) {
      bot.activateBlock(craftingTable);
      const openPromise = once(bot, 'windowOpen');
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('getCraftWindow: windowOpen timeout')), 5000)
      );
      const [window] = await Promise.race([openPromise, timeoutPromise]);
      windowCraftingTable = window;
    }

    if (!windowCraftingTable.type.startsWith('minecraft:crafting')) {
      throw new Error(`crafting: non craftingTable used as craftingTable: ${windowCraftingTable.type}`);
    }

    return windowCraftingTable;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function craftStackDrop(recipe, count, craftingTable) {
    assert.ok(recipe);
    count = parseInt(count ?? 1, 10);
    if (recipe.requiresTable && !craftingTable) {
      throw new Error(`Recipe requires craftingTable, but one was not supplied`);
    }

    const startTime = Date.now();
    let totalClicks = 0;

    const debugLog = (msg) => {
      bot.emit('craft_debug', msg);
    };

    const infoLog = (msg) => {
      bot.emit('craft_log', msg);
    };

    infoLog(`Starting craft run for ${count} items...`);

    try {
      let remaining = count;
      while (remaining > 0) {
        const batchCount = Math.min(remaining, getMaxBatchCount(recipe));
        if (batchCount <= 0) {
          throw new Error('invalid craft stack batch size');
        }
        const clicks = await craftStackDropOnce(recipe, batchCount, craftingTable, debugLog);
        totalClicks += clicks;
        remaining -= batchCount;
      }
      const elapsed = Date.now() - startTime;
      infoLog(`Craft run completed successfully in ${elapsed}ms! Total clicks: ${totalClicks}`);
    } finally {
      closeCraftingWindow();
    }
  }

  async function craftStackDropOnce(recipe, count, craftingTable, debugLog) {
    const window = await getCraftWindow(craftingTable);
    const width = craftingTable ? 3 : 2;
    let clickCount = 0;

    const click = async (slot, button, mode) => {
      clickCount++;
      await bot.clickWindow(slot, button, mode);
    };

    // 1. Identify valid recipe ingredients to protect them
    const ingredientIds = new Set();
    if (recipe.delta) {
      recipe.delta.forEach((d) => {
        if (d.count < 0) {
          ingredientIds.add(d.id);
        }
      });
    }

    // 2. Garbage Disposal: toss all non-ingredient items in the inventory
    for (const item of window.items()) {
      if (item && item.slot >= window.inventoryStart && item.slot < window.inventoryEnd) {
        if (!ingredientIds.has(item.type)) {
          debugLog(`tossing garbage item ${item.name} from slot ${item.slot}`);
          await click(item.slot, 1, 4); // drop full stack
          await sleep(CLICK_SLEEP_MS);
        }
      }
    }

    // Helper to place item and recover from desyncs
    async function placeIngredient(destSlot, ingredientId, ingredientMetadata, neededCount) {
      let remaining = neededCount;
      while (remaining > 0) {
        // Ensure correct item is held
        if (!window.selectedItem || window.selectedItem.type !== ingredientId ||
            (ingredientMetadata != null && window.selectedItem.metadata !== ingredientMetadata)) {
          
          if (window.selectedItem) {
            debugLog(`holding wrong item ${window.selectedItem.name}, putting away`);
            await clearSelectedItem();
          }

          const sourceItem = window.findInventoryItem(ingredientId, ingredientMetadata);
          if (!sourceItem) {
            throw new Error(`missing ingredient: type ${ingredientId}`);
          }

          debugLog(`picking up ingredient type ${ingredientId} from slot ${sourceItem.slot}`);
          await click(sourceItem.slot, 0, 0);
          await sleep(CLICK_SLEEP_MS);

          if (!window.selectedItem || window.selectedItem.type !== ingredientId) {
            throw new Error(`desync: failed to pick up ingredient type ${ingredientId}`);
          }
        }

        const heldCount = window.selectedItem.count;
        const placements = Math.min(remaining, heldCount);

        debugLog(`placing ${placements} items into slot ${destSlot}`);
        if (placements === heldCount) {
          await click(destSlot, 0, 0);
        } else {
          for (let i = 0; i < placements; i++) {
            await click(destSlot, 1, 0);
            await sleep(CLICK_SLEEP_MS);
          }
        }
        await sleep(CLICK_SLEEP_MS);
        remaining -= placements;
      }
    }

    async function clearSelectedItem() {
      if (window.selectedItem) {
        try {
          const emptySlot = window.firstEmptyInventorySlot();
          if (emptySlot !== null) {
            await click(emptySlot, 0, 0);
          } else {
            debugLog(`inventory full, dropping leftover item from hand`);
            await click(-999, 0, 0); // click outside drops held item
          }
          await sleep(CLICK_SLEEP_MS);
        } catch (e) {
          debugLog(`failed to clear selected item: ${e.message}`);
        }
      }
    }

    // 3. Build slot requirement map
    const gridRequirements = new Map();

    if (recipe.inShape) {
      for (let y = 0; y < recipe.inShape.length; y++) {
        const row = recipe.inShape[y];
        for (let x = 0; x < row.length; x++) {
          const ingredient = row[x];
          if (ingredient && ingredient.id !== -1) {
            const destSlot = 1 + x + width * y;
            gridRequirements.set(destSlot, ingredient);
          }
        }
      }
    } else if (recipe.ingredients) {
      let destSlot = 1;
      for (const ingredient of recipe.ingredients) {
        if (ingredient && ingredient.id !== -1) {
          gridRequirements.set(destSlot, ingredient);
          destSlot++;
        }
      }
    }

    // 4. Count what is actually on hand right now. Read live rather than from a
    //    snapshot, so items delivered while the grid is being filled are seen.
    function countAvailable(ingredientId, ingredientMetadata) {
      let total = 0;
      for (const item of window.items()) {
        if (!item || item.type !== ingredientId) continue;
        if (item.slot < window.inventoryStart || item.slot >= window.inventoryEnd) continue;
        if (ingredientMetadata != null && item.metadata !== ingredientMetadata) continue;
        total += item.count;
      }
      const held = window.selectedItem;
      if (held && held.type === ingredientId &&
          (ingredientMetadata == null || held.metadata === ingredientMetadata)) {
        total += held.count;
      }
      return total;
    }

    // Group the grid by ingredient so slots sharing a type reuse the held stack.
    const slotsForIngredient = new Map();
    for (const [destSlot, ingredient] of gridRequirements.entries()) {
      if (!slotsForIngredient.has(ingredient.id)) slotsForIngredient.set(ingredient.id, []);
      slotsForIngredient.get(ingredient.id).push(destSlot);
    }

    const placedCounts = new Map();
    for (const destSlot of gridRequirements.keys()) placedCounts.set(destSlot, 0);

    // 5. Fill the grid in rounds. Each round re-reads live inventory and adaptively
    //    upgrades to 32 or 64 per slot, so ingredients that arrived mid-pass get
    //    topped up into the table instead of waiting for the next craft pass.
    for (let round = 0; round < 2; round += 1) {
      let placedAny = false;

      for (const [ingredientId, destSlots] of slotsForIngredient.entries()) {
        const ingredient = gridRequirements.get(destSlots[0]);
        const metadata = ingredient.metadata || null;
        const neededCount = count * (ingredient.count ?? 1);
        const available = countAvailable(ingredientId, metadata);

        // How many more items a uniform target would cost across this ingredient's slots.
        const deficitFor = (target) =>
          destSlots.reduce((sum, slot) => sum + Math.max(0, target - placedCounts.get(slot)), 0);

        let target = neededCount;
        for (const size of PLACE_SIZES) {
          if (neededCount <= size && deficitFor(size) <= available) {
            target = size;
            break;
          }
        }

        for (const destSlot of destSlots) {
          const missing = target - placedCounts.get(destSlot);
          if (missing <= 0) continue;
          debugLog(`filling slot ${destSlot} to ${target} (adding ${missing}, available ${available})`);
          await placeIngredient(destSlot, ingredientId, metadata, missing);
          placedCounts.set(destSlot, target);
          placedAny = true;
        }
      }

      if (!placedAny) break;
    }

    // 6. Clear cursor before crafting
    await clearSelectedItem();

    // 7. Drop the crafted output directly from slot 0
    debugLog(`dropping crafted output from slot 0`);
    await click(0, 1, 4); // mode 4 button 1: drop stack
    await sleep(CLICK_SLEEP_MS);

    return clickCount;
  }

  function recipesFor(itemType, metadata, minResultCount, craftingTable) {
    minResultCount = minResultCount ?? 1;
    const results = [];
    Recipe.find(itemType, metadata).forEach((recipe) => {
      if (requirementsMetForRecipe(recipe, minResultCount, craftingTable)) {
        results.push(recipe);
      }
    });
    return results;
  }

  function recipesAll(itemType, metadata, craftingTable) {
    const results = [];
    Recipe.find(itemType, metadata).forEach((recipe) => {
      if (!recipe.requiresTable || craftingTable) {
        results.push(recipe);
      }
    });
    return results;
  }

  function requirementsMetForRecipe(recipe, minResultCount, craftingTable) {
    if (recipe.requiresTable && !craftingTable) return false;

    const craftCount = Math.ceil(minResultCount / recipe.result.count);

    for (let index = 0; index < recipe.delta.length; index += 1) {
      const delta = recipe.delta[index];
      if (bot.inventory.count(delta.id, delta.metadata) + delta.count * craftCount < 0) return false;
    }

    return true;
  }

  function getMaxBatchCount(recipe) {
    const slotRequirements = getRecipeSlotRequirements(recipe);
    if (slotRequirements.length === 0) return 1;

    let maxBatchCount = Infinity;
    for (const ingredient of slotRequirements) {
      const perCraftCount = ingredient.count ?? 1;
      const stackLimit = ingredient.stackSize ?? bot.registry.items[ingredient.id]?.stackSize ?? 64;
      maxBatchCount = Math.min(maxBatchCount, Math.floor(stackLimit / perCraftCount));
    }

    const resultCount = recipe.result?.count ?? 1;
    const resultStackLimit = bot.registry.items[recipe.result.id]?.stackSize ?? 64;
    maxBatchCount = Math.min(maxBatchCount, Math.floor(resultStackLimit / resultCount));

    return Number.isFinite(maxBatchCount) && maxBatchCount > 0 ? maxBatchCount : 1;
  }

  function getRecipeSlotRequirements(recipe) {
    const requirements = [];

    if (recipe.inShape) {
      for (const row of recipe.inShape) {
        for (const ingredient of row) {
          if (ingredient && ingredient.id !== -1) requirements.push(ingredient);
        }
      }
      return requirements;
    }

    if (recipe.ingredients) {
      for (const ingredient of recipe.ingredients) {
        if (ingredient && ingredient.id !== -1) requirements.push(ingredient);
      }
    }

    return requirements;
  }

  bot.craftStackDrop = craftStackDrop;
  bot.craftStackBatchSize = getMaxBatchCount;
  bot.recipesFor = recipesFor;
  bot.recipesAll = recipesAll;
}