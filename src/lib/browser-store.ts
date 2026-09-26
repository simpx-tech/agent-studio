import type { BrowserWorkspaceStore } from './browser-workspace';

const databaseName = 'agent-studio';
const storeName = 'private-workspaces';
// Safari can drop the IndexedDB connection of a page left in the background.
const droppedConnection = new Set(['InvalidStateError', 'UnknownError']);

let connection: Promise<IDBDatabase> | undefined;

function connect(): Promise<IDBDatabase> {
  if (connection) return connection;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined')
      throw new Error('This browser cannot store a local copy of your workspace.');
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const forget = () => {
    if (connection === opening) connection = undefined;
  };
  connection = opening;
  opening.then((database) => {
    database.onclose = forget;
    // Let a newer release upgrade the database.
    database.onversionchange = () => {
      database.close();
      forget();
    };
  }, forget);
  return opening;
}

// Retries once on a new connection when the browser dropped the previous one.
async function connected<T>(work: (database: IDBDatabase) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const opening = connect();
    const database = await opening;
    try {
      return await work(database);
    } catch (error) {
      if (attempt || !(error instanceof DOMException) || !droppedConnection.has(error.name))
        throw error;
      if (connection === opening) connection = undefined;
    }
  }
}

// Creates the transaction synchronously, so callers can check their session just before.
function transaction(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, fail: (error: unknown) => void) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const request = database.transaction(storeName, mode);
    let failure: unknown;
    request.oncomplete = () => resolve();
    request.onabort = () =>
      reject(
        failure ??
          request.error ??
          new DOMException('The browser storage request was aborted.', 'AbortError'),
      );
    work(request.objectStore(storeName), (error) => {
      failure = error;
      request.abort();
    });
  });
}

export const browserWorkspaceStore: BrowserWorkspaceStore = {
  get: (keys) =>
    connected(async (database) => {
      let requests: IDBRequest[] = [];
      await transaction(database, 'readonly', (store) => {
        requests = keys.map((key) => store.get(key));
      });
      return requests.map((request) => request.result);
    }),
  put: (entries, current = () => true) =>
    connected(async (database) => {
      if (!current()) return false;
      await transaction(database, 'readwrite', (store) => {
        for (const [key, value] of entries) store.put(value, key);
      });
      return true;
    }),
  update: (change, current = () => true) =>
    connected(async (database) => {
      if (!current()) return;
      await transaction(database, 'readwrite', (store, fail) => {
        const request = store.getAllKeys();
        request.onsuccess = () => {
          try {
            const { put = [], remove = [] } = change(
              request.result.filter((key): key is string => typeof key === 'string'),
            );
            for (const key of remove) store.delete(key);
            for (const [key, value] of put) store.put(value, key);
          } catch (error) {
            fail(error);
          }
        };
      });
    }),
};
