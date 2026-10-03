// Who's paying for this message? Firebase Auth identifies the user (every visitor is at least
// an anonymous user), Firestore holds the trial counter, subscription status and saved key.
//
// Firestore layout (clients have no direct access; see firestore.rules):
//   users/{uid}                 { freeMessagesUsed, subscriptionStatus, stripeCustomerId,
//                                 anthropicKeyHint, periodStart, periodEnd, cancelAt,
//                                 usagePeriod, usageMicros, email }
//   users/{uid}/private/apiKey  { encrypted, updatedAt }
//   trialIps/{sha256(ip)}       { day, count }

const crypto = require('crypto');
const { getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { decryptApiKey } = require('./keyCrypto');

if (!getApps().length) initializeApp();
const db = getFirestore();

const FREE_MESSAGES = 10;            // per account, anonymous or signed in
const TRIAL_MESSAGES_PER_IP_DAY = 40; // speed bump against clearing storage for a fresh trial
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

function clientIp(req) {
    return (req.get('x-forwarded-for') || '').split(',')[0].trim() || req.ip || 'unknown';
}

function today() {
    return new Date().toISOString().slice(0, 10);
}

async function claimTrialMessage(uid, ip) {
    const ipRef = db.collection('trialIps').doc(crypto.createHash('sha256').update(ip).digest('hex'));
    const day = today();
    let left = 0;
    await db.runTransaction(async (tx) => {
        const [userSnap, ipSnap] = await Promise.all([tx.get(userRef(uid)), tx.get(ipRef)]);
        const used = userSnap.get('freeMessagesUsed') || 0;
        if (used >= FREE_MESSAGES) {
            throw new AccessError(402, 'TRIAL_USED', 'That\'s the end of the free tasting menu.');
        }
        const ipCount = ipSnap.get('day') === day ? ipSnap.get('count') || 0 : 0;
        if (ipCount >= TRIAL_MESSAGES_PER_IP_DAY) {
            throw new AccessError(402, 'TRIAL_USED', 'The free tasting menu is all used up on this network today.');
        }
        tx.set(userRef(uid), { freeMessagesUsed: used + 1 }, { merge: true });
        tx.set(ipRef, { day, count: ipCount + 1 });
        left = FREE_MESSAGES - used - 1;
    });
    // Give the message back if the request fails before Claudio says anything.
    const refund = async () => {
        await Promise.all([
            userRef(uid).set({ freeMessagesUsed: FieldValue.increment(-1) }, { merge: true }),
            ipRef.set({ count: FieldValue.increment(-1) }, { merge: true }),
        ]).catch((err) => console.error('[access] trial refund failed', err));
    };
    return { refund, left };
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
 * Returns { apiKey, source, refund, freeMessagesLeft? }.
 */
async function resolvePayer({ user, browserKey, ip, ownerKey, encryptionKey }) {
    const snap = await userRef(user.uid).get();
    const data = snap.data() || {};

    if (!user.isAnonymous && PAID_STATUSES.has(data.subscriptionStatus)) {
        try {
            await checkSubscriberAllowance(user.uid, data);
            return { apiKey: ownerKey, source: 'subscription', refund: null };
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
        return { apiKey: browserKey, source: 'browser', refund: null };
    }

    if (!user.isAnonymous && data.anthropicKeyHint) {
        const keySnap = await keyRef(user.uid).get();
        if (keySnap.exists) {
            try {
                return { apiKey: decryptApiKey(keySnap.get('encrypted'), user.uid, encryptionKey), source: 'saved', refund: null };
            } catch (err) {
                console.error('[access] could not decrypt saved key', err);
                throw new AccessError(500, 'BAD_SAVED_KEY', 'Couldn\'t read your saved API key. Save it again from your account.');
            }
        }
    }

    const { refund, left } = await claimTrialMessage(user.uid, ip);
    return { apiKey: ownerKey, source: 'trial', refund, freeMessagesLeft: left };
}

async function accountSummary(user) {
    const data = (await userRef(user.uid).get()).data() || {};
    const used = data.freeMessagesUsed || 0;
    return {
        uid: user.uid,
        email: user.email,
        isAnonymous: user.isAnonymous,
        freeMessages: FREE_MESSAGES,
        freeMessagesLeft: Math.max(0, FREE_MESSAGES - used),
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
    API_KEY_PATTERN,
    PAID_STATUSES,
};
