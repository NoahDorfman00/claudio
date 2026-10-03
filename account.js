// Accounts and access: every visitor is a Firebase anonymous user (that's what the free trial
// is counted against). Signing in with Google links the anonymous account, so trial usage carries over.
// Also owns the paywall, sign-in, API key and account dialogs.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
    getAuth, connectAuthEmulator, onAuthStateChanged, signInAnonymously, signOut,
    GoogleAuthProvider, signInWithPopup, linkWithPopup, signInWithCredential,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { persona } from './personas.js';

const firebaseConfig = {
    apiKey: 'AIzaSyDrKGKt6rdqPZnyD0cXYrDjbbVNhENqzhk',
    authDomain: 'claudio-13341.firebaseapp.com',
    projectId: 'claudio-13341',
    storageBucket: 'claudio-13341.firebasestorage.app',
    messagingSenderId: '573081656715',
    appId: '1:573081656715:web:99dc011cd5697594bc238e',
};

export const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
export const API_BASE = isLocal
    ? 'http://127.0.0.1:5001/claudio-13341/us-central1'
    : 'https://us-central1-claudio-13341.cloudfunctions.net';

const BROWSER_KEY_STORAGE = 'claudio.apiKey';
const BROWSER_KEY_DAYS = 7;

const app = initializeApp(firebaseConfig);
export const firebaseApp = app;
const auth = getAuth(app);
if (isLocal) connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });

// Latest /account response, or null while loading.
export let account = null;
const listeners = new Set();
let accessGranted = () => {};

export function onAccountChange(fn) {
    listeners.add(fn);
}

/** Called when the user unlocks more messages (key added, signed in to a paid account). */
export function onAccessGranted(fn) {
    accessGranted = fn;
}

let deleteAllChats = async () => {};
/** The app's handler for "Delete all my chats" (local copy, cloud copy, anything in flight). */
export function onDeleteAllChats(fn) {
    deleteAllChats = fn;
}

function emit() {
    listeners.forEach((fn) => fn(account));
}

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        account = null;
        emit();
        signInAnonymously(auth).catch((err) => console.error('Anonymous sign-in failed', err));
        return;
    }
    await refreshAccount();
});

// Resolves once there's a user (right after sign-out there briefly isn't one).
function signedInUser() {
    if (auth.currentUser) return Promise.resolve(auth.currentUser);
    return new Promise((resolve) => {
        const stop = onAuthStateChanged(auth, (user) => {
            if (user) {
                stop();
                resolve(user);
            }
        });
    });
}

export async function idToken() {
    return (await signedInUser()).getIdToken();
}

