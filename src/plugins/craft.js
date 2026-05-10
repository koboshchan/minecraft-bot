const assert = require('assert');
const { once } = require('mineflayer/lib/promise_utils');

module.exports = injectCraftPlugin;

function injectCraftPlugin(bot) {
  const Item = require('prismarine-item')(bot.registry);
  const Recipe = require('prismarine-recipe')(bot.registry).Recipe;
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

  async function craft(recipe, count, craftingTable) {
    assert.ok(recipe);
    count = parseInt(count ?? 1, 10);
    if (recipe.requiresTable && !craftingTable) {
      throw new Error(`Recipe requires craftingTable, but one was not supplied: ${JSON.stringify(recipe)}`);
    }

    try {
      for (let index = 0; index < count; index += 1) {
        await craftOnce(recipe, craftingTable);
      }
    } catch (err) {
      closeCraftingWindow();
      throw new Error(err);
    }

    closeCraftingWindow();
  }

  async function craftStack(recipe, count, craftingTable) {
    assert.ok(recipe);
    count = parseInt(count ?? 1, 10);
    if (recipe.requiresTable && !craftingTable) {
      throw new Error(`Recipe requires craftingTable, but one was not supplied: ${JSON.stringify(recipe)}`);
    }

    try {
      let remaining = count;
      while (remaining > 0) {
        const batchCount = Math.min(remaining, getMaxBatchCount(recipe));
        if (batchCount <= 0) {
          throw new Error('invalid craft stack batch size');
        }
        await craftStackOnce(recipe, batchCount, craftingTable);
        remaining -= batchCount;
      }
    } catch (err) {
      closeCraftingWindow();
      throw new Error(err);
    }

    closeCraftingWindow();
  }

  async function craftStackDrop(recipe, count, craftingTable) {
    assert.ok(recipe);
    count = parseInt(count ?? 1, 10);
    if (recipe.requiresTable && !craftingTable) {
      throw new Error(`Recipe requires craftingTable, but one was not supplied: ${JSON.stringify(recipe)}`);
    }

    try {
      let remaining = count;
      while (remaining > 0) {
        const batchCount = Math.min(remaining, getMaxBatchCount(recipe));
        if (batchCount <= 0) {
          throw new Error('invalid craft stack batch size');
        }
        await craftStackDropOnce(recipe, batchCount, craftingTable);
        remaining -= batchCount;
      }
    } catch (err) {
      closeCraftingWindow();
      throw new Error(err);
    }

    closeCraftingWindow();
  }

  async function craftOnce(recipe, craftingTable) {
    const window = await getCraftWindow(craftingTable);
    await startClicking(window, craftingTable ? 3 : 2, craftingTable ? 3 : 2);

    async function startClicking(window, width, height) {
      const extraSlots = unusedRecipeSlots();
      let ingredientIndex = 0;
      let originalSourceSlot = null;
      let iterator;

      if (recipe.inShape) {
        iterator = {
          x: 0,
          y: 0,
          row: recipe.inShape[0]
        };
        await clickShape();
      } else {
        await nextIngredientsClick();
      }

      function incrementShapeIterator() {
        iterator.x += 1;
        if (iterator.x >= iterator.row.length) {
          iterator.y += 1;
          if (iterator.y >= recipe.inShape.length) return null;
          iterator.x = 0;
          iterator.row = recipe.inShape[iterator.y];
        }
        return iterator;
      }

      async function nextShapeClick() {
        if (incrementShapeIterator()) {
          await clickShape();
        } else if (!recipe.ingredients) {
          await putMaterialsAway();
        } else {
          await nextIngredientsClick();
        }
      }

      async function clickShape() {
        const destinationSlot = slot(iterator.x, iterator.y);
        const ingredient = iterator.row[iterator.x];
        if (ingredient.id === -1) return nextShapeClick();
        if (!window.selectedItem || window.selectedItem.type !== ingredient.id ||
          (ingredient.metadata != null && window.selectedItem.metadata !== ingredient.metadata)) {
          const sourceItem = window.findInventoryItem(ingredient.id, ingredient.metadata);
          if (!sourceItem) throw new Error('missing ingredient');
          if (originalSourceSlot == null) originalSourceSlot = sourceItem.slot;
          await bot.clickWindow(sourceItem.slot, 0, 0);
        }
        await bot.clickWindow(destinationSlot, 1, 0);
        await nextShapeClick();
      }

      async function nextIngredientsClick() {
        const ingredient = recipe.ingredients[ingredientIndex];
        const destinationSlot = extraSlots.pop();
        if (!window.selectedItem || window.selectedItem.type !== ingredient.id ||
          (ingredient.metadata != null && window.selectedItem.metadata !== ingredient.metadata)) {
          const sourceItem = window.findInventoryItem(ingredient.id, ingredient.metadata);
          if (!sourceItem) throw new Error('missing ingredient');
          if (originalSourceSlot == null) originalSourceSlot = sourceItem.slot;
          await bot.clickWindow(sourceItem.slot, 0, 0);
        }
        await bot.clickWindow(destinationSlot, 1, 0);
        ingredientIndex += 1;
        if (ingredientIndex < recipe.ingredients.length) {
          await nextIngredientsClick();
        } else {
          await putMaterialsAway();
        }
      }

      async function putMaterialsAway() {
        const start = window.inventoryStart;
        const end = window.inventoryEnd;
        await bot.putSelectedItemRange(start, end, window, originalSourceSlot);
        await grabResult();
      }

      async function grabResult() {
        assert.strictEqual(window.selectedItem, null);
        const item = new Item(recipe.result.id, recipe.result.count, recipe.result.metadata);
        window.updateSlot(0, item);
        await bot.putAway(0);
        await updateOutShape();
      }

      async function updateOutShape() {
        if (!recipe.outShape) {
          for (let slotIndex = 1; slotIndex <= width * height; slotIndex += 1) {
            window.updateSlot(slotIndex, null);
          }
          return;
        }

        const slotsToClick = [];
        for (let y = 0; y < recipe.outShape.length; y += 1) {
          const row = recipe.outShape[y];
          for (let x = 0; x < row.length; x += 1) {
            const resultSlot = slot(x, y);
            let item = null;
            if (row[x].id !== -1) {
              item = new Item(row[x].id, row[x].count, row[x].metadata || null);
              slotsToClick.push(resultSlot);
            }
            window.updateSlot(resultSlot, item);
          }
        }

        for (const resultSlot of slotsToClick) {
          await bot.putAway(resultSlot);
        }
      }

      function slot(x, y) {
        return 1 + x + width * y;
      }

      function unusedRecipeSlots() {
        const result = [];
        let x;
        let y;
        let row;
        if (recipe.inShape) {
          for (y = 0; y < recipe.inShape.length; y += 1) {
            row = recipe.inShape[y];
            for (x = 0; x < row.length; x += 1) {
              if (row[x].id === -1) result.push(slot(x, y));
            }
            for (; x < width; x += 1) {
              result.push(slot(x, y));
            }
          }
          for (; y < height; y += 1) {
            for (x = 0; x < width; x += 1) {
              result.push(slot(x, y));
            }
          }
        } else {
          for (y = 0; y < height; y += 1) {
            for (x = 0; x < width; x += 1) {
              result.push(slot(x, y));
            }
          }
        }
        return result;
      }
    }
  }

  async function craftStackOnce(recipe, count, craftingTable) {
    const window = await getCraftWindow(craftingTable);
    await startClicking(window, craftingTable ? 3 : 2, craftingTable ? 3 : 2);

    async function startClicking(window, width, height) {
      const extraSlots = unusedRecipeSlots();
      let ingredientIndex = 0;
      let originalSourceSlot = null;
      let iterator;

      if (recipe.inShape) {
        iterator = {
          x: 0,
          y: 0,
          row: recipe.inShape[0]
        };
        await clickShape();
      } else {
        await nextIngredientsClick();
      }

      function incrementShapeIterator() {
        iterator.x += 1;
        if (iterator.x >= iterator.row.length) {
          iterator.y += 1;
          if (iterator.y >= recipe.inShape.length) return null;
          iterator.x = 0;
          iterator.row = recipe.inShape[iterator.y];
        }
        return iterator;
      }

      async function nextShapeClick() {
        if (incrementShapeIterator()) {
          await clickShape();
        } else if (!recipe.ingredients) {
          await putMaterialsAway();
        } else {
          await nextIngredientsClick();
        }
      }

      async function ensureSelectedIngredient(ingredient) {
        if (!window.selectedItem || window.selectedItem.type !== ingredient.id ||
          (ingredient.metadata != null && window.selectedItem.metadata !== ingredient.metadata)) {
          const sourceItem = window.findInventoryItem(ingredient.id, ingredient.metadata);
          if (!sourceItem) throw new Error('missing ingredient');
          if (originalSourceSlot == null) originalSourceSlot = sourceItem.slot;
          await bot.clickWindow(sourceItem.slot, 0, 0);
        }
      }

      async function placeIngredientCount(destinationSlot, ingredient) {
        const perCraftCount = ingredient.count ?? 1;
        let remaining = count * perCraftCount;
        while (remaining > 0) {
          await ensureSelectedIngredient(ingredient);
          const heldCount = window.selectedItem?.count || 0;
          if (heldCount <= 0) throw new Error('missing ingredient');

          const placements = Math.min(remaining, heldCount);
          if (placements === heldCount) {
            await bot.clickWindow(destinationSlot, 0, 0);
          } else if (Math.floor(heldCount / 2) === placements) {
            await bot.clickWindow(destinationSlot, 0, 0); // left click places all
            await bot.clickWindow(destinationSlot, 1, 0); // right click picks up half
          } else {
            for (let placement = 0; placement < placements; placement += 1) {
              await bot.clickWindow(destinationSlot, 1, 0);
            }
          }

          remaining -= placements;
        }
      }

      async function clickShape() {
        const destinationSlot = slot(iterator.x, iterator.y);
        const ingredient = iterator.row[iterator.x];
        if (ingredient.id === -1) return nextShapeClick();
        await placeIngredientCount(destinationSlot, ingredient);
        await nextShapeClick();
      }

      async function nextIngredientsClick() {
        const ingredient = recipe.ingredients[ingredientIndex];
        const destinationSlot = extraSlots.pop();
        await placeIngredientCount(destinationSlot, ingredient);
        ingredientIndex += 1;
        if (ingredientIndex < recipe.ingredients.length) {
          await nextIngredientsClick();
        } else {
          await putMaterialsAway();
        }
      }

      async function putMaterialsAway() {
        const start = window.inventoryStart;
        const end = window.inventoryEnd;
        await bot.putSelectedItemRange(start, end, window, originalSourceSlot);
        await grabResult();
      }

      async function grabResult() {
        assert.strictEqual(window.selectedItem, null);
        const item = new Item(recipe.result.id, recipe.result.count, recipe.result.metadata);
        window.updateSlot(0, item);
        await bot.clickWindow(0, 0, 1);
      }

      function slot(x, y) {
        return 1 + x + width * y;
      }

      function unusedRecipeSlots() {
        const result = [];
        let x;
        let y;
        let row;
        if (recipe.inShape) {
          for (y = 0; y < recipe.inShape.length; y += 1) {
            row = recipe.inShape[y];
            for (x = 0; x < row.length; x += 1) {
              if (row[x].id === -1) result.push(slot(x, y));
            }
            for (; x < width; x += 1) {
              result.push(slot(x, y));
            }
          }
          for (; y < height; y += 1) {
            for (x = 0; x < width; x += 1) {
              result.push(slot(x, y));
            }
          }
        } else {
          for (y = 0; y < height; y += 1) {
            for (x = 0; x < width; x += 1) {
              result.push(slot(x, y));
            }
          }
        }
        return result;
      }
    }
  }

  async function craftStackDropOnce(recipe, count, craftingTable) {
    const window = await getCraftWindow(craftingTable);
    await startClicking(window, craftingTable ? 3 : 2, craftingTable ? 3 : 2);

    async function startClicking(window, width, height) {
      const extraSlots = unusedRecipeSlots();
      let ingredientIndex = 0;
      let originalSourceSlot = null;
      let iterator;

      if (recipe.inShape) {
        iterator = {
          x: 0,
          y: 0,
          row: recipe.inShape[0]
        };
        await clickShape();
      } else {
        await nextIngredientsClick();
      }

      function incrementShapeIterator() {
        iterator.x += 1;
        if (iterator.x >= iterator.row.length) {
          iterator.y += 1;
          if (iterator.y >= recipe.inShape.length) return null;
          iterator.x = 0;
          iterator.row = recipe.inShape[iterator.y];
        }
        return iterator;
      }

      async function nextShapeClick() {
        if (incrementShapeIterator()) {
          await clickShape();
        } else if (!recipe.ingredients) {
          await putMaterialsAway();
        } else {
          await nextIngredientsClick();
        }
      }

      async function ensureSelectedIngredient(ingredient) {
        if (!window.selectedItem || window.selectedItem.type !== ingredient.id ||
          (ingredient.metadata != null && window.selectedItem.metadata !== ingredient.metadata)) {
          const sourceItem = window.findInventoryItem(ingredient.id, ingredient.metadata);
          if (!sourceItem) throw new Error('missing ingredient');
          if (originalSourceSlot == null) originalSourceSlot = sourceItem.slot;
          await bot.clickWindow(sourceItem.slot, 0, 0);
        }
      }

      async function placeIngredientCount(destinationSlot, ingredient) {
        const perCraftCount = ingredient.count ?? 1;
        let remaining = count * perCraftCount;
        while (remaining > 0) {
          await ensureSelectedIngredient(ingredient);
          const heldCount = window.selectedItem?.count || 0;
          if (heldCount <= 0) throw new Error('missing ingredient');

          const placements = Math.min(remaining, heldCount);
          if (placements === heldCount) {
            await bot.clickWindow(destinationSlot, 0, 0);
          } else if (Math.floor(heldCount / 2) === placements) {
            await bot.clickWindow(destinationSlot, 0, 0); // left click places all
            await bot.clickWindow(destinationSlot, 1, 0); // right click picks up half
          } else {
            for (let placement = 0; placement < placements; placement += 1) {
              await bot.clickWindow(destinationSlot, 1, 0);
            }
          }

          remaining -= placements;
        }
      }

      async function clickShape() {
        const destinationSlot = slot(iterator.x, iterator.y);
        const ingredient = iterator.row[iterator.x];
        if (ingredient.id === -1) return nextShapeClick();
        await placeIngredientCount(destinationSlot, ingredient);
        await nextShapeClick();
      }

      async function nextIngredientsClick() {
        const ingredient = recipe.ingredients[ingredientIndex];
        const destinationSlot = extraSlots.pop();
        await placeIngredientCount(destinationSlot, ingredient);
        ingredientIndex += 1;
        if (ingredientIndex < recipe.ingredients.length) {
          await nextIngredientsClick();
        } else {
          await putMaterialsAway();
        }
      }

      async function putMaterialsAway() {
        const start = window.inventoryStart;
        const end = window.inventoryEnd;
        await bot.putSelectedItemRange(start, end, window, originalSourceSlot);
        await dropResultToGround();
      }

      async function dropResultToGround() {
        assert.strictEqual(window.selectedItem, null);
        const predicted = new Item(recipe.result.id, recipe.result.count, recipe.result.metadata);

        if (!window.slots[0]) {
          window.updateSlot(0, predicted);
        }

        // Drop the entire crafted batch instantly
        await bot.clickWindow(0, 1, 4);
      }

      function slot(x, y) {
        return 1 + x + width * y;
      }

      function unusedRecipeSlots() {
        const result = [];
        let x;
        let y;
        let row;
        if (recipe.inShape) {
          for (y = 0; y < recipe.inShape.length; y += 1) {
            row = recipe.inShape[y];
            for (x = 0; x < row.length; x += 1) {
              if (row[x].id === -1) result.push(slot(x, y));
            }
            for (; x < width; x += 1) {
              result.push(slot(x, y));
            }
          }
          for (; y < height; y += 1) {
            for (x = 0; x < width; x += 1) {
              result.push(slot(x, y));
            }
          }
        } else {
          for (y = 0; y < height; y += 1) {
            for (x = 0; x < width; x += 1) {
              result.push(slot(x, y));
            }
          }
        }
        return result;
      }
    }
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
    maxBatchCount = Math.min(maxBatchCount, Math.floor(32 / resultCount));

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

  bot.craft = craft;
  bot.craftStack = craftStack;
  bot.craftStackDrop = craftStackDrop;
  bot.craftStackBatchSize = getMaxBatchCount;
  bot.recipesFor = recipesFor;
  bot.recipesAll = recipesAll;
}