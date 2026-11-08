// What was done from this browser, with links to look each step up, and the transfers made
// through NEAR Intents. The chains are the real record: this is a convenience kept only in
// this browser. The simulator's record lasts until the page reloads or the world is reset.

const lists = new Map();
const transfers = new Map();
const key = (what, kind) => `ripcord.${what}.${kind}`;

function load(store, what, kind) {
  if (store.has(kind)) return store.get(kind);
  let list = [];
  if (kind !== 'sim') {
    try {
      list = JSON.parse(localStorage.getItem(key(what, kind))) ?? [];
    } catch {
      list = [];
    }
  }
  store.set(kind, list);
  return list;
}

function save(store, what, kind) {
  if (kind === 'sim') return;
  try {
    localStorage.setItem(key(what, kind), JSON.stringify(store.get(kind)));
  } catch {
    // Storage can be blocked. The list still works until the page closes.
  }
}

/** Adds a step. `links` are `{ label, url }`, with no url for anything simulated. */
export function record(kind, entry) {
  const list = load(lists, 'history', kind);
  list.unshift({ at: Date.now(), links: [], ...entry });
  if (list.length > 300) list.length = 300;
  save(lists, 'history', kind);
}

export const historyOf = (kind) => load(lists, 'history', kind);

export function saveTransfer(kind, transfer) {
  const list = load(transfers, 'transfers', kind);
  list.unshift({ createdAt: Date.now(), ...transfer });
  save(transfers, 'transfers', kind);
}

export function updateTransfer(kind, depositAddress, patch) {
  const list = load(transfers, 'transfers', kind);
  const t = list.find((x) => x.depositAddress === depositAddress);
  if (!t) return null;
  Object.assign(t, patch);
  save(transfers, 'transfers', kind);
  return t;
}

export const transfersOf = (kind) => load(transfers, 'transfers', kind);

export function forget(kind) {
  lists.set(kind, []);
  transfers.set(kind, []);
}
