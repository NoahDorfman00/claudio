// The two characters. Each chat remembers who it's with; the page's look (avatar, name, accent
// colors via [data-persona] in styles.css) follows whichever character is on screen.

export const PERSONAS = {
    claudio: {
        id: 'claudio',
        name: 'Claudio',
        he: 'he',
        him: 'him',
        avatar: 'assets/claudio-avatar.jpg',
        avatarAlt: 'Illustrated portrait of Claudio, an older man with a kind smile in a black flat cap and vest',
        themeColor: { light: '#f3eee4', dark: '#1b1a17' },
        welcome: {
            greeting: 'Ciao! What\'re we cookin\' today?',
            subtitle: 'Code, homework, dinner plans, or just some company. Pull up a chair.',
            suggestions: [
                'Help me plan Sunday dinner for eight',
                'Explain recursion like I\'m one of your line cooks',
                'What\'s going on in the news today?',
                'Help me write a toast for my cousin\'s wedding',
            ],
        },
    },
    claudia: {
        id: 'claudia',
        name: 'Claudia',
        he: 'she',
        him: 'her',
        avatar: 'assets/claudia-avatar.jpg',
        avatarAlt: 'Illustrated portrait of Claudia, an older woman with curly gray hair, gold-rimmed glasses and a warm smile',
        themeColor: { light: '#f3eee4', dark: '#1b1a17' },
        welcome: {
            greeting: 'Ciao, bella! Come on in.',
            subtitle: 'Code, homework, recipes, or a second opinion. Sit, I\'ll put coffee on.',
            suggestions: [
                'How do I keep cannoli shells from going soggy?',
                'Walk me through Git branches like it\'s a recipe',
                'What\'s happening in the news today?',
                'Help me write a birthday card for my Nonna',
            ],
        },
    },
};

export const PERSONA_IDS = Object.keys(PERSONAS);

export function personaOf(id) {
    return PERSONAS[id] || PERSONAS.claudio;
}

let current = 'claudio';
try {
    const saved = localStorage.getItem('claudio.persona');
    if (PERSONAS[saved]) current = saved;
} catch {}

const listeners = new Set();

export function persona() {
    return PERSONAS[current];
}

export function onPersonaChange(fn) {
    listeners.add(fn);
}

/** Switch the page's character: data attribute for the theme, plus the remembered choice. */
export function setPersona(id) {
    const next = PERSONAS[id] ? id : 'claudio';
    current = next;
    document.documentElement.dataset.persona = next;
    try { localStorage.setItem('claudio.persona', next); } catch {}
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
        m.setAttribute('content', m.media.includes('dark') ? PERSONAS[next].themeColor.dark : PERSONAS[next].themeColor.light);
    });
    listeners.forEach((fn) => fn(PERSONAS[next]));
}

export function otherPersona() {
    return current === 'claudio' ? 'claudia' : 'claudio';
}
