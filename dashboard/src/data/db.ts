const DB_NAME = "eris-dashboard";
const DB_VERSION = 8;

export const STORES = {
  round: "round",
  agents: "agents",
  topExtras: "topExtras",
  explorerStats: "explorerStats",
  blocks: "blocks",
  transactions: "transactions",
  marketSnapshot: "marketSnapshot",
  archive: "archive",
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        // Mock data shape changes between versions, so drop and reseed rather than migrate.
        if (db.objectStoreNames.contains(STORES.agents)) {
          db.deleteObjectStore(STORES.agents);
        }
        if (db.objectStoreNames.contains(STORES.transactions)) {
          db.deleteObjectStore(STORES.transactions);
        }
        for (const legacyStore of ["markets", "events", "ticker"]) {
          if (db.objectStoreNames.contains(legacyStore)) {
            db.deleteObjectStore(legacyStore);
          }
        }
        if (db.objectStoreNames.contains(STORES.round)) {
          db.deleteObjectStore(STORES.round);
        }
        // marketSnapshot gained the `arbitrage` field (cross-venue price view) — reseed rather than migrate.
        if (db.objectStoreNames.contains(STORES.marketSnapshot)) {
          db.deleteObjectStore(STORES.marketSnapshot);
        }
        db.createObjectStore(STORES.round);
        db.createObjectStore(STORES.agents, { keyPath: "rank" });
        if (!db.objectStoreNames.contains(STORES.topExtras)) {
          db.createObjectStore(STORES.topExtras);
        }
        if (!db.objectStoreNames.contains(STORES.explorerStats)) {
          db.createObjectStore(STORES.explorerStats);
        }
        if (!db.objectStoreNames.contains(STORES.blocks)) {
          db.createObjectStore(STORES.blocks, { keyPath: "number" });
        }
        db.createObjectStore(STORES.transactions, { keyPath: "hash" });
        if (!db.objectStoreNames.contains(STORES.marketSnapshot)) {
          db.createObjectStore(STORES.marketSnapshot);
        }
        if (!db.objectStoreNames.contains(STORES.archive)) {
          db.createObjectStore(STORES.archive);
        }
      };
      request.onsuccess = () => {
        // Let this connection get out of the way if another tab needs a newer schema version.
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another open tab"));
    });
  }
  return dbPromise;
}

async function withStore<T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = run(store);
    tx.oncomplete = () => resolve(request ? (request.result as T) : (undefined as T));
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function getAll<T>(storeName: StoreName): Promise<T[]> {
  return withStore<T[]>(storeName, "readonly", (store) => store.getAll());
}

export function getValue<T>(storeName: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return withStore<T | undefined>(storeName, "readonly", (store) => store.get(key));
}

export function putValue<T>(storeName: StoreName, value: T, key?: IDBValidKey): Promise<void> {
  return withStore<void>(storeName, "readwrite", (store) => {
    store.put(value, key);
  });
}

export function countValues(storeName: StoreName): Promise<number> {
  return withStore<number>(storeName, "readonly", (store) => store.count());
}
