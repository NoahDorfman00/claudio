// Who's paying for this message? Firebase Auth identifies the user (every visitor is at least
// an anonymous user), Firestore holds the trial counter, subscription status and saved key.
//
// Firestore layout (clients have no direct access; see firestore.rules):
//   users/{uid}                 { trialMicros, subscriptionStatus, stripeCustomerId,
//                                 anthropicKeyHint, periodStart, periodEnd, cancelAt,
//                                 usagePeriod, usageMicros, email }
//   users/{uid}/private/apiKey  { encrypted, updatedAt }
//   trialIps/{sha256(network)}  { micros, since }

const crypto = require('crypto');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { decryptApiKey } = require('./keyCrypto');

if (!getApps().length) initializeApp();
const db = getFirestore();

// The free trial is a budget of real API cost, not a message count, and it isn't shown to the
// user: they chat until it runs out and then see the paywall. Each network gets the same
// budget as each account (over a rolling window), so clearing storage or signing out for a
// fresh guest session on the same network doesn't unlock more.
const TRIAL_BUDGET_MICROS = 300_000; // $0.30, roughly ten typical messages
const TRIAL_NETWORK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Subscribers get a monthly allowance measured in what their messages actually cost on the
// API, in micro-dollars. $5 against a $6/month price keeps a maxed-out subscriber about even.
const SUBSCRIBER_MONTHLY_BUDGET_MICROS = 5_000_000;

// Claude Sonnet 5.5 list prices. Dollars per million tokens is the same number as
// micro-dollars per token.
const PRICE_MICROS = {
    input: 2,
    output: 10,
    cacheWrite: 2.5, // 5-minute cache
    cacheRead: 0.2,
    webSearch: 10_000, // $10 per 1,000 searches
};
const PAID_STATUSES = new Set(['subscribed', 'pending_cancellation']);
const API_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;

class AccessError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const userRef = (uid) => db.collection('users').doc(uid);
const keyRef = (uid) => userRef(uid).collection('private').doc('apiKey');

async function verifyUser(req) {
    const match = (req.get('Authorization') || '').match(/^Bearer (.+)$/);
    if (!match) throw new AccessError(401, 'NO_AUTH', 'Missing sign-in token. Refresh the page and try again.');
    try {
        const token = await getAuth().verifyIdToken(match[1]);
        return {
            uid: token.uid,
            email: token.email || null,
            isAnonymous: token.firebase?.sign_in_provider === 'anonymous',
        };
    } catch {
        throw new AccessError(401, 'BAD_AUTH', 'Your session expired. Refresh the page and try again.');
    }
}

// Google's front end appends the real client address as the last X-Forwarded-For entry;
// anything before it came from the client and can be made up.
function clientIp(req) {
    const hops = (req.get('x-forwarded-for') || '').split(',').map((h) => h.trim()).filter(Boolean);
    return hops[hops.length - 1] || req.socket?.remoteAddress || 'unknown';
}

/**
 * The network an address belongs to. IPv6 devices rotate through addresses inside their /64,
 * so that prefix is the network; IPv4 (including IPv4-mapped IPv6) is the address itself.
 */
function networkOf(ip) {
    const v4 = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (v4) return v4[1];
    if (!ip.includes(':')) return ip;
    const [head, tail = ''] = ip.split('%')[0].split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
    return `${groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':')}::/64`;
}

const networkRef = (ip) => db.collection('trialIps').doc(crypto.createHash('sha256').update(networkOf(ip)).digest('hex'));

function networkSpent(snap) {
    const since = snap.get('since') || 0;
    return Date.now() - since < TRIAL_NETWORK_WINDOW_MS ? snap.get('micros') || 0 : 0;
}

async function checkTrial(data, ip) {
    if ((data.trialMicros || 0) >= TRIAL_BUDGET_MICROS) {
        throw new AccessError(402, 'TRIAL_USED', 'That\'s the end of the free tasting menu.');
    }
    if (networkSpent(await networkRef(ip).get()) >= TRIAL_BUDGET_MICROS) {
        throw new AccessError(402, 'TRIAL_USED', 'That\'s the end of the free tasting menu.');
    }
}

/** Add a trial message's cost to both the account and its network. */
async function recordTrialUsage(uid, ip, micros) {
    const ref = networkRef(ip);
    await db.runTransaction(async (tx) => {
        const [userSnap, netSnap] = await Promise.all([tx.get(userRef(uid)), tx.get(ref)]);
        const spent = networkSpent(netSnap);
        tx.set(userRef(uid), { trialMicros: (userSnap.get('trialMicros') || 0) + micros }, { merge: true });
        tx.set(ref, { micros: spent + micros, since: spent ? netSnap.get('since') : Date.now() });
    });
}

function addMonth(seconds) {
    const d = new Date(seconds * 1000);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return Math.floor(d.getTime() / 1000);
}

/**
 * The subscriber's current billing period, which the allowance follows (subscribed Oct 3 ->
 * resets Nov 3). periodStart/periodEnd come from Stripe via the webhook. If a renewal webhook
 * is late, roll forward a month at a time so the allowance still resets on time.
 */
