const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');
const { systemPromptFor, PERSONAS } = require('./prompt');
const { encryptApiKey, apiKeyHint } = require('./keyCrypto');
const { getWelcome } = require('./welcome');
const {
    db, userRef, keyRef, AccessError, verifyUser, clientIp, resolvePayer, accountSummary, API_KEY_PATTERN,
    costMicros, recordSubscriberUsage, recordTrialUsage,
} = require('./access');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const ANTHROPIC_KEY_ENCRYPTION_KEY = defineSecret('ANTHROPIC_KEY_ENCRYPTION_KEY');
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const STRIPE_PRICE_ID = defineSecret('STRIPE_PRICE_ID');

const MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 32000;
// Server tools can pause a long turn (stop_reason "pause_turn"); we resume a few times at most.
const MAX_CONTINUATIONS = 4;
const MAX_MESSAGES = 200;

const SITE_URL = 'https://ai.noahgdorfman.com';
// The site's previous address, still allowed so open tabs keep working through the move.
const OLD_SITE_URL = 'https://claudio.noahgdorfman.com';
const APP_TAG = 'claudio';
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const ALLOWED_ORIGINS = [SITE_URL, OLD_SITE_URL, LOCAL_ORIGIN];

const TOOLS = [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
];

// Effort is the only thinking dial on Sonnet 5.5. "low" keeps casual chat snappy;
// "high" is the "think it through" toggle in the UI.
const EFFORTS = new Set(['low', 'high']);

function systemPrompt(persona) {
    const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York',
    });
    return [
        { type: 'text', text: systemPromptFor(persona) },
        { type: 'text', text: `Today's date is ${today}.` },
    ];
}

function validateMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return 'No messages provided.';
    if (messages.length > MAX_MESSAGES) return 'This conversation is too long. Start a new one.';
    for (const m of messages) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) return 'Bad message role.';
        if (typeof m.content !== 'string' && !Array.isArray(m.content)) return 'Bad message content.';
    }
    if (messages[messages.length - 1].role !== 'user') return 'The last message must be from the user.';
    return null;
}

function sendError(res, err) {
    if (err instanceof AccessError) {
        res.status(err.status).json({ error: err.message, code: err.code });
    } else {
        console.error(err);
        res.status(500).json({ error: 'Something went wrong in the kitchen.' });
    }
}

function anthropicErrorMessage(err, usingOwnKey) {
    const detail = err?.error?.error?.message;
    if (usingOwnKey && (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)) {
        return { code: 'BAD_KEY', message: 'Anthropic rejected your API key. Update it from your account.' };
    }
    if (usingOwnKey && err instanceof Anthropic.BadRequestError && detail) {
        return { code: 'KEY_PROBLEM', message: `Anthropic said: ${detail}` };
    }
    if (err instanceof Anthropic.RateLimitError) return { message: 'Too many orders at once. Give it a minute and try again.' };
    if (err instanceof Anthropic.BadRequestError) return { message: 'That request didn\'t go through. Try starting a new chat.' };
    if (err instanceof Anthropic.APIConnectionError) return { message: 'Couldn\'t reach the kitchen. Check your connection and try again.' };
    return { message: 'Something went wrong in the kitchen.' };
}

// ---------- Chat ----------

