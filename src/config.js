const DEFAULT_VIEW_DISTANCE = 2;
const VIEW_DISTANCE_PRESETS = new Set(['far', 'normal', 'short', 'tiny']);

// Mineflayer asserts on an invalid viewDistance, so normalize it here.
// Bots only ever need blocks within ~12 of themselves, so the default is small:
// a large view distance makes the server stream chunks, block updates and
// entities the bot never looks at, which is pure CPU cost per bot.
function parseViewDistance(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return DEFAULT_VIEW_DISTANCE;

  if (VIEW_DISTANCE_PRESETS.has(value)) return value;

  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 2) return numeric;

  console.warn(
    `Invalid VIEW_DISTANCE "${raw}", falling back to ${DEFAULT_VIEW_DISTANCE}. ` +
    `Use an integer >= 2 or one of: ${[...VIEW_DISTANCE_PRESETS].join(', ')}`
  );
  return DEFAULT_VIEW_DISTANCE;
}

module.exports = { parseViewDistance, DEFAULT_VIEW_DISTANCE };
