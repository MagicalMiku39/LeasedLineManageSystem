// Pure helpers for the ledger's column choice and column order, both kept in the browser.

export function readStoredJson(storage, key) {
  try {
    const raw = storage?.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeStoredJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be full or blocked; the in-memory setting still applies for this visit.
  }
}

// A saved list of visible columns is kept as saved (an empty list stays empty), minus keys
// that no longer exist. Anything that is not a list falls back to the defaults.
export function normalizeVisibleColumns(saved, allKeys, defaults) {
  if (!Array.isArray(saved)) return [...defaults];
  return saved.filter((key) => allKeys.includes(key));
}

// Saved order first, then any column added since, so new columns are never lost.
export function normalizeColumnOrder(saved, allKeys) {
  if (!Array.isArray(saved)) return [...allKeys];
  return [...new Set([...saved.filter((key) => allKeys.includes(key)), ...allKeys])];
}

export function toggleKey(list, key) {
  return list.includes(key) ? list.filter((item) => item !== key) : [...list, key];
}

// Moves `source` next to `target`, before or after it.
export function moveColumn(order, source, target, after) {
  if (!source || source === target || !order.includes(source) || !order.includes(target)) return order;
  const next = order.filter((key) => key !== source);
  next.splice(next.indexOf(target) + (after ? 1 : 0), 0, source);
  return next;
}
