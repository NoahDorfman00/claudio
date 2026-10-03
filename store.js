// Conversations live in this browser's IndexedDB. Assistant turns are stored as the raw
// content blocks the API returned (thinking, search results, citations), which get big
// fast; IndexedDB has room for that where localStorage doesn't.

const DB_NAME = 'claudio';
const STORE = 'chats';

let dbPromise = null;
let memory = null; // fallback when IndexedDB is unavailable (private mode, blocked storage)

function open() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
                s.createIndex('updatedAt', 'updatedAt');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }).catch((err) => {
            console.warn('IndexedDB unavailable, chats will not persist:', err);
            memory = new Map();
            return null;
        });
    }
    return dbPromise;
}

async function run(mode, fn) {
    const db = await open();
    if (!db) return fn(null);
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export async function listChats() {
    const all = await run('readonly', (s) => (s ? s.getAll() : null)) ?? [...(memory?.values() || [])];
    return all
        .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getChat(id) {
    const db = await open();
    if (!db) return memory.get(id) ? structuredClone(memory.get(id)) : null;
    return run('readonly', (s) => s.get(id));
}

export async function putChat(chat) {
    const db = await open();
    if (!db) {
        memory.set(chat.id, structuredClone(chat));
        return;
    }
    return run('readwrite', (s) => s.put(chat));
}

export async function deleteChat(id) {
    const db = await open();
    if (!db) {
        memory.delete(id);
        return;
    }
    return run('readwrite', (s) => s.delete(id));
}
