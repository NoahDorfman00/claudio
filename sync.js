// Keeps signed-in users' chats in Firestore so they follow the account across devices. The
// browser's IndexedDB stays the working copy (fast, works offline); this mirrors it up and
// pulls other devices' changes down.
//
//   users/{uid}/chats/{chatId}                  { title, persona, createdAt, updatedAt, count }
//   users/{uid}/chats/{chatId}/messages/{msgId} { index, json } or { index, blob: true }
//   Storage: users/{uid}/chats/{chatId}/{msgId}.json   messages too big for a Firestore doc
//
// Messages are append-only except for edit/regenerate, which cut the tail; a push uploads the
// messages the cloud doesn't have and deletes the ones that were cut.

import {
    getFirestore, connectFirestoreEmulator, collection, doc, setDoc, deleteDoc, getDocs,
    onSnapshot, query, orderBy,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
    getStorage, connectStorageEmulator, ref, uploadString, getBytes, deleteObject,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { firebaseApp, isLocal } from './account.js';
import * as store from './store.js';

const db = getFirestore(firebaseApp);
const storage = getStorage(firebaseApp);
if (isLocal) {
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    connectStorageEmulator(storage, '127.0.0.1', 9199);
}

// JSON this long or longer goes to Storage instead (Firestore documents max out at 1 MiB).
const INLINE_LIMIT = 700_000;

let uid = null;
let unsubscribe = null;
let pullChain = Promise.resolve();
const pushChains = new Map();
let notify = () => {};
let isStreaming = () => false;

const chatsCol = () => collection(db, 'users', uid, 'chats');
const chatDoc = (id) => doc(db, 'users', uid, 'chats', id);
const messagesCol = (id) => collection(db, 'users', uid, 'chats', id, 'messages');
const messageDoc = (chatId, msgId) => doc(db, 'users', uid, 'chats', chatId, 'messages', msgId);
const blobRef = (chatId, msgId) => ref(storage, `users/${uid}/chats/${chatId}/${msgId}.json`);

/** onChange(ids): chats changed from the cloud; isStreaming(id): leave chats with a reply in flight alone. */
export function configure(options) {
    notify = options.onChange || notify;
    isStreaming = options.isStreaming || isStreaming;
}

export function syncing() {
    return Boolean(uid);
}

function newId() {
    return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

// ---------- Up ----------

/** Queue an upload of this chat's current state. Pushes for one chat run one at a time. */
export function push(chatId) {
    if (!uid) return Promise.resolve();
    const forUid = uid;
    const prev = pushChains.get(chatId) || Promise.resolve();
    const next = prev
        .then(() => (uid === forUid ? pushNow(chatId) : null))
        .catch((err) => console.error('[sync] push failed', chatId, err));
    pushChains.set(chatId, next);
    return next;
}

async function pushNow(chatId) {
    let chat = await store.getChat(chatId);
    if (!chat) return;

    // Older chats predate message ids; give them ids once, before anything is uploaded.
    if (chat.messages.some((m) => !m.id)) {
        chat.messages.forEach((m) => { m.id ||= newId(); });
        await store.putChat(chat);
    }

    const state = await store.getSync(chatId);
    const uploaded = state?.uid === uid ? state.ids : [];
    const localIds = chat.messages.map((m) => m.id);

    for (const id of uploaded) {
        if (localIds.includes(id)) continue;
        await deleteDoc(messageDoc(chatId, id));
        await deleteObject(blobRef(chatId, id)).catch(() => {});
    }

    for (let i = 0; i < chat.messages.length; i++) {
        const { id, ...message } = chat.messages[i];
        if (uploaded.includes(id)) continue;
        const json = JSON.stringify(message);
        if (json.length >= INLINE_LIMIT) {
            await uploadString(blobRef(chatId, id), json, 'raw', { contentType: 'application/json' });
            await setDoc(messageDoc(chatId, id), { index: i, blob: true });
        } else {
            await setDoc(messageDoc(chatId, id), { index: i, json });
        }
    }

    await setDoc(chatDoc(chatId), {
        title: chat.title || 'Untitled',
        persona: chat.persona || 'claudio',
        createdAt: chat.createdAt || Date.now(),
        updatedAt: chat.updatedAt || Date.now(),
        count: localIds.length,
    });
    await store.putSync({ id: chatId, uid, ids: localIds });
}

// ---------- Down ----------

async function download(chatId, meta) {
    const snap = await getDocs(query(messagesCol(chatId), orderBy('index')));
    const messages = [];
    for (const d of snap.docs) {
        const data = d.data();
        const json = data.blob ? new TextDecoder().decode(await getBytes(blobRef(chatId, d.id))) : data.json;
        messages.push({ id: d.id, ...JSON.parse(json) });
    }
    // The other device writes messages before the chat doc, so a short list means it's mid-upload;
    // the next snapshot will bring the rest.
    if (messages.length < (meta.count || 0)) return false;
    await store.putChat({
        id: chatId,
        title: meta.title,
        persona: meta.persona || 'claudio',
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        messages,
    });
    await store.putSync({ id: chatId, uid, ids: messages.map((m) => m.id) });
    return true;
}

async function applySnapshot(snap, forUid) {
    if (uid !== forUid) return;
    const remote = new Map(snap.docs.map((d) => [d.id, d.data()]));
    const changed = [];

    for (const [id, meta] of remote) {
        if (isStreaming(id)) continue;
        const local = await store.getChat(id);
        if (local && (local.updatedAt || 0) >= (meta.updatedAt || 0)) continue;
        try {
            if (await download(id, meta)) changed.push(id);
        } catch (err) {
            console.error('[sync] download failed', id, err);
        }
    }

    // Synced here before but gone from the cloud: deleted on another device.
    if (!snap.metadata.fromCache) {
        for (const state of await store.allSync()) {
            if (state.uid !== uid || remote.has(state.id) || isStreaming(state.id)) continue;
            if (pushChains.has(state.id)) await pushChains.get(state.id);
            if ((await store.getSync(state.id))?.uid !== uid) continue;
            await store.deleteChat(state.id);
            await store.deleteSync(state.id);
            changed.push(state.id);
        }
    }

    if (changed.length) notify(changed);
}

// ---------- Lifecycle ----------

/** Signed in: adopt this browser's guest chats into the account, then follow the cloud. */
export async function start(newUid) {
    if (uid === newUid) return;
    stopListening();
    uid = newUid;

    const states = new Map((await store.allSync()).map((s) => [s.id, s]));
    for (const chat of await store.allChats()) {
        const state = states.get(chat.id);
        if (state && state.uid !== uid) {
            // Left over from a different account (signed out with the tab closed): not ours.
            await store.deleteChat(chat.id);
            await store.deleteSync(chat.id);
        } else {
            push(chat.id);
        }
    }

    const forUid = uid;
    unsubscribe = onSnapshot(chatsCol(), (snap) => {
        pullChain = pullChain.then(() => applySnapshot(snap, forUid)).catch((err) => console.error('[sync] pull failed', err));
    }, (err) => console.error('[sync] listener failed', err));
    notify([]);
}

function stopListening() {
    unsubscribe?.();
    unsubscribe = null;
}

/** Signed out: stop following the cloud and drop the synced chats from this browser. */
export async function stop() {
    stopListening();
    uid = null;
    for (const state of await store.allSync()) {
        await store.deleteChat(state.id);
        await store.deleteSync(state.id);
    }
    notify([]);
}

/** Delete a chat from the cloud (the caller removes the local copy). */
export async function remove(chatId) {
    const state = await store.getSync(chatId);
    await store.deleteSync(chatId);
    if (!uid || state?.uid !== uid) return;
    await pushChains.get(chatId);
    try {
        await deleteDoc(chatDoc(chatId));
        const msgs = await getDocs(messagesCol(chatId));
        await Promise.all(msgs.docs.map(async (d) => {
            if (d.data().blob) await deleteObject(blobRef(chatId, d.id)).catch(() => {});
            await deleteDoc(d.ref);
        }));
    } catch (err) {
        console.error('[sync] remote delete failed', chatId, err);
    }
}

/** Delete every chat in the account's cloud copy. */
export async function removeAll() {
    if (!uid) return;
    const snap = await getDocs(chatsCol());
    for (const d of snap.docs) {
        await store.putSync({ id: d.id, uid, ids: [] });
        await remove(d.id);
    }
}