exports.claudioChat = onRequest(
    {
        secrets: [ANTHROPIC_API_KEY, ANTHROPIC_KEY_ENCRYPTION_KEY],
        cors: ALLOWED_ORIGINS,
        timeoutSeconds: 540,
        memory: '512MiB',
    },
    async (req, res) => {
        if (req.method !== 'POST') {
            res.status(405).json({ error: 'POST only.' });
            return;
        }

        const { messages, effort = 'low', apiKey: browserKey } = req.body || {};
        const persona = PERSONAS.includes(req.body?.persona) ? req.body.persona : 'claudio';
        const problem = validateMessages(messages);
        if (problem) {
            res.status(400).json({ error: problem });
            return;
        }

        let payer;
        let user;
        const ip = clientIp(req);
        try {
            user = await verifyUser(req);
            payer = await resolvePayer({
                user,
                browserKey: typeof browserKey === 'string' ? browserKey.trim() : null,
                ip,
                ownerKey: ANTHROPIC_API_KEY.value(),
                encryptionKey: ANTHROPIC_KEY_ENCRYPTION_KEY.value(),
            });
        } catch (err) {
            sendError(res, err);
            return;
        }

        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();

        const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

        const client = new Anthropic({ apiKey: payer.apiKey });
        let stream = null;
        let closed = false;
        res.on('close', () => {
            closed = true;
            stream?.abort();
        });

        const history = messages.slice();
        // Everything the assistant produced this turn, across pause_turn continuations.
        // The client stores it verbatim and sends it back, so thinking blocks and
        // server-tool blocks round-trip unchanged.
        const turnContent = [];
        let stopReason = null;
        let spentMicros = 0;   // cost of the API calls that finished
        let streamedChars = 0; // text streamed by the call in progress, to estimate a cut-off call

        // Cost of the call in progress if it never finished (stopped or failed): input from
        // message_start, output estimated at ~4 characters a token. Summarized thinking is
        // shorter than the real thing, so this undercounts a little.
        const unfinishedMicros = () => {
            const usage = stream?.currentMessage?.usage;
            return usage ? costMicros({ ...usage, output_tokens: Math.ceil(streamedChars / 4) }) : 0;
        };

        // Trial and subscription messages count against a budget of what they actually cost.
        const settleUsage = async (micros) => {
            console.log('[usage]', JSON.stringify({ uid: user.uid, source: payer.source, micros }));
            if (micros <= 0) return undefined;
            try {
                if (payer.source === 'subscription') return await recordSubscriberUsage(user.uid, micros);
                if (payer.source === 'trial') await recordTrialUsage(user.uid, ip, micros);
            } catch (err) {
                console.error('[claudioChat] could not record usage', err);
            }
            return undefined;
        };

        try {
            for (let i = 0; i <= MAX_CONTINUATIONS && !closed; i++) {
                streamedChars = 0;
                stream = client.beta.messages.stream({
                    model: MODEL,
                    max_tokens: MAX_TOKENS,
                    system: systemPrompt(persona),
                    messages: history,
                    tools: TOOLS,
                    thinking: { type: 'adaptive', display: 'summarized' },
                    output_config: { effort: EFFORTS.has(effort) ? effort : 'low' },
                    cache_control: { type: 'ephemeral' },
                    betas: ['server-side-fallback-2026-07-01'],
                    fallbacks: 'default',
                });

                for await (const event of stream) {
                    if (event.type === 'content_block_start') {
                        const block = event.content_block;
                        if (block.type === 'thinking') send({ type: 'thinking_start' });
                        if (block.type === 'text') send({ type: 'text_start' });
                    } else if (event.type === 'content_block_delta') {
                        const d = event.delta;
                        if (d.type === 'text_delta') {
                            streamedChars += d.text.length;
                            send({ type: 'text', text: d.text });
                        }
                        if (d.type === 'thinking_delta') {
                            streamedChars += d.thinking.length;
                            send({ type: 'thinking', text: d.thinking });
                        }
                    } else if (event.type === 'content_block_stop') {
                        const block = stream.currentMessage?.content[event.index];
                        if (block?.type === 'server_tool_use') {
                            send({ type: 'tool', name: block.name, input: block.input });
                        } else if (block?.type === 'text' && block.citations?.length) {
                            send({
                                type: 'citations',
                                citations: block.citations
                                    .filter((c) => c.url)
                                    .map((c) => ({ url: c.url, title: c.title })),
                            });
                        }
                    }
                }

                const message = await stream.finalMessage();
                spentMicros += costMicros(message.usage);
                stream = null; // counted; keep unfinishedMicros() from counting it again
                turnContent.push(...message.content);
                stopReason = message.stop_reason;
                if (stopReason !== 'pause_turn') break;
                // Resume: re-send with the paused assistant turn appended; the API picks up
                // where it left off. Consecutive assistant messages are merged server-side.
                history.push({ role: 'assistant', content: message.content });
            }

            if (closed) {
                await settleUsage(spentMicros + unfinishedMicros());
            } else {
                const allowanceUsedPercent = await settleUsage(spentMicros);
                send({ type: 'done', content: turnContent, stop_reason: stopReason, allowanceUsedPercent });
            }
        } catch (err) {
            await settleUsage(spentMicros + unfinishedMicros());
            if (closed) return;
            console.error('[claudioChat] Anthropic error:', err);
            send({ type: 'error', ...anthropicErrorMessage(err, payer.source === 'browser' || payer.source === 'saved') });
        } finally {
            res.end();
        }
    }
);