function billingPeriod(data) {
    let { periodStart: start, periodEnd: end } = data;
    if (!start || !end) {
        // No Stripe dates yet: fall back to the calendar month.
        const now = new Date();
        start = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
        end = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000);
    }
    const nowSec = Date.now() / 1000;
    while (end <= nowSec) {
        start = end;
        end = addMonth(end);
    }
    return { key: String(start), end };
}

function spentThisPeriod(data) {
    return data.usagePeriod === billingPeriod(data).key ? data.usageMicros || 0 : 0;
}

function formatDate(seconds) {
    return new Date(seconds * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
}

async function checkSubscriberAllowance(uid, data) {
    if (spentThisPeriod(data) >= SUBSCRIBER_MONTHLY_BUDGET_MICROS) {
        const resets = formatDate(billingPeriod(data).end);
        throw new AccessError(429, 'MONTHLY_LIMIT', `You've used this month's allowance. It resets on ${resets}, or add your own API key to keep going.`);
    }
}

/** What one API response cost, in micro-dollars, from its usage block. */
function costMicros(usage) {
    if (!usage) return 0;
    return Math.round(
        (usage.input_tokens || 0) * PRICE_MICROS.input
        + (usage.output_tokens || 0) * PRICE_MICROS.output
        + (usage.cache_creation_input_tokens || 0) * PRICE_MICROS.cacheWrite
        + (usage.cache_read_input_tokens || 0) * PRICE_MICROS.cacheRead
        + (usage.server_tool_use?.web_search_requests || 0) * PRICE_MICROS.webSearch,
    );
}

/** Add a finished message's cost to the subscriber's month. Returns the percent of the allowance used. */
async function recordSubscriberUsage(uid, micros) {
    let total = 0;
    await db.runTransaction(async (tx) => {
        const data = (await tx.get(userRef(uid))).data() || {};
        total = spentThisPeriod(data) + micros;
        tx.set(userRef(uid), { usagePeriod: billingPeriod(data).key, usageMicros: total }, { merge: true });
    });
    return allowancePercent(total);
}

function allowancePercent(micros) {
    return Math.min(100, Math.round((micros / SUBSCRIBER_MONTHLY_BUDGET_MICROS) * 100));
}

/**
 * Decide which API key pays for a message, in order: subscription (owner's key), a key the
 * browser sent with this request, a saved encrypted key, then the free trial (owner's key).
 * Returns { apiKey, source }.
 */
async function resolvePayer({ user, browserKey, ip, ownerKey, encryptionKey }) {
    const snap = await userRef(user.uid).get();
    const data = snap.data() || {};

    if (!user.isAnonymous && PAID_STATUSES.has(data.subscriptionStatus)) {
        try {
            await checkSubscriberAllowance(user.uid, data);
            return { apiKey: ownerKey, source: 'subscription' };
        } catch (err) {
            // Past the monthly allowance, a subscriber who also has a key of their own falls through to it.
            const hasOwnKey = browserKey || data.anthropicKeyHint;
            if (err.code !== 'MONTHLY_LIMIT' || !hasOwnKey) throw err;
        }
    }

    if (browserKey) {
        if (!API_KEY_PATTERN.test(browserKey)) {
            throw new AccessError(400, 'BAD_KEY', 'That doesn\'t look like an Anthropic API key.');
        }
        return { apiKey: browserKey, source: 'browser' };
    }

    if (!user.isAnonymous && data.anthropicKeyHint) {
        const keySnap = await keyRef(user.uid).get();
        if (keySnap.exists) {
            try {
                return { apiKey: decryptApiKey(keySnap.get('encrypted'), user.uid, encryptionKey), source: 'saved' };
            } catch (err) {
                console.error('[access] could not decrypt saved key', err);
                throw new AccessError(500, 'BAD_SAVED_KEY', 'Couldn\'t read your saved API key. Save it again from your account.');
            }
        }
    }

    await checkTrial(data, ip);
    return { apiKey: ownerKey, source: 'trial' };
}

async function accountSummary(user, ip) {
    const data = (await userRef(user.uid).get()).data() || {};
    const networkUsedUp = ip ? networkSpent(await networkRef(ip).get()) >= TRIAL_BUDGET_MICROS : false;
    return {
        uid: user.uid,
        email: user.email,
        isAnonymous: user.isAnonymous,
        trialUsedUp: (data.trialMicros || 0) >= TRIAL_BUDGET_MICROS || networkUsedUp,
        subscriptionStatus: user.isAnonymous ? 'unsubscribed' : data.subscriptionStatus || 'unsubscribed',
        allowanceUsedPercent: allowancePercent(spentThisPeriod(data)),
        // When the allowance resets (renewal), or when access ends if the subscription is cancelled.
        allowanceResets: formatDate(billingPeriod(data).end),
        endsOn: data.subscriptionStatus === 'pending_cancellation' && data.cancelAt ? formatDate(data.cancelAt) : null,
        hasPeriodDates: Boolean(data.periodEnd),
        keyHint: user.isAnonymous ? null : data.anthropicKeyHint || null,
    };
}

module.exports = {
    db,
    userRef,
    keyRef,
    AccessError,
    verifyUser,
    clientIp,
    resolvePayer,
    accountSummary,
    costMicros,
    recordSubscriberUsage,
    recordTrialUsage,
    API_KEY_PATTERN,
    PAID_STATUSES,
};