export async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${API_BASE}/api${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${await idToken()}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status}).`);
        err.code = data.code;
        throw err;
    }
    return data;
}

export async function refreshAccount() {
    try {
        account = await api('/account');
    } catch (err) {
        console.error('Could not load account', err);
    }
    emit();
    return account;
}

export function noteAllowanceUsed(percent) {
    if (account && typeof percent === 'number') {
        account.allowanceUsedPercent = percent;
        emit();
    }
}

// ---------- Browser-only API key ----------

export function browserKey() {
    try {
        const saved = JSON.parse(localStorage.getItem(BROWSER_KEY_STORAGE) || 'null');
        if (!saved) return null;
        if (Date.now() > saved.expiresAt) {
            localStorage.removeItem(BROWSER_KEY_STORAGE);
            return null;
        }
        return saved;
    } catch {
        return null;
    }
}

function setBrowserKey(key, hint) {
    const expiresAt = Date.now() + BROWSER_KEY_DAYS * 24 * 60 * 60 * 1000;
    try {
        localStorage.setItem(BROWSER_KEY_STORAGE, JSON.stringify({ key, hint, expiresAt }));
    } catch {
        throw new Error('This browser won\'t let us store anything. Sign in to save your key instead.');
    }
}

function clearBrowserKey() {
    try { localStorage.removeItem(BROWSER_KEY_STORAGE); } catch {}
}

// ---------- Status helpers ----------

export function isSubscriber() {
    return ['subscribed', 'pending_cancellation'].includes(account?.subscriptionStatus);
}

function planPrice() {
    const p = account?.plan;
    if (!p) return null;
    const whole = p.amount % 100 === 0;
    const amount = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: p.currency.toUpperCase(),
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: whole ? 0 : 2,
    }).format(p.amount / 100);
    return `${amount}/${p.interval}`;
}

/** Short status for the sidebar. */
export function statusLine() {
    if (!account) return 'Loading…';
    const bk = browserKey();
    if (isSubscriber()) {
        if (account.endsOn) return `Regular until ${account.endsOn}`;
        if (account.allowanceUsedPercent >= 100) return 'Regular · allowance used up';
        return `Regular · ${account.allowanceUsedPercent}% of allowance used`;
    }
    if (account.subscriptionStatus === 'past_due') return 'Payment problem';
    if (bk) return `Your key ${bk.hint}`;
    if (account.keyHint) return `Your key ${account.keyHint}`;
    return account.trialUsedUp ? 'Free tasting menu finished' : 'Free tasting menu';
}

export function displayName() {
    if (!account || account.isAnonymous) return 'Guest';
    return auth.currentUser?.displayName || account.email || 'Signed in';
}

// ---------- Dialog plumbing ----------

function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
}

function text(tag, className, content) {
    const node = el(tag, className);
    node.textContent = content;
    return node;
}

function button(label, className = '', onClick) {
    const b = text('button', className, label);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
}

let current = null;

function openDialog(build) {
    current?.close();
    const dialog = el('dialog', 'dialog');
    const close = () => {
        HTMLDialogElement.prototype.close.call(dialog);
        dialog.remove();
        if (current === dialog) current = null;
    };
    dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        close();
    });
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) close();
    });
    const x = el('button', 'dialog-x', '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', close);
    const body = el('div', 'dialog-body');
    dialog.append(x, body);
    build(body, close);
    document.body.appendChild(dialog);
    dialog.tabIndex = -1;
    dialog.showModal();
    dialog.focus(); // otherwise the close button opens with a focus ring
    current = dialog;
    dialog.close = close;
    return dialog;
}

function errorLine() {
    const n = el('p', 'dialog-error');
    n.hidden = true;
    n.show = (msg) => {
        n.textContent = msg;
        n.hidden = !msg;
    };
    return n;
}

async function busy(btn, fn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'One sec…';
    try {
        return await fn();
    } finally {
        btn.disabled = false;
        btn.textContent = label;
    }
}

// ---------- Paywall ----------

export function openPaywall(message) {
    openDialog((body, close) => {
        body.append(
            text('h2', 'dialog-title', 'Enjoyin\' yourself? Pull up a chair.'),
            text('p', 'dialog-sub', `${message || 'That\'s the end of the free tasting menu.'} Here's how to keep going:`),
        );

        const price = planPrice();
        const regular = el('div', 'option');
        regular.append(
            text('h3', '', 'Become a regular'),
            text('p', '', `Keep chatting with ${persona().name}${price ? ` for ${price}` : ''}. Your monthly allowance covers a few hundred messages for most people. Cancel anytime.`),
            button('Subscribe', 'btn primary', () => {
                close();
                startCheckout();
            }),
        );

        const byok = el('div', 'option');
        byok.append(
            text('h3', '', 'Bring your own API key'),
            text('p', '', 'Use your own Anthropic API key and pay Anthropic directly. Keep it in this browser for 7 days, or sign in to save it to your account, encrypted.'),
            button('Use my key', 'btn', () => {
                close();
                openKeyDialog();
            }),
        );

        const foot = el('div', 'dialog-foot');
        if (account?.isAnonymous) {
            foot.append(button('Already a regular? Sign in', 'link', () => {
                close();
                openSignIn();
            }));
        }
        foot.append(button('Not now', 'btn ghost', close));
        body.append(el('div', 'options'), foot);
        body.querySelector('.options').append(regular, byok);
    });
}

// ---------- Checkout ----------

export async function startCheckout() {
    await signedInUser();
    if (!account) await refreshAccount();
    if (account?.isAnonymous) {
        openSignIn({
            reason: 'Sign in first so your subscription has a home.',
            then: () => startCheckout(),
        });
        return;
    }
    try {
        const { url } = await api('/checkout', { method: 'POST' });
        goToStripe(url);
    } catch (err) {
        alertDialog('Couldn\'t start checkout', err.message);
    }
}