// ---------- Account, keys, billing ----------

let cachedPlan = null;
let cachedPriceId = null;

// STRIPE_PRICE_ID may hold the price (price_…) or the product (prod_…); a product resolves to
// its default price.
async function resolvePriceId(stripe) {
    if (cachedPriceId) return cachedPriceId;
    const id = STRIPE_PRICE_ID.value().trim();
    if (id.startsWith('prod_')) {
        const product = await stripe.products.retrieve(id);
        const price = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id;
        if (!price) throw new Error(`Stripe product ${id} has no default price.`);
        cachedPriceId = price;
    } else {
        cachedPriceId = id;
    }
    return cachedPriceId;
}

async function planInfo(stripe) {
    if (cachedPlan) return cachedPlan;
    try {
        const price = await stripe.prices.retrieve(await resolvePriceId(stripe));
        cachedPlan = {
            amount: price.unit_amount,
            currency: price.currency,
            interval: price.recurring?.interval || 'month',
        };
    } catch (err) {
        console.error('[api] could not load Stripe price', err);
        return null;
    }
    return cachedPlan;
}

async function checkAnthropicKey(apiKey) {
    if (!API_KEY_PATTERN.test(apiKey)) {
        throw new AccessError(400, 'BAD_KEY', 'That doesn\'t look like an Anthropic API key. They start with sk-ant-.');
    }
    try {
        await new Anthropic({ apiKey, maxRetries: 1 }).models.list({ limit: 1 });
    } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
            throw new AccessError(400, 'BAD_KEY', 'Anthropic rejected that API key. Double-check it and try again.');
        }
        // Network or service trouble: give the key the benefit of the doubt.
        console.warn('[api] could not verify key, accepting it', err.message);
    }
}

function returnOrigin(req) {
    const origin = req.get('Origin') || '';
    return origin === SITE_URL || LOCAL_ORIGIN.test(origin) ? origin : SITE_URL; // old domain returns to the new one
}

function requireSignedIn(user) {
    if (user.isAnonymous) throw new AccessError(403, 'SIGN_IN', 'Sign in first.');
}

async function findOrCreateCustomer(stripe, user) {
    const snap = await userRef(user.uid).get();
    const existing = snap.get('stripeCustomerId');
    if (existing) return existing;
    const customer = await stripe.customers.create({
        email: user.email || undefined,
        metadata: { firebaseUID: user.uid },
    });
    await userRef(user.uid).set({ stripeCustomerId: customer.id, email: user.email || null }, { merge: true });
    return customer.id;
}

async function portalUrl(stripe, req, user, flow) {
    const snap = await userRef(user.uid).get();
    const customer = snap.get('stripeCustomerId');
    if (!customer) throw new AccessError(400, 'NO_CUSTOMER', 'No subscription on this account yet.');
    const back = `${returnOrigin(req)}/?billing=updated`;
    const params = { customer, return_url: back };
    const afterCompletion = { type: 'redirect', redirect: { return_url: back } };
    const subscription = snap.get('stripeSubscriptionId');
    if (flow === 'cancel' && subscription) {
        params.flow_data = { type: 'subscription_cancel', subscription_cancel: { subscription }, after_completion: afterCompletion };
    } else if (flow === 'payment') {
        params.flow_data = { type: 'payment_method_update', after_completion: afterCompletion };
    }
    return (await stripe.billingPortal.sessions.create(params)).url;
}

