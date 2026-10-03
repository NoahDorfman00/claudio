// Conversations in this browser's IndexedDB. Assistant turns are stored as the raw content
// blocks the API returned (thinking, search results, citations), which get big fast; IndexedDB
// has room for that where localStorage doesn't. For signed-in users this is a cache of what
// sync.js keeps in Firestore. Sync bookkeeping (which account a chat belongs to, which
// messages are uploaded) lives in its own store so saving a chat never clobbers it.

const DB_NAME = 'claudio';
const CHATS = 'chats';
const SYNC = 'sync';

let dbPromise = null;
let memory = null; // fallback when IndexedDB is unavailable (private mode, blocked storage)

function open() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 2);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(CHATS)) {
                    db.createObjectStore(CHATS, { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
                }
                if (!db.objectStoreNames.contains(SYNC)) db.createObjectStore(SYNC, { keyPath: 'id' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }).catch((err) => {
            console.warn('IndexedDB unavailable, chats will not persist:', err);
            memory = { [CHATS]: new Map(), [SYNC]: new Map() };
            return null;
        });
    }
    return dbPromise;
}

/** Run one request against an object store (or the in-memory fallback, a Map). */
async function run(storeName, mode, idb, mem) {
    const db = await open();
    if (!db) return mem(memory[storeName]);
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const req = idb(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const getAll = (name) => run(name, 'readonly', (s) => s.getAll(), (m) => [...m.values()].map(clone));
const get = (name, id) => run(name, 'readonly', (s) => s.get(id), (m) => clone(m.get(id)));
const put = (name, value) => run(name, 'readwrite', (s) => s.put(value), (m) => { m.set(value.id, clone(value)); });
const del = (name, id) => run(name, 'readwrite', (s) => s.delete(id), (m) => { m.delete(id); });

export async function allChats() {
    return (await getAll(CHATS)) || [];
}

export async function listChats() {
    return (await allChats())
        .map(({ id, title, updatedAt, persona }) => ({ id, title, updatedAt, persona }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getChat(id) {
    return (await get(CHATS, id)) || null;
}

export function putChat(chat) {
    return put(CHATS, chat);
}

export function deleteChat(id) {
    return del(CHATS, id);
}

/** { id, uid, ids }: the account a chat is synced to and the message ids already uploaded. */
export async function getSync(id) {
    return (await get(SYNC, id)) || null;
}

export async function allSync() {
    return (await getAll(SYNC)) || [];
}

export function putSync(state) {
    return put(SYNC, state);
}

export function deleteSync(id) {
    return del(SYNC, id);
}