function goToStripe(url) {
    try { sessionStorage.setItem('claudio.awayAtStripe', '1'); } catch {}
    location.href = url;
}

async function openPortal(flow) {
    try {
        const { url } = await api('/portal', { method: 'POST', body: flow ? { flow } : undefined });
        goToStripe(url);
    } catch (err) {
        alertDialog('Couldn\'t open billing', err.message);
    }
}

/**
 * Cancel at period end, or undo that, then redraw the account view in the same dialog so it
 * doesn't blink closed and open again.
 */
async function changeSubscription(action, body, close) {
    try {
        const { url } = await api(`/subscription/${action}`, { method: 'POST' });
        if (url) return goToStripe(url); // key can't change subscriptions: Stripe's portal does it
        await refreshAccount();
        body.replaceChildren();
        renderAccount(body, close);
    } catch (err) {
        alertDialog('Couldn\'t update your subscription', err.message);
    }
}

function renderConfirmCancel(body, close, until) {
    body.replaceChildren(
        text('h2', 'dialog-title', 'Cancel your subscription?'),
        text('p', 'dialog-sub', `You'll stay a regular until ${until} and won't be charged again. You can change your mind anytime before then.`),
    );
    const confirm = button('Cancel subscription', 'btn primary');
    confirm.addEventListener('click', () => busy(confirm, () => changeSubscription('cancel', body, close)));
    const foot = el('div', 'dialog-foot');
    foot.append(
        button('Keep it', 'btn ghost', () => {
            body.replaceChildren();
            renderAccount(body, close);
        }),
        confirm,
    );
    body.append(foot);
}

function alertDialog(title, message) {
    openDialog((body, close) => {
        body.append(text('h2', 'dialog-title', title), text('p', 'dialog-sub', message));
        const foot = el('div', 'dialog-foot');
        foot.append(button('OK', 'btn primary', close));
        body.append(foot);
    });
}

// ---------- API key ----------

export function openKeyDialog({ error } = {}) {
    openDialog((body, close) => {
        const signedIn = account && !account.isAnonymous;
        const bk = browserKey();
        const saved = signedIn ? account.keyHint : null;
        const hasKey = Boolean(bk || saved);

        body.append(
            text('h2', 'dialog-title', hasKey ? 'Your API key' : 'Use your own API key'),
            el('p', 'dialog-sub', 'Pay Anthropic directly for what you use, with no monthly limit. Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">console.anthropic.com</a>.'),
        );

        if (hasKey) {
            const days = bk ? Math.max(1, Math.ceil((bk.expiresAt - Date.now()) / 86400000)) : 0;
            body.append(text('p', 'key-current', saved
                ? `Key ${saved} is saved to your account, encrypted.`
                : `Key ${bk.hint} is saved in this browser for ${days} more day${days === 1 ? '' : 's'}.`));
        }

        const input = el('input', 'field');
        input.type = 'password';
        input.placeholder = hasKey ? 'Paste a new key to replace it' : 'sk-ant-…';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', 'Anthropic API key');

        const choice = el('div', 'choices');
        choice.innerHTML = `
            <label class="choice"><input type="radio" name="where" value="account" ${signedIn ? 'checked' : ''}>
                <span><b>Save to my account</b><small>Encrypted, works on any device you sign in on.${signedIn ? '' : ' You\'ll sign in with Google first.'}</small></span></label>
            <label class="choice"><input type="radio" name="where" value="browser" ${signedIn ? '' : 'checked'}>
                <span><b>Keep in this browser for ${BROWSER_KEY_DAYS} days</b><small>Never stored on our server. Sent along with each message.</small></span></label>`;

        const err = errorLine();
        if (error) err.show(error);
        const save = button('Save key', 'btn primary');
        const foot = el('div', 'dialog-foot');
        if (hasKey) {
            foot.append(button('Remove key', 'btn ghost danger', async (e) => {
                await busy(e.currentTarget, async () => {
                    if (bk) clearBrowserKey();
                    if (saved) await api('/key', { method: 'POST', body: { apiKey: '' } });
                    await refreshAccount();
                });
                close();
            }));
        }
        foot.append(el('span', 'spacer'), button('Cancel', 'btn ghost', close), save);
        body.append(input, choice, err, foot);
        setTimeout(() => input.focus(), 50);

        const submit = () => busy(save, async () => {
            const key = input.value.trim();
            if (!key) return err.show('Paste your key first.');
            const where = choice.querySelector('input:checked').value;
            err.show('');
            try {
                if (where === 'browser') {
                    const { hint } = await api('/key/check', { method: 'POST', body: { apiKey: key } });
                    setBrowserKey(key, hint);
                    close();
                    emit();
                    accessGranted();
                } else if (account?.isAnonymous) {
                    close();
                    openSignIn({
                        reason: 'Sign in to save your key to your account.',
                        then: () => saveAccountKey(key),
                    });
                } else {
                    await saveAccountKey(key);
                    close();
                }
            } catch (e) {
                err.show(e.message);
            }
        });
        save.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submit();
        });
    });
}