exports.api = onRequest(
    {
        secrets: [ANTHROPIC_API_KEY, ANTHROPIC_KEY_ENCRYPTION_KEY, STRIPE_SECRET_KEY, STRIPE_PRICE_ID],
        cors: ALLOWED_ORIGINS,
    },
    async (req, res) => {
        try {
            // The welcome screen loads before sign-in finishes, so it needs no token.
            if (req.method === 'GET' && req.path.replace(/\/+$/, '') === '/welcome') {
                res.set('Cache-Control', 'no-store');
                const persona = PERSONAS.includes(req.query?.persona) ? req.query.persona : 'claudio';
                res.json({ welcome: await getWelcome(ANTHROPIC_API_KEY.value(), persona) });
                return;
            }

            const user = await verifyUser(req);
            const stripe = new Stripe(STRIPE_SECRET_KEY.value());
            const route = `${req.method} ${req.path.replace(/\/+$/, '') || '/'}`;

            switch (route) {
                case 'GET /account': {
                    let [account, plan] = await Promise.all([
                        accountSummary(user, clientIp(req)),
                        planInfo(stripe),
                    ]);
                    // Subscriptions synced before period dates were stored: fetch them once.
                    if (!account.hasPeriodDates && ['subscribed', 'pending_cancellation', 'past_due'].includes(account.subscriptionStatus)) {
                        const subId = (await userRef(user.uid).get()).get('stripeSubscriptionId');
                        if (subId) {
                            await syncSubscription(await stripe.subscriptions.retrieve(subId), user.uid);
                            account = await accountSummary(user, clientIp(req));
                        }
                    }
                    res.json({ ...account, plan });
                    return;
                }

                // A key the user wants kept in this browser only: just check that it works.
                case 'POST /key/check': {
                    const apiKey = String(req.body?.apiKey || '').trim();
                    await checkAnthropicKey(apiKey);
                    res.json({ ok: true, hint: apiKeyHint(apiKey) });
                    return;
                }

                // Save (or with an empty key, remove) the signed-in user's encrypted key.
                case 'POST /key': {
                    requireSignedIn(user);
                    const apiKey = String(req.body?.apiKey || '').trim();
                    if (!apiKey) {
                        await keyRef(user.uid).delete();
                        await userRef(user.uid).set({ anthropicKeyHint: null }, { merge: true });
                        res.json({ hint: null });
                        return;
                    }
                    await checkAnthropicKey(apiKey);
                    const hint = apiKeyHint(apiKey);
                    await keyRef(user.uid).set({
                        encrypted: encryptApiKey(apiKey, user.uid, ANTHROPIC_KEY_ENCRYPTION_KEY.value()),
                        updatedAt: Date.now(),
                    });
                    await userRef(user.uid).set({ anthropicKeyHint: hint }, { merge: true });
                    res.json({ hint });
                    return;
                }

                case 'POST /checkout': {
                    requireSignedIn(user);
                    const origin = returnOrigin(req);
                    const customer = await findOrCreateCustomer(stripe, user);
                    const session = await stripe.checkout.sessions.create({
                        mode: 'subscription',
                        customer,
                        client_reference_id: user.uid,
                        line_items: [{ price: await resolvePriceId(stripe), quantity: 1 }],
                        // The Stripe account is shared with other apps; the tag lets every app's
                        // webhook tell Claudio's checkouts and subscriptions from its own.
                        metadata: { app: APP_TAG, firebaseUID: user.uid },
                        subscription_data: { metadata: { app: APP_TAG, firebaseUID: user.uid } },
                        allow_promotion_codes: true,
                        success_url: `${origin}/?checkout=success`,
                        cancel_url: `${origin}/?checkout=cancel`,
                    });
                    res.json({ url: session.url });
                    return;
                }

                // Undo a pending cancellation right here, no trip to Stripe needed.
                // Cancel at period end, or undo that, right here; no trip to Stripe needed.
                case 'POST /subscription/cancel':
                case 'POST /subscription/resume': {
                    requireSignedIn(user);
                    const cancel = route.endsWith('/cancel');
                    const subId = (await userRef(user.uid).get()).get('stripeSubscriptionId');
                    if (!subId) throw new AccessError(400, 'NO_SUBSCRIPTION', 'No subscription on this account.');
                    try {
                        const current = await stripe.subscriptions.retrieve(subId);
                        const cancelling = current.cancel_at_period_end || Boolean(current.cancel_at);
                        let change = null;
                        if (cancel && !cancelling) change = { cancel_at_period_end: true };
                        // Cancellations set either cancel_at_period_end or an explicit date, cleared with ''.
                        if (!cancel && cancelling) change = current.cancel_at_period_end ? { cancel_at_period_end: false } : { cancel_at: '' };
                        const sub = change ? await stripe.subscriptions.update(subId, change) : current;
                        await syncSubscription(sub, user.uid);
                        res.json({ ok: true });
                    } catch (err) {
                        // A restricted key without Subscriptions write: do it on Stripe's portal instead.
                        if (err.type !== 'StripePermissionError') throw err;
                        console.warn('[api] STRIPE_SECRET_KEY needs Subscriptions: Write to change subscriptions in-app');
                        res.json({ url: await portalUrl(stripe, req, user, cancel ? 'cancel' : null) });
                    }
                    return;
                }

                // Stripe's hosted billing portal. 'payment' opens straight onto the card screen and
                // redirects back here when it's done; without a flow it's the full portal
                // (invoices), which only has a "Return to Claudio" link.
                case 'POST /portal': {
                    requireSignedIn(user);
                    res.json({ url: await portalUrl(stripe, req, user, req.body?.flow) });
                    return;
                }

                default:
                    res.status(404).json({ error: 'Not found.' });
            }
        } catch (err) {
            sendError(res, err);
        }
    }
);

