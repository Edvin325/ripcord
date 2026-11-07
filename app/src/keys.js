// Owner keys and small per-vault notes. They live only in this browser. The live network's
// key is also offered as a download, because a browser is not a safe place to keep the
// one thing that recovers your coins.

const memory = new Map();
const slot = (kind, id) => `ripcord.vault.${kind}.${id}`;

export function remember(kind, id, note) {
  const merged = { ...recall(kind, id), ...note };
  memory.set(slot(kind, id), merged);
  if (kind === 'live') {
    try {
      localStorage.setItem(slot(kind, id), JSON.stringify(merged));
    } catch {
      // Storage can be blocked. The in-memory copy and the download still work.
    }
  }
}

export function recall(kind, id) {
  const held = memory.get(slot(kind, id));
  if (held) return held;
  if (kind !== 'live') return {};
  try {
    return JSON.parse(localStorage.getItem(slot(kind, id))) ?? {};
  } catch {
    return {};
  }
}