async function saveAccountKey(key) {
    try {
        await api('/key', { method: 'POST', body: { apiKey: key } });
        clearBrowserKey();
        await refreshAccount();
        accessGranted();
    } catch (err) {
        openKeyDialog({ error: err.message });
        throw err;
    }
}

// ---------- Sign in ----------

function authErrorMessage(err) {
    switch (err.code) {
        case 'auth/popup-closed-by-user':
        case 'auth/cancelled-popup-request':
            return '';
        case 'auth/popup-blocked':
            return 'Your browser blocked the Google window. Allow pop-ups for this site and try again.';
        case 'auth/too-many-requests':
            return 'Too many tries. Wait a minute and try again.';
        default:
            return err.message || 'Something went wrong signing in.';
    }
}

async function afterSignIn(then) {
    await refreshAccount();
    if (isSubscriber() || account?.keyHint) accessGranted();
    if (then) await then();
}

const GOOGLE_ICON = '<svg viewBox="0 0 48 48" class="g"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.6 28.6A14.5 14.5 0 019.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 000 24c0 3.9.9 7.5 2.6 10.7l8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.2 0-11.5-4.2-13.4-9.9l-8 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';

/** Google sign-in popup. Must be called straight from a click so the popup isn't blocked. */
async function signInWithGoogle(then) {
    const provider = new GoogleAuthProvider();
    if (auth.currentUser?.isAnonymous) {
        try {
            // Linking keeps the guest's uid, so trial usage carries over.
            await linkWithPopup(auth.currentUser, provider);
        } catch (e) {
            if (e.code !== 'auth/credential-already-in-use') throw e;
            // Existing account: switch to it (the guest session's trial stays behind).
            await signInWithCredential(auth, GoogleAuthProvider.credentialFromError(e));
        }
    } else {
        await signInWithPopup(auth, provider);
    }
    await auth.currentUser.getIdToken(true); // fresh token: no longer anonymous
    await afterSignIn(then);
}

function googleButton(err, onBefore, then) {
    const google = el('button', 'btn google', `${GOOGLE_ICON}<span>Continue with Google</span>`);
    google.type = 'button';
    google.addEventListener('click', async () => {
        err.show('');
        try {
            const done = signInWithGoogle(then);
            onBefore?.();
            await done;
        } catch (e) {
            err.show(authErrorMessage(e));
        }
    });
    return google;
}

export function openSignIn({ reason, then } = {}) {
    openDialog((body, close) => {
        const err = errorLine();
        body.append(
            text('h2', 'dialog-title', 'Sign in'),
            text('p', 'dialog-sub', reason || 'Sign in to keep your chats on every device, save your API key, or become a regular.'),
            googleButton(err, null, async () => {
                close();
                if (then) await then();
            }),
            err,
        );
    });
}

// ---------- Account ----------

function meter(percent, label) {
    const m = el('div', 'meter');
    m.setAttribute('role', 'progressbar');
    m.setAttribute('aria-valuenow', String(percent));
    m.setAttribute('aria-valuemin', '0');
    m.setAttribute('aria-valuemax', '100');
    m.setAttribute('aria-label', label);
    const fill = el('span');
    fill.style.width = `${percent}%`;
    m.appendChild(fill);
    return m;
}