// ---------- Stripe webhook ----------
//
// The Stripe account also bills other apps, and every endpoint subscribed to an event type gets
// it for all of them. Anything that isn't a Claudio subscription is acknowledged and ignored.

async function isClaudioSubscription(stripe, sub) {
    if (sub.metadata?.app === APP_TAG) return true;
    const priceId = await resolvePriceId(stripe);
    return (sub.items?.data || []).some((item) => item.price?.id === priceId);
}

function statusFromSubscription(sub) {
    if (sub.status === 'active' || sub.status === 'trialing') {
        return sub.cancel_at_period_end || sub.cancel_at ? 'pending_cancellation' : 'subscribed';
    }
    if (sub.status === 'past_due') return 'past_due';
    return 'unsubscribed';
}

async function uidForSubscription(sub) {
    if (sub.metadata?.firebaseUID) return sub.metadata.firebaseUID;
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    const match = await db.collection('users').where('stripeCustomerId', '==', customerId).limit(1).get();
    return match.empty ? null : match.docs[0].id;
}

async function syncSubscription(sub, uid = null) {
    uid = uid || await uidForSubscription(sub);
    if (!uid) {
        console.warn('[stripeWebhook] no user for subscription', sub.id);
        return;
    }
    const status = statusFromSubscription(sub);
    const currentSubId = (await userRef(uid).get()).get('stripeSubscriptionId');
    // A late event about an old, ended subscription mustn't clobber a newer active one.
    if (currentSubId && currentSubId !== sub.id && status === 'unsubscribed') return;
    // Billing period dates live on the subscription items in current Stripe API versions.
    const items = sub.items?.data || [];
    const periodStart = Math.max(0, ...items.map((i) => i.current_period_start || 0)) || null;
    const periodEnd = Math.max(0, ...items.map((i) => i.current_period_end || 0)) || null;
    await userRef(uid).set({
        subscriptionStatus: status,
        stripeSubscriptionId: sub.id,
        stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
        periodStart,
        periodEnd,
        cancelAt: sub.cancel_at || (sub.cancel_at_period_end ? periodEnd : null),
    }, { merge: true });
}

exports.stripeWebhook = onRequest(
    { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID] },
    async (req, res) => {
        const stripe = new Stripe(STRIPE_SECRET_KEY.value());
        let event;
        try {
            event = stripe.webhooks.constructEvent(req.rawBody, req.get('stripe-signature'), STRIPE_WEBHOOK_SECRET.value());
        } catch (err) {
            console.error('[stripeWebhook] bad signature', err.message);
            res.status(400).send('Bad signature');
            return;
        }

        try {
            switch (event.type) {
                case 'checkout.session.completed': {
                    const session = event.data.object;
                    if (session.metadata?.app !== APP_TAG || session.mode !== 'subscription' || !session.subscription) break;
                    const sub = await stripe.subscriptions.retrieve(session.subscription);
                    await syncSubscription(sub, session.client_reference_id);
                    break;
                }
                case 'customer.subscription.created':
                case 'customer.subscription.updated':
                case 'customer.subscription.deleted':
                    if (await isClaudioSubscription(stripe, event.data.object)) {
                        await syncSubscription(event.data.object);
                    }
                    break;
                default:
                    break;
            }
            res.json({ received: true });
        } catch (err) {
            console.error('[stripeWebhook] handler failed', err);
            res.status(500).send('Handler failed');
        }
    }
);
