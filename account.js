// Accounts and access: every visitor is a Firebase anonymous user (that's what the free trial
// is counted against). Signing in with Google links the anonymous account, so trial usage carries over.
// Also owns the paywall, sign-in, API key and account dialogs.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
    getAuth, connectAuthEmulator, onAuthStateChanged, signInAnonymously, signOut,
    GoogleAuthProvider, signInWithPopup, linkWithPopup, signInWithCredential,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

const firebaseConfig = {
    apiKey: 'AIzaSyDrKGKt6rdqPZnyD0cXYrDjbbVNhENqzhk',
    authDomain: 'claudio-13341.firebaseapp.com',
    projectId: 'claudio-13341',
    storageBucket: 'claudio-13341.firebasestorage.app',
    messagingSenderId: '573081656715',
    appId: '1:573081656715:web:99dc011cd5697594bc238e',
};

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
export const API_BASE = isLocal
    ? 'http://127.0.0.1:5001/claudio-13341/us-central1'
    : 'https://us-central1-claudio-13341.cloudfunctions.net';

const BROWSER_KEY_STORAGE = 'claudio.apiKey';
const BROWSER_KEY_DAYS = 7;

const app = initializeApp(firebaseConfig);
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

export function noteFreeMessagesLeft(left) {
    if (account && typeof left === 'number') {
        account.freeMessagesLeft = left;
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
        throw new Error('This browser won\'t let Claudio store anything. Sign in to save your key instead.');
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
    const amount = new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency.toUpperCase() })
        .format(p.amount / 100);
    return `${amount}/${p.interval}`;
}

/** Short status for the sidebar. */
export function statusLine() {
    if (!account) return 'Loading…';
    const bk = browserKey();
    if (isSubscriber()) {
        if (account.allowanceUsedPercent >= 100) return 'Regular · allowance used up';
        return `Regular · ${account.allowanceUsedPercent}% of allowance used`;
    }
    if (account.subscriptionStatus === 'past_due') return 'Payment problem';
    if (bk) return `Your key ${bk.hint}`;
    if (account.keyHint) return `Your key ${account.keyHint}`;
    const left = account.freeMessagesLeft;
    return left > 0 ? `${left} free message${left === 1 ? '' : 's'} left` : 'Free tasting menu used up';
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
    dialog.showModal();
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
            text('p', '', `Keep chatting with Claudio${price ? ` for ${price}` : ''}. Your monthly allowance covers a few hundred messages for most people. Cancel anytime.`),
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
        location.href = url;
    } catch (err) {
        alertDialog('Couldn\'t start checkout', err.message);
    }
}

async function openPortal() {
    try {
        const { url } = await api('/portal', { method: 'POST' });
        location.href = url;
    } catch (err) {
        alertDialog('Couldn\'t open billing', err.message);
    }
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
        body.append(
            text('h2', 'dialog-title', 'Bring your own API key'),
            el('p', 'dialog-sub', 'Get one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">console.anthropic.com</a>. Claudio uses it only to answer you; your usage is billed to your Anthropic account.'),
        );

        const input = el('input', 'field');
        input.type = 'password';
        input.placeholder = 'sk-ant-…';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', 'Anthropic API key');

        const signedIn = account && !account.isAnonymous;
        const choice = el('div', 'choices');
        choice.innerHTML = `
            <label class="choice"><input type="radio" name="where" value="account" ${signedIn ? 'checked' : ''}>
                <span><b>Save to my account</b><small>Encrypted, works on any device you sign in on.${signedIn ? '' : ' You\'ll sign in first.'}</small></span></label>
            <label class="choice"><input type="radio" name="where" value="browser" ${signedIn ? '' : 'checked'}>
                <span><b>Keep in this browser for ${BROWSER_KEY_DAYS} days</b><small>Never stored on Claudio's server. Sent along with each message.</small></span></label>`;

        const err = errorLine();
        if (error) err.show(error);
        const save = button('Save key', 'btn primary');
        const foot = el('div', 'dialog-foot');
        foot.append(button('Cancel', 'btn ghost', close), save);
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
    if (then) await then();
    else if (isSubscriber() || account?.keyHint) accessGranted();
}

const GOOGLE_ICON = '<svg viewBox="0 0 48 48" class="g"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.6 28.6A14.5 14.5 0 019.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 000 24c0 3.9.9 7.5 2.6 10.7l8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.2 0-11.5-4.2-13.4-9.9l-8 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';

export function openSignIn({ reason, then } = {}) {
    openDialog((body, close) => {
        const google = el('button', 'btn google', `${GOOGLE_ICON}<span>Continue with Google</span>`);
        google.type = 'button';
        const err = errorLine();
        body.append(
            text('h2', 'dialog-title', 'Sign in'),
            text('p', 'dialog-sub', reason || 'Sign in to save your API key or become a regular. Your chats stay on this device.'),
            google,
            err,
        );

        google.addEventListener('click', async () => {
            err.show('');
            const provider = new GoogleAuthProvider();
            try {
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
                close();
                await auth.currentUser.getIdToken(true); // fresh token: no longer anonymous
                await afterSignIn(then);
            } catch (e) {
                err.show(authErrorMessage(e));
            }
        });
    });
}