/** A settings-style row: title, optional subtitle, chevron. */
function row(title, subtitle, onClick) {
    const b = el('button', 'acct-row', '<span class="acct-row-text"><b></b><small></small></span><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>');
    b.type = 'button';
    b.querySelector('b').textContent = title;
    if (subtitle) b.querySelector('small').textContent = subtitle;
    else b.querySelector('small').remove();
    b.addEventListener('click', onClick);
    return b;
}

export function openAccount() {
    openDialog(renderAccount);
}

function renderAccount(body, close) {
    const a = account;
    if (!a) {
        body.append(text('h2', 'dialog-title', 'One sec…'), text('p', 'dialog-sub', 'Still loading your account.'));
        return;
    }
    const signedIn = !a.isAnonymous;
    const subscribed = isSubscriber();
    const price = planPrice();

    body.append(text('h2', 'dialog-title', signedIn ? displayName() : 'You\'re a guest'));
    if (signedIn && a.email && displayName() !== a.email) body.append(text('p', 'dialog-sub', a.email));

    // Status
    const status = el('div', 'acct-status');
    if (subscribed && a.subscriptionStatus === 'pending_cancellation') {
        status.append(
            text('p', 'acct-status-title', `Regular until ${a.endsOn || a.allowanceResets}`),
            meter(a.allowanceUsedPercent, 'Allowance used'),
            text('p', 'muted', `${a.allowanceUsedPercent}% of your allowance used · you won't be charged again`),
        );
    } else if (subscribed) {
        status.append(
            text('p', 'acct-status-title', 'You\'re a regular. Grazie!'),
            meter(a.allowanceUsedPercent, 'Monthly allowance used'),
            text('p', 'muted', `${a.allowanceUsedPercent}% of this month's allowance used · resets ${a.allowanceResets}`),
        );
    } else if (a.subscriptionStatus === 'past_due') {
        status.append(
            text('p', 'acct-status-title', 'Your last payment didn\'t go through'),
            text('p', 'muted', 'Update your card to keep chatting.'),
            button('Update payment', 'btn primary', () => openPortal('payment')),
        );
    } else if (browserKey() || a.keyHint) {
        status.append(
            text('p', 'acct-status-title', 'Using your own API key'),
            text('p', 'muted', 'No limits here. Usage is billed to your Anthropic account.'),
        );
    } else {
        status.append(
            text('p', 'acct-status-title', 'Free tasting menu'),
            text('p', 'muted', a.trialUsedUp
                ? 'You\'ve finished the free tasting menu. Become a regular or use your own API key to keep going.'
                : 'Chat away, it\'s on the house. When the tasting menu\'s done, you can become a regular to keep going.'),
        );
    }
    body.append(status);

    // Main action for guests: sign in right here.
    if (!signedIn) {
        const err = errorLine();
        body.append(
            googleButton(err, null, async () => close()),
            text('p', 'acct-hint', 'Sign in to keep your chats on every device, save your key, or become a regular.'),
            err,
        );
    }

    // Everything else is a quiet row.
    const rows = el('div', 'acct-rows');
    if (a.subscriptionStatus === 'pending_cancellation') {
        rows.append(
            row('Keep my subscription', 'Undo the cancellation', async (e) => {
                const r = e.currentTarget;
                r.disabled = true;
                r.querySelector('small').textContent = 'One sec…';
                await changeSubscription('resume', body, close);
            }),
            row('Manage billing', 'Your card and invoices, on Stripe', () => openPortal()),
        );
    } else if (subscribed) {
        rows.append(
            row('Manage billing', 'Your card and invoices, on Stripe', () => openPortal()),
            row('Cancel subscription', `You'll keep access until ${a.allowanceResets}`, () => {
                renderConfirmCancel(body, close, a.allowanceResets);
            }),
        );
    } else if (a.subscriptionStatus === 'past_due') {
        rows.append(row('Manage billing', 'Your card and invoices, on Stripe', () => openPortal()));
    } else {
        rows.append(row('Become a regular', price ? `${price} · keep chatting all month` : 'Keep chatting all month', () => {
            close();
            startCheckout();
        }));
    }
    const bk = browserKey();
    const keyHint = signedIn ? a.keyHint : null;
    rows.append(row(
        keyHint || bk ? `Your API key ${keyHint || bk.hint}` : 'Use your own API key',
        keyHint ? 'Saved to your account' : bk ? 'Saved in this browser' : 'Pay Anthropic directly, no monthly limit',
        () => {
            close();
            openKeyDialog();
        },
    ));
    body.append(rows);
    body.append(text('p', 'acct-hint', signedIn
        ? 'Your chats are saved to your account, so they follow you to any device you sign in on.'
        : 'Your chats are saved in this browser only. Sign in to keep them with your account.'));

    const foot = el('div', 'dialog-foot');
    foot.append(button('Delete all chats', 'btn ghost danger', () => renderConfirmDeleteAll(body, close)));
    foot.append(el('span', 'spacer'));
    if (signedIn) {
        foot.append(button('Sign out', 'btn ghost', async () => {
            close();
            await signOut(auth); // onAuthStateChanged starts a fresh guest session
        }));
    }
    body.append(foot);
}

