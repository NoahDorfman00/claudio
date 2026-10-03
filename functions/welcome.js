// The empty-state greeting and suggested prompts. Claude writes a batch of them once a day
// (on the owner's key), they're stored in Firestore, and each visitor gets a random set. One
// generation a day keeps it cheap and means hitting the endpoint can't run up a bill.

const Anthropic = require('@anthropic-ai/sdk');
const { db } = require('./access');

const MODEL = 'claude-sonnet-5-5';
const REFRESH_MS = 24 * 60 * 60 * 1000;
const LOCK_MS = 2 * 60 * 1000;
const SETS = 12;
const LIMITS = { greeting: 34, subtitle: 72, suggestion: 52 };

const welcomeRef = (persona) => db.collection('meta').doc(`welcome_${persona}`);

const CHARACTERS = {
    claudio: {
        who: 'Claudio, the "Artificial Italian": a chat assistant with the voice of a warm, steady Italian-American grandfather in his late sixties from South Jersey, a retired machinist who can fix or build just about anything',
        examples: '"Ciao! Pull up a chair, kid." or "Alright, what are we fixin\' today?"',
        flavor: 'Family, the garden, the shore, Sunday dinner, and now and then fixing or building things (not every set).',
    },
    claudia: {
        who: 'Claudia, the "Artificial Italian": a chat assistant with the voice of a warm, sharp Italian-American grandmother in her late sixties from South Jersey, a retired seamstress and the best cook in the family',
        examples: '"Ciao, hon! Come in, sit." or "You eat yet? Sit, sit."',
        flavor: 'Family, the kitchen, Sunday dinner, the grandkids, and now and then sewing or mending (not every set).',
    },
};

const SCHEMA = {
    type: 'object',
    properties: {
        sets: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    greeting: { type: 'string' },
                    subtitle: { type: 'string' },
                    suggestions: { type: 'array', items: { type: 'string' } },
                },
                required: ['greeting', 'subtitle', 'suggestions'],
                additionalProperties: false,
            },
        },
    },
    required: ['sets'],
    additionalProperties: false,
};

const promptFor = (persona) => {
    const { who, examples, flavor } = CHARACTERS[persona];
    const name = persona === 'claudia' ? 'Claudia' : 'Claudio';
    return `You write the welcome screen for ${who}. Under the hood ${name} can do anything Claude can: code, writing, homework, research with web search, planning, advice, reading images and PDFs.

Write ${SETS} different welcome sets. Each set has:
- greeting: what ${name} says when you sit down. At most ${LIMITS.greeting} characters, so it fits on one line. Warm, a little South Jersey, like ${examples}
- subtitle: one short line under it saying what ${name} can help with. At most ${LIMITS.subtitle} characters, one sentence or two short ones.
- suggestions: exactly 4 prompts a visitor might tap, each at most ${LIMITS.suggestion} characters, written as the visitor talking to ${name}. Give them Italian-American, South Jersey flavor (${flavor}), and make the four cover different things ${name} can actually do: one about food or family, one that's really a coding, work or school question, one that needs current info from the web, and one about writing or advice.

Keep it authentic, not a cartoon: no "mamma mia" accents, no mob jokes, no "badda-bing". Vary the openings and the topics across sets so no two feel alike.`;
};

function clean(set) {
    const trim = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const greeting = trim(set.greeting);
    const subtitle = trim(set.subtitle);
    const suggestions = (set.suggestions || []).map(trim).filter((s) => s && s.length <= LIMITS.suggestion + 8);
    if (!greeting || greeting.length > LIMITS.greeting + 4) return null;
    if (!subtitle || subtitle.length > LIMITS.subtitle + 8) return null;
    if (suggestions.length < 4) return null;
    return { greeting, subtitle, suggestions: suggestions.slice(0, 4) };
}

async function generate(apiKey, persona) {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content: promptFor(persona) }],
    });
    if (response.stop_reason === 'refusal') throw new Error('Welcome generation was declined.');
    const textBlock = response.content.find((b) => b.type === 'text');
    const sets = JSON.parse(textBlock?.text || '{}').sets || [];
    const good = sets.map(clean).filter(Boolean);
    if (good.length < 3) throw new Error(`Only ${good.length} usable welcome sets.`);
    return good;
}

/** A random welcome set, regenerating the batch when it's a day old. Null if none exist yet. */
async function getWelcome(apiKey, persona = 'claudio') {
    const ref = welcomeRef(persona);
    const snap = await ref.get();
    const data = snap.data() || {};
    const sets = data.sets || [];
    const pick = (list) => (list.length ? list[Math.floor(Math.random() * list.length)] : null);
    if (sets.length && Date.now() - (data.generatedAt || 0) < REFRESH_MS) return pick(sets);

    // Stale or missing: one request takes a short lock and regenerates; the rest serve what's there.
    const gotLock = await db.runTransaction(async (tx) => {
        const fresh = (await tx.get(ref)).data() || {};
        if ((fresh.refreshingUntil || 0) > Date.now()) return false;
        tx.set(ref, { refreshingUntil: Date.now() + LOCK_MS }, { merge: true });
        return true;
    });
    if (!gotLock) return pick(sets);

    try {
        const newSets = await generate(apiKey, persona);
        await ref.set({ sets: newSets, generatedAt: Date.now(), refreshingUntil: 0 });
        return pick(newSets);
    } catch (err) {
        console.error('[welcome] generation failed', err);
        await ref.set({ refreshingUntil: 0 }, { merge: true });
        return pick(sets);
    }
}

module.exports = { getWelcome };