// ---------- Account ----------

export function openAccount() {
    openDialog((body, close) => {
        const a = account;
        const signedIn = a && !a.isAnonymous;
        body.append(text('h2', 'dialog-title', signedIn ? displayName() : 'You\'re a guest'));
        if (signedIn && a.email && displayName() !== a.email) body.append(text('p', 'dialog-sub', a.email));
        if (!signedIn) body.append(text('p', 'dialog-sub', 'Sign in to save your API key or become a regular.'));

        // Plan
        const plan = el('section', 'acct-section');
        plan.append(text('h3', '', 'Plan'));
        const price = planPrice();
        if (a?.subscriptionStatus === 'subscribed' || a?.subscriptionStatus === 'pending_cancellation') {
            plan.append(text('p', '', a.subscriptionStatus === 'pending_cancellation'
                ? 'You\'re a regular until the end of this billing period.'
                : 'You\'re a regular. Grazie!'));
            const meter = el('div', 'meter');
            meter.setAttribute('role', 'progressbar');
            meter.setAttribute('aria-valuenow', String(a.allowanceUsedPercent));
            meter.setAttribute('aria-valuemin', '0');
            meter.setAttribute('aria-valuemax', '100');
            meter.setAttribute('aria-label', 'Monthly allowance used');
            const fill = el('span');
            fill.style.width = `${a.allowanceUsedPercent}%`;
            meter.appendChild(fill);
            plan.append(meter, text('p', 'muted', `${a.allowanceUsedPercent}% of this month's allowance used. Resets ${a.allowanceResets}.`));
            plan.append(button('Manage billing', 'btn', openPortal));
        } else if (a?.subscriptionStatus === 'past_due') {
            plan.append(text('p', '', 'Your last payment didn\'t go through. Update your card to keep chatting.'));
            plan.append(button('Update payment', 'btn primary', openPortal));
        } else {
            plan.append(text('p', '', a
                ? `Free tasting menu: ${a.freeMessagesLeft} of ${a.freeMessages} messages left.`
                : 'Loading…'));
            plan.append(button(`Become a regular${price ? ` · ${price}` : ''}`, 'btn primary', () => {
                close();
                startCheckout();
            }));
        }
        body.append(plan);

        // API key
        const keys = el('section', 'acct-section');
        keys.append(text('h3', '', 'Your API key'));
        const bk = browserKey();
        if (bk) {
            const days = Math.max(1, Math.ceil((bk.expiresAt - Date.now()) / 86400000));
            keys.append(text('p', '', `Key ${bk.hint} is saved in this browser for ${days} more day${days === 1 ? '' : 's'}.`));
            keys.append(button('Remove from this browser', 'btn ghost', () => {
                clearBrowserKey();
                emit();
                close();
                openAccount();
            }));
        }
        if (signedIn && a.keyHint) {
            keys.append(text('p', '', `Key ${a.keyHint} is saved to your account, encrypted.`));
            const row = el('div', 'row');
            row.append(
                button('Replace', 'btn', () => {
                    close();
                    openKeyDialog();
                }),
                button('Remove', 'btn ghost', async (e) => {
                    await busy(e.currentTarget, async () => {
                        await api('/key', { method: 'POST', body: { apiKey: '' } });
                        await refreshAccount();
                    });
                    close();
                    openAccount();
                }),
            );
            keys.append(row);
        }
        if (signedIn && !a.keyHint) {
            keys.append(text('p', 'muted', bk
                ? 'Save a key to your account to use it on any device, encrypted.'
                : 'Use your own Anthropic API key instead of the free messages or a subscription.'));
            keys.append(button('Save a key to my account', 'btn', () => {
                close();
                openKeyDialog();
            }));
        } else if (!signedIn && !bk) {
            keys.append(text('p', 'muted', 'Use your own Anthropic API key instead of the free messages or a subscription.'));
            keys.append(button('Add a key', 'btn', () => {
                close();
                openKeyDialog();
            }));
        }
        body.append(keys);

        const foot = el('div', 'dialog-foot');
        if (signedIn) {
            foot.append(button('Sign out', 'btn ghost', async () => {
                close();
                await signOut(auth); // onAuthStateChanged starts a fresh guest session
            }));
        } else {
            foot.append(button('Sign in with Google', 'btn primary', () => {
                close();
                openSignIn();
            }));
        }
        body.append(foot);
    });
}

// ---------- Returning from Stripe Checkout ----------

export async function handleCheckoutReturn(toast) {
    const params = new URLSearchParams(location.search);
    const result = params.get('checkout');
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