function renderConfirmDeleteAll(body, close) {
    const signedIn = account && !account.isAnonymous;
    body.replaceChildren(
        text('h2', 'dialog-title', 'Delete all your chats?'),
        text('p', 'dialog-sub', signedIn
            ? 'This deletes every conversation from your account and from every device you\'re signed in on. It can\'t be undone.'
            : 'This deletes every conversation saved in this browser. It can\'t be undone.'),
    );
    const err = errorLine();
    const confirm = button('Delete everything', 'btn primary');
    confirm.addEventListener('click', () => busy(confirm, async () => {
        try {
            await deleteAllChats();
            close();
        } catch (e) {
            err.show(e.message || 'Couldn\'t delete everything. Try again.');
        }
    }));
    const foot = el('div', 'dialog-foot');
    foot.append(
        button('Cancel', 'btn ghost', () => {
            body.replaceChildren();
            renderAccount(body, close);
        }),
        confirm,
    );
    body.append(err, foot);
}

// ---------- Returning from Stripe ----------

// Re-check the account until it changes (the webhook can trail the redirect by a few seconds),
// or just once if nothing is expected to change.
let polling = false;
async function refreshUntilChanged(tries) {
    if (polling) return;
    polling = true;
    try {
        const before = JSON.stringify([account?.subscriptionStatus, account?.endsOn, account?.keyHint]);
        for (let i = 0; i < tries; i++) {
            if (i) await new Promise((r) => setTimeout(r, 1500));
            await refreshAccount();
            if (JSON.stringify([account?.subscriptionStatus, account?.endsOn, account?.keyHint]) !== before) break;
        }
    } finally {
        polling = false;
    }
}

function cameBackFromStripe() {
    try {
        const away = sessionStorage.getItem('claudio.awayAtStripe');
        sessionStorage.removeItem('claudio.awayAtStripe');
        return Boolean(away);
    } catch {
        return false;
    }
}

// Back button from Stripe restores this page from the browser's cache without rerunning
// anything, so refresh the account when that happens, and when the tab comes back into view.
window.addEventListener('pageshow', (e) => {
    if (e.persisted) refreshUntilChanged(cameBackFromStripe() ? 6 : 1);
});
let lastVisibleRefresh = Date.now();
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastVisibleRefresh < 30000) return;
    lastVisibleRefresh = Date.now();
    refreshUntilChanged(1);
});

// Back from the billing portal: the webhook may land a moment after the redirect, so look a
// few times for the change.
async function handleBillingReturn(params) {
    params.delete('billing');
    cameBackFromStripe();
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
    await signedInUser();
    await refreshUntilChanged(6);
}

export async function handleCheckoutReturn(toast) {
    const params = new URLSearchParams(location.search);
    const result = params.get('checkout');
    if (params.has('billing')) return handleBillingReturn(params);
    if (!result) return;
    params.delete('checkout');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
    if (result !== 'success') return;

    toast('Welcome to the family! Setting up your table…');
    await signedInUser();
    // The webhook usually lands within a few seconds of the redirect.
    for (let i = 0; i < 10; i++) {
        await refreshAccount();
        if (isSubscriber()) {
            toast('You\'re a regular now. Mangia!');
            accessGranted();
            return;
        }
        await new Promise((r) => setTimeout(r, 1500));
    }
    toast('Payment went through. Your plan will show up in a moment.');
}
