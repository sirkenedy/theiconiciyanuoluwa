// Device-bound encrypted storage for Career Coach (career-mode.md §4.2). Everything a visitor creates lives only here,
// in IndexedDB, encrypted with an AES-GCM 256 key generated as non-extractable: this site can use it in this browser,
// but no script (ours included) can export it. Each record is bound to its store and id (AES-GCM additional data),
// so ciphertext can't be swapped between records.

const DB_NAME = 'career-coach';
export const STORES = ['conversations', 'messages', 'profile', 'documents', 'savedJobs', 'meta'] as const;
export type Store = (typeof STORES)[number];
export const RETENTION_MS = 90 * 24 * 3600_000;

type Row = { id: string; conv?: string; updatedAt: number; iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer };

const enc = new TextEncoder();
const dec = new TextDecoder();

const done = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const committed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

let dbPromise: Promise<IDBDatabase> | null = null;

/** The one database: `keys` holds CryptoKey objects (structured clone keeps them non-extractable); the rest is ciphertext. */
export function openDb(): Promise<IDBDatabase> {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('keys');
      for (const name of STORES) {
        const s = db.createObjectStore(name, { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
        if (name === 'messages') s.createIndex('conv', 'conv');
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('vault blocked'));
  }));
}

export async function getKey<T>(name: string): Promise<T | undefined> {
  const db = await openDb();
  return done(db.transaction('keys').objectStore('keys').get(name)) as Promise<T | undefined>;
}

export async function putKey(name: string, value: unknown) {
  const db = await openDb();
  const tx = db.transaction('keys', 'readwrite');
  tx.objectStore('keys').put(value, name);
  return committed(tx);
}

export class Vault {
  constructor(
    private db: IDBDatabase,
    private key: CryptoKey,
  ) {}

  private async seal(store: Store, id: string, value: unknown) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${store}:${id}`) }, this.key, enc.encode(JSON.stringify(value)));
    return { iv, ct };
  }

  private async open<T>(store: Store, row: Row): Promise<T | undefined> {
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv, additionalData: enc.encode(`${store}:${row.id}`) }, this.key, row.ct);
      return JSON.parse(dec.decode(plain)) as T;
    } catch {
      return undefined; // tampered, or written under a key that no longer exists
    }
  }

  async put(store: Store, id: string, value: unknown, conv?: string) {
    const row: Row = { id, updatedAt: Date.now(), ...(conv ? { conv } : {}), ...(await this.seal(store, id, value)) };
    const tx = this.db.transaction(store, 'readwrite');
    tx.objectStore(store).put(row);
    return committed(tx);
  }

  async get<T>(store: Store, id: string): Promise<T | undefined> {
    const row = (await done(this.db.transaction(store).objectStore(store).get(id))) as Row | undefined;
    return row ? this.open<T>(store, row) : undefined;
  }

  async list<T>(store: Store): Promise<T[]> {
    const rows = (await done(this.db.transaction(store).objectStore(store).getAll())) as Row[];
    return (await Promise.all(rows.map((r) => this.open<T>(store, r)))).filter((v): v is Awaited<T> => v !== undefined) as T[];
  }

  async byConversation<T>(conv: string): Promise<T[]> {
    const rows = (await done(this.db.transaction('messages').objectStore('messages').index('conv').getAll(conv))) as Row[];
    return (await Promise.all(rows.map((r) => this.open<T>('messages', r)))).filter((v): v is Awaited<T> => v !== undefined) as T[];
  }

  async removeRecord(store: Store, id: string) {
    const tx = this.db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    return committed(tx);
  }

  async removeConversation(conv: string) {
    const tx = this.db.transaction(['conversations', 'messages'], 'readwrite');
    tx.objectStore('conversations').delete(conv);
    const msgs = tx.objectStore('messages');
    for (const key of await done(msgs.index('conv').getAllKeys(conv))) msgs.delete(key);
    return committed(tx);
  }

  /** Retention: drop anything not updated in 90 days. */
  async sweep(now = Date.now()) {
    const tx = this.db.transaction([...STORES], 'readwrite');
    const range = IDBKeyRange.upperBound(now - RETENTION_MS);
    for (const name of STORES) {
      const store = tx.objectStore(name);
      for (const key of await done(store.index('updatedAt').getAllKeys(range))) store.delete(key);
    }
    return committed(tx);
  }
}

let vaultPromise: Promise<Vault> | null = null;

export function openVault(): Promise<Vault> {
  return (vaultPromise ??= (async () => {
    const db = await openDb();
    let key = await getKey<CryptoKey>('vault');
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await putKey('vault', key);
    }
    const vault = new Vault(db, key);
    await vault.sweep();
    return vault;
  })());
}

/** "Delete everything on this device": every store and both keys, at once. The next visit is a brand-new device. */
/** "Delete everything": chats, résumé, documents and saved jobs go; the keys stay, so this is still the same device
 * (today's limits can't be reset by deleting). */
export async function clearData() {
  const db = await openDb();
  const tx = db.transaction([...STORES], 'readwrite');
  for (const name of STORES) tx.objectStore(name).clear();
  await committed(tx);
}

export async function wipeVault() {
  if (dbPromise) (await dbPromise).close();
  dbPromise = vaultPromise = null;
  await done(indexedDB.deleteDatabase(DB_NAME));
}

/** Ask the browser not to evict the vault under storage pressure (called after the first upload). */
export const persistStorage = async () => (await navigator.storage?.persist?.()) ?? false;
export const isPersisted = async () => (await navigator.storage?.persisted?.()) ?? false;
