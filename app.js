import { marked } from 'https://cdn.jsdelivr.net/npm/marked@15.0.12/lib/marked.esm.js';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.4.16/dist/purify.es.mjs';
import hljs from 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.12.0/es/highlight.min.js';
import * as store from './store.js';
import * as acct from './account.js';

// ---------- Config ----------

const CHAT_URL = `${acct.API_BASE}/claudioChat`;

const MAX_IMAGE_SIDE = 1568;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = 28 * 1024 * 1024;

marked.setOptions({ gfm: true, breaks: false });

// ---------- Elements ----------

const $ = (id) => document.getElementById(id);
const app = $('app');
const scroller = $('scroller');
const thread = $('thread');
const empty = $('empty');
const form = $('composer');
const input = $('input');
const sendBtn = $('send');
const thinkBtn = $('think');
const attachBtn = $('attach');
const fileInput = $('file-input');
const attachmentsEl = $('attachments');
const chatList = $('chat-list');
const chatTitle = $('chat-title');
const jumpBtn = $('jump');

// ---------- State ----------

let chat = null;            // { id, title, createdAt, updatedAt, messages: [{role, content, ...}] }
let pending = [];           // attachments waiting in the composer: { kind, name, block, preview }
let controller = null;      // AbortController for the in-flight request
let stickToBottom = true;

// ---------- Icons ----------

const icon = (path, extra = '') => `<svg viewBox="0 0 24 24" ${extra}>${path}</svg>`;
const ICONS = {
    copy: icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>'),
    check: icon('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    retry: icon('<path d="M4 12a8 8 0 0113.7-5.6L20 8.7M20 4v4.7h-4.7M20 12a8 8 0 01-13.7 5.6L4 15.3M4 20v-4.7h4.7"/>'),
    edit: icon('<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/>'),
    trash: icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/>'),
    chevron: icon('<path d="M9 6l6 6-6 6"/>'),
    search: icon('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
    globe: icon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>'),
    file: icon('<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/><path d="M14 3v5h5"/>'),
    x: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
};

// ---------- Helpers ----------

function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
}

function toast(text) {
    const t = el('div', 'toast');
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
}

async function copyText(text, btn) {
    try {
        await navigator.clipboard.writeText(text);
        if (btn) {
            const prev = btn.innerHTML;
            btn.innerHTML = ICONS.check;
            setTimeout(() => { btn.innerHTML = prev; }, 1400);
        }
    } catch {
        toast('Couldn\'t copy that.');
    }
}

function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

function hostname(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function renderMarkdown(target, text) {
    target.innerHTML = DOMPurify.sanitize(marked.parse(text), { ADD_ATTR: ['target'] });
    target.querySelectorAll('a[href]').forEach((a) => {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
    });
    target.querySelectorAll('pre > code').forEach((code) => {
        const pre = code.parentElement;
        const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1] || '';
        if (lang && hljs.getLanguage(lang)) {
            code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
            code.classList.add('hljs');
        }
        const wrap = el('div', 'code-block');
        const head = el('div', 'code-head');
        const label = el('span');
        label.textContent = lang || 'text';
        const btn = el('button', '', `${ICONS.copy}<span>Copy</span>`);
        btn.type = 'button';
        btn.addEventListener('click', async () => {
            await navigator.clipboard.writeText(code.textContent).catch(() => {});
            btn.innerHTML = `${ICONS.check}<span>Copied</span>`;
            setTimeout(() => { btn.innerHTML = `${ICONS.copy}<span>Copy</span>`; }, 1400);
        });
        head.append(label, btn);
        pre.replaceWith(wrap);
        wrap.append(head, pre);
    });
}

// ---------- Scrolling ----------

function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
}

function scrollToBottom(force = false) {
    if (force || stickToBottom) {
        scroller.scrollTop = scroller.scrollHeight;
    }
}

scroller.addEventListener('scroll', () => {
    stickToBottom = nearBottom();
    jumpBtn.hidden = stickToBottom || !chat?.messages.length;
});

jumpBtn.addEventListener('click', () => {
    stickToBottom = true;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
});

// ---------- Assistant rendering ----------
//
// An assistant turn is a list of content blocks (thinking, server_tool_use, text with
// citations, ...). We render it as segments: a collapsible thinking section, a tool
// activity line, or a run of markdown text. The same builder handles live streaming
// and messages loaded from storage.

class BotView {
    constructor(container) {
        this.root = container;
        this.body = container.querySelector('.bot-body');
        this.content = el('div', 'bot-content');
        this.body.appendChild(this.content);
        this.segments = [];
        this.sources = new Map();
        this.frame = 0;
        this.typing = null;
    }

    last() {
        return this.segments[this.segments.length - 1];
    }

    showTyping() {
        if (this.typing) return;
        this.typing = el('div', 'typing', '<i></i><i></i><i></i>');
        this.content.appendChild(this.typing);
    }

    hideTyping() {
        this.typing?.remove();
        this.typing = null;
    }

    startThinking(live) {
        this.hideTyping();
        if (this.last()?.kind === 'thinking') return;
        const node = el('details', 'thinking' + (live ? ' live' : ''));
        node.innerHTML = `<summary>${ICONS.chevron}<span>${live ? 'Mullin\' it over…' : 'Claudio\'s thoughts'}</span></summary><div class="thinking-text"></div>`;
        this.content.appendChild(node);
        this.segments.push({ kind: 'thinking', node, text: '' });
    }

    addThinking(text) {
        if (this.last()?.kind !== 'thinking') this.startThinking(true);
        const seg = this.last();
        seg.text += text;
        seg.node.querySelector('.thinking-text').textContent = seg.text;
    }

    settleThinking() {
        for (const seg of this.segments) {
            if (seg.kind === 'thinking' && seg.node.classList.contains('live')) {
                seg.node.classList.remove('live');
                seg.node.querySelector('summary span').textContent = 'Claudio\'s thoughts';
            }
        }
    }

    startText() {
        this.hideTyping();
        this.settleThinking();
        if (this.last()?.kind === 'text') return;
        const node = el('div', 'md');
        this.content.appendChild(node);
        this.segments.push({ kind: 'text', node, text: '' });
    }

    addText(text) {
        if (this.last()?.kind !== 'text') this.startText();
        this.last().text += text;
        this.scheduleRender();
    }

    scheduleRender() {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            const seg = this.last();
            if (seg?.kind === 'text') renderMarkdown(seg.node, seg.text);
            scrollToBottom();
        });
    }

    addTool(name, toolInput) {
        this.hideTyping();
        this.settleThinking();
        let label;
        let ico = ICONS.search;
        if (name === 'web_search') {
            label = `Askin' around: “${toolInput?.query ?? '…'}”`;
        } else if (name === 'web_fetch') {
            ico = ICONS.globe;
            label = `Readin' up on ${toolInput?.url ? hostname(toolInput.url) : 'a page'}`;
        } else {
            label = 'Workin\' on it';
        }
        const node = el('div', 'tool-line', `${ico}<span></span>`);
        node.querySelector('span').textContent = label;
        this.content.appendChild(node);
        this.segments.push({ kind: 'tool', node });
    }

    addCitations(citations) {
        for (const c of citations || []) {
            if (c.url && !this.sources.has(c.url)) this.sources.set(c.url, c.title || hostname(c.url));
        }
    }

    finish() {
        this.hideTyping();
        this.settleThinking();
        if (this.frame) {
            cancelAnimationFrame(this.frame);
            this.frame = 0;
        }
        for (const seg of this.segments) {
            if (seg.kind === 'text') renderMarkdown(seg.node, seg.text);
        }
        this.body.querySelector('.sources')?.remove();
        if (this.sources.size) {
            const wrap = el('div', 'sources');
            let i = 1;
            for (const [url, title] of this.sources) {
                const a = el('a', 'source');
                a.href = url;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.title = title;
                a.innerHTML = `<b>${i++}</b><span></span>`;
                a.querySelector('span').textContent = `${title} · ${hostname(url)}`;
                wrap.appendChild(a);
            }
            this.body.appendChild(wrap);
        }
    }

    text() {
        return this.segments.filter((s) => s.kind === 'text').map((s) => s.text).join('\n\n').trim();
    }

    renderBlocks(blocks) {
        for (const block of blocks || []) {
            if (block.type === 'thinking' && block.thinking) {
                this.startThinking(false);
                this.addThinking(block.thinking);
            } else if (block.type === 'server_tool_use') {
                this.addTool(block.name, block.input);
            } else if (block.type === 'text' && block.text) {
                if (this.last()?.kind !== 'text') this.startText();
                this.last().text += block.text;
                if (block.citations) this.addCitations(block.citations);
            }
        }
        this.finish();
    }
}

function botShell() {
    const node = el('div', 'msg bot');
    node.innerHTML = '<img src="assets/claudio-avatar.jpg" alt="" class="avatar"><div class="bot-body"></div>';
    thread.appendChild(node);
    return node;
}

function addActions(node, actions) {
    node.querySelector('.msg-actions')?.remove();
    const bar = el('div', 'msg-actions');
    for (const { label, svg, onClick } of actions) {
        const b = el('button', 'icon-btn', svg);
        b.type = 'button';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.addEventListener('click', () => onClick(b));
        bar.appendChild(b);
    }
    (node.querySelector('.bot-body') || node).appendChild(bar);
}

// ---------- User rendering ----------

function userText(content) {
    if (typeof content === 'string') return content;
    return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function renderUser(message, index) {
    const node = el('div', 'msg user');
    node.dataset.index = index;
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    const files = blocks.filter((b) => b.type === 'image' || b.type === 'document');
    if (files.length) {
        const wrap = el('div', 'user-files');
        for (const f of files) {
            if (f.type === 'image') {
                const img = el('img');
                img.src = `data:${f.source.media_type};base64,${f.source.data}`;
                img.alt = 'Attached image';
                img.addEventListener('click', () => openLightbox(img.src));
                wrap.appendChild(img);
            } else {
                const chip = el('div', 'file-chip', `${ICONS.file}<span></span>`);
                chip.querySelector('span').textContent = f.title || 'Document';
                wrap.appendChild(chip);
            }
        }
        node.appendChild(wrap);
    }
    const text = userText(message.content);
    if (text) {
        const bubble = el('div', 'user-bubble');
        bubble.textContent = text;
        node.appendChild(bubble);
    }
    addActions(node, [
        { label: 'Edit', svg: ICONS.edit, onClick: () => startEdit(node, index) },
        { label: 'Copy', svg: ICONS.copy, onClick: (b) => copyText(text, b) },
    ]);
    thread.appendChild(node);
    return node;
}

function openLightbox(src) {
    const box = el('div', 'lightbox');
    const img = el('img');
    img.src = src;
    box.appendChild(img);
    box.addEventListener('click', () => box.remove());
    document.body.appendChild(box);
}

function startEdit(node, index) {
    if (controller) return;
    const message = chat.messages[index];
    const box = el('div', 'edit-box');
    const ta = el('textarea');
    ta.value = userText(message.content);
    ta.rows = Math.min(10, ta.value.split('\n').length + 1);
    const actions = el('div', 'edit-actions');
    const cancel = el('button', '', 'Cancel');
    const save = el('button', 'primary', 'Send');
    cancel.type = save.type = 'button';
    actions.append(cancel, save);
    box.append(ta, actions);
    const bubble = node.querySelector('.user-bubble');
    const bar = node.querySelector('.msg-actions');
    if (bubble) bubble.replaceWith(box);
    else node.insertBefore(box, bar);
    bar.hidden = true;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    cancel.addEventListener('click', () => renderChat());
    const submit = () => {
        const text = ta.value.trim();
        const files = typeof message.content === 'string' ? [] : message.content.filter((b) => b.type !== 'text');
        if (!text && !files.length) return;
        // Editing forks the conversation: everything after this message is dropped,
        // so earlier turns (and their thinking blocks) stay byte-for-byte the same.
        chat.messages = chat.messages.slice(0, index);
        chat.messages.push({ role: 'user', content: [...files, ...(text ? [{ type: 'text', text }] : [])] });
        renderChat({ showUnanswered: false });
        respond();
    };
    save.addEventListener('click', submit);
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            submit();
        } else if (e.key === 'Escape') {
            renderChat();
        }
    });
}

// ---------- Chat rendering ----------

function renderChat({ showUnanswered = true } = {}) {
    thread.innerHTML = '';
    const messages = chat?.messages || [];
    empty.hidden = messages.length > 0;
    chatTitle.textContent = chat?.title || 'New chat';
    document.title = chat?.title ? `${chat.title} · Claudio` : 'Claudio';

    messages.forEach((m, i) => {
        if (m.role === 'user') {
            renderUser(m, i);
        } else {
            const node = botShell();
            const view = new BotView(node);
            view.renderBlocks(m.content);
            if (m.note) appendNotice(view.body, m.note);
            botActions(node, view, i);
        }
    });

    const lastMsg = messages[messages.length - 1];
    if (showUnanswered && lastMsg?.role === 'user' && !controller) {
        // The last request never got an answer (error, closed tab, stopped early).
        const node = botShell();
        appendNotice(node.querySelector('.bot-body'), 'Claudio didn\'t get to answer this one.', true);
    }
    markLast();
    requestAnimationFrame(() => scrollToBottom(true));
}

function markLast() {
    thread.querySelectorAll('.msg.last').forEach((n) => n.classList.remove('last'));
    thread.lastElementChild?.classList.add('last');
}

function botActions(node, view, index) {
    const isLast = index === chat.messages.length - 1;
    const actions = [{ label: 'Copy', svg: ICONS.copy, onClick: (b) => copyText(view.text(), b) }];
    if (isLast) actions.push({ label: 'Regenerate', svg: ICONS.retry, onClick: regenerate });
    addActions(node, actions);
}

function appendNotice(parent, text, retry = false, error = false, action = null) {
    const n = el('div', 'notice' + (error ? ' error' : ''));
    const span = el('span');
    span.textContent = text;
    n.appendChild(span);
    if (action) {
        const b = el('button', 'retry-btn', '');
        b.textContent = action.label;
        b.type = 'button';
        b.addEventListener('click', action.onClick);
        n.appendChild(b);
    }
    if (retry) {
        const b = el('button', 'retry-btn', 'Try again');
        b.type = 'button';
        b.addEventListener('click', () => {
            n.closest('.msg')?.remove();
            respond();
        });
        n.appendChild(b);
    }
    parent.appendChild(n);
    return n;
}

function regenerate() {
    if (controller) return;
    const lastMsg = chat.messages[chat.messages.length - 1];
    if (lastMsg?.role === 'assistant') chat.messages.pop();
    renderChat({ showUnanswered: false });
    respond();
}

// ---------- Sidebar ----------

async function renderSidebar() {
    const chats = await store.listChats();
    chatList.innerHTML = '';
    if (!chats.length) return;
    chatList.appendChild(Object.assign(el('div', 'chat-list-label'), { textContent: 'Recent' }));
    for (const c of chats) {
        const item = el('div', 'chat-item' + (c.id === chat?.id ? ' active' : ''));
        const a = el('a');
        a.href = `#${c.id}`;
        a.textContent = c.title || 'Untitled';
        a.addEventListener('click', (e) => {
            e.preventDefault();
            openChat(c.id);
            closeSidebarOnMobile();
        });
        const del = el('button', 'delete', ICONS.trash);
        del.type = 'button';
        del.setAttribute('aria-label', `Delete ${c.title || 'chat'}`);
        del.addEventListener('click', async () => {
            if (!confirm(`Delete “${c.title || 'this chat'}”?`)) return;
            await store.deleteChat(c.id);
            if (c.id === chat?.id) newChat();
            else renderSidebar();
        });
        item.append(a, del);
        chatList.appendChild(item);
    }
}

async function openChat(id) {
    if (controller) controller.abort();
    const found = await store.getChat(id);
    if (!found) return newChat();
    chat = found;
    history.replaceState(null, '', `#${id}`);
    renderChat();
    renderSidebar();
    input.focus();
}

function newChat() {
    if (controller) controller.abort();
    chat = null;
    pending = [];
    renderAttachments();
    history.replaceState(null, '', location.pathname + location.search);
    renderChat();
    renderSidebar();
    closeSidebarOnMobile();
    input.focus();
}

function isMobile() {
    return matchMedia('(max-width: 820px)').matches;
}

function closeSidebarOnMobile() {
    app.classList.remove('sidebar-open');
}

$('toggle-sidebar').addEventListener('click', () => {
    if (isMobile()) app.classList.toggle('sidebar-open');
    else {
        app.classList.toggle('sidebar-collapsed');
        try { localStorage.setItem('claudio.sidebar', app.classList.contains('sidebar-collapsed') ? 'collapsed' : 'open'); } catch {}
    }
});
$('close-sidebar').addEventListener('click', closeSidebarOnMobile);
$('scrim').addEventListener('click', closeSidebarOnMobile);
$('new-chat').addEventListener('click', newChat);
$('new-chat-top').addEventListener('click', newChat);

// ---------- Attachments ----------

function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
    });
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

async function imageBlock(file) {
    const dataUrl = await readAsDataURL(file);
    const img = await loadImage(dataUrl);
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    // Small enough already: send as-is (keeps GIF/PNG/WebP intact).
    if (longest <= MAX_IMAGE_SIDE && file.size < 1.5 * 1024 * 1024) {
        return { type: 'image', source: { type: 'base64', media_type: file.type, data: dataUrl.split(',')[1] } };
    }
    const scale = Math.min(1, MAX_IMAGE_SIDE / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL('image/jpeg', 0.86);
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: out.split(',')[1] } };
}

const TEXT_EXT = /\.(txt|md|csv|json|js|ts|jsx|tsx|py|java|c|cpp|h|go|rs|rb|php|html|css|sql|ya?ml|xml|sh|log)$/i;

async function addFiles(fileList) {
    for (const file of fileList) {
        try {
            if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
                const block = await imageBlock(file);
                pending.push({ kind: 'image', name: file.name, block });
            } else if (file.type === 'application/pdf') {
                if (file.size > MAX_PDF_BYTES) {
                    toast(`${file.name} is too big. PDFs up to 10 MB.`);
                    continue;
                }
                const data = (await readAsDataURL(file)).split(',')[1];
                pending.push({
                    kind: 'file', name: file.name,
                    block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: file.name },
                });
            } else if (file.type.startsWith('text/') || TEXT_EXT.test(file.name)) {
                if (file.size > MAX_TEXT_BYTES) {
                    toast(`${file.name} is too big. Text files up to 512 KB.`);
                    continue;
                }
                const text = await file.text();
                pending.push({
                    kind: 'file', name: file.name,
                    block: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: text }, title: file.name },
                });
            } else {
                toast(`Claudio can't read ${file.name}. Try an image, PDF, or text file.`);
            }
        } catch (err) {
            console.error(err);
            toast(`Couldn't read ${file.name}.`);
        }
    }
    renderAttachments();
    updateSend();
}

function renderAttachments() {
    attachmentsEl.innerHTML = '';
    pending.forEach((p, i) => {
        const node = el('div', 'attachment');
        if (p.kind === 'image') {
            const img = el('img');
            img.src = `data:${p.block.source.media_type};base64,${p.block.source.data}`;
            img.alt = p.name;
            node.appendChild(img);
        } else {
            const chip = el('div', 'file-chip', `${ICONS.file}<span></span>`);
            chip.querySelector('span').textContent = p.name;
            node.appendChild(chip);
        }
        const rm = el('button', 'remove', ICONS.x);
        rm.type = 'button';
        rm.setAttribute('aria-label', `Remove ${p.name}`);
        rm.addEventListener('click', () => {
            pending.splice(i, 1);
            renderAttachments();
            updateSend();
        });
        node.appendChild(rm);
        attachmentsEl.appendChild(node);
    });
}

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
    addFiles([...fileInput.files]);
    fileInput.value = '';
});

input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
        e.preventDefault();
        addFiles(files);
    }
});

const overlay = $('drop-overlay');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    dragDepth++;
    overlay.classList.add('show');
});
window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.classList.remove('show');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.remove('show');
    if (e.dataTransfer?.files.length) addFiles([...e.dataTransfer.files]);
});

// ---------- Composer ----------

function autosize() {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
}

function updateSend() {
    sendBtn.disabled = !controller && !input.value.trim() && !pending.length;
}

input.addEventListener('input', () => {
    autosize();
    updateSend();
});

input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isMobile()) {
        e.preventDefault();
        form.requestSubmit();
    }
});

let effort = 'low';
try { effort = localStorage.getItem('claudio.effort') === 'high' ? 'high' : 'low'; } catch {}
thinkBtn.setAttribute('aria-pressed', String(effort === 'high'));
thinkBtn.addEventListener('click', () => {
    effort = effort === 'high' ? 'low' : 'high';
    thinkBtn.setAttribute('aria-pressed', String(effort === 'high'));
    try { localStorage.setItem('claudio.effort', effort); } catch {}
});

$('suggestions').addEventListener('click', (e) => {
    const b = e.target.closest('.suggestion');
    if (!b) return;
    input.value = b.textContent;
    autosize();
    form.requestSubmit();
});

// Today's greeting and suggestions, written by Claude once a day on the server. The static
// ones in index.html stay if this is slow or fails.
async function loadWelcome() {
    try {
        const res = await fetch(`${acct.API_BASE}/api/welcome`, { signal: AbortSignal.timeout(1500) });
        const { welcome } = await res.json();
        if (welcome) {
            $('empty-title').textContent = welcome.greeting;
            $('empty-sub').textContent = welcome.subtitle;
            $('suggestions').replaceChildren(...welcome.suggestions.map((text) => {
                const b = el('button', 'suggestion');
                b.type = 'button';
                b.textContent = text;
                return b;
            }));
        }
    } catch {
        // keep the defaults
    } finally {
        empty.classList.remove('loading');
    }
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (controller) {
        controller.abort();
        return;
    }
    const text = input.value.trim();
    if (!text && !pending.length) return;

    if (!chat) {
        const title = (text || pending[0]?.name || 'New chat').replace(/\s+/g, ' ').slice(0, 60);
        chat = { id: uid(), title, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
        history.replaceState(null, '', `#${chat.id}`);
    }

    const content = [...pending.map((p) => p.block)];
    if (text) content.push({ type: 'text', text });
    chat.messages.push({ role: 'user', content });

    input.value = '';
    pending = [];
    renderAttachments();
    autosize();

    empty.hidden = true;
    chatTitle.textContent = chat.title;
    thread.querySelector('.msg.bot:last-child .notice')?.closest('.msg')?.remove();
    renderUser(chat.messages[chat.messages.length - 1], chat.messages.length - 1);
    stickToBottom = true;
    scrollToBottom(true);
    await respond();
});

// ---------- Talking to the backend ----------

function apiMessages() {
    return chat.messages.map(({ role, content }) => ({ role, content }));
}

async function save() {
    chat.updatedAt = Date.now();
    try {
        await store.putChat(chat);
    } catch (err) {
        console.error(err);
        toast('Couldn\'t save this chat on your device.');
    }
    renderSidebar();
}

async function respond() {
    await save();
    const body = JSON.stringify({ messages: apiMessages(), effort, apiKey: acct.browserKey()?.key });
    const node = botShell();
    const view = new BotView(node);
    view.showTyping();
    markLast();
    scrollToBottom();

    if (body.length > MAX_REQUEST_BYTES) {
        view.hideTyping();
        appendNotice(view.body, 'This conversation got too big to send (too many files). Start a new chat and bring the important stuff.', false, true);
        return;
    }

    controller = new AbortController();
    form.classList.add('busy');
    sendBtn.setAttribute('aria-label', 'Stop');
    updateSend();

    const chatAtStart = chat;
    let result = null;
    let errorText = null;
    let errorCode = null;

    try {
        const res = await fetch(CHAT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${await acct.idToken()}`,
            },
            body,
            signal: controller.signal,
        });
        if (!res.ok || !res.body) {
            const data = await res.json().catch(() => ({}));
            const err = new Error(data.error || `The kitchen sent back a ${res.status}.`);
            err.code = data.code;
            err.fromServer = true;
            throw err;
        }

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let cut;
            while ((cut = buffer.indexOf('\n\n')) !== -1) {
                const raw = buffer.slice(0, cut);
                buffer = buffer.slice(cut + 2);
                const line = raw.split('\n').find((l) => l.startsWith('data: '));
                if (!line) continue;
                const event = JSON.parse(line.slice(6));
                switch (event.type) {
                    case 'thinking_start': view.startThinking(true); break;
                    case 'thinking': view.addThinking(event.text); break;
                    case 'text_start': view.startText(); break;
                    case 'text': view.addText(event.text); break;
                    case 'tool': view.addTool(event.name, event.input); break;
                    case 'citations': view.addCitations(event.citations); break;
                    case 'done':
                        result = event;
                        acct.noteAllowanceUsed(event.allowanceUsedPercent);
                        break;
                    case 'error':
                        errorText = event.message;
                        errorCode = event.code;
                        break;
                }
                scrollToBottom();
            }
        }
        if (!result && !errorText) errorText = 'The line went dead before Claudio finished.';
    } catch (err) {
        if (err.name !== 'AbortError') {
            if (!err.fromServer) console.error(err);
            errorCode = err.code;
            errorText = err.fromServer ? err.message : 'Couldn\'t reach Claudio. Check your connection and try again.';
        }
    } finally {
        controller = null;
        form.classList.remove('busy');
        sendBtn.setAttribute('aria-label', 'Send');
        updateSend();
    }

    // The user switched chats mid-answer; the response belongs to a chat no longer on screen.
    if (chat !== chatAtStart) return;

    view.finish();
    const partial = view.text();

    if (result) {
        if (result.stop_reason === 'refusal') {
            // Keep only plain text from a declined turn so history stays valid to resend.
            const note = 'Claudio had to pass on that one. Try asking a different way.';
            chat.messages.push({ role: 'assistant', content: partial ? [{ type: 'text', text: partial }] : [{ type: 'text', text: '(declined)' }], note });
            appendNotice(view.body, note);
        } else {
            chat.messages.push({ role: 'assistant', content: result.content });
            if (result.stop_reason === 'max_tokens') {
                const note = 'Claudio ran out of room on that answer. Ask him to keep going.';
                chat.messages[chat.messages.length - 1].note = note;
                appendNotice(view.body, note);
            }
        }
        await save();
        node.remove();
        renderChat();
        return;
    }

    if (errorText) {
        if (!partial) view.content.innerHTML = '';
        const access = accessAction(errorCode, errorText);
        if (access) {
            acct.refreshAccount();
            appendNotice(view.body, access.notice, false, false, { label: access.label, onClick: access.open });
            access.open();
        } else {
            appendNotice(view.body, errorText, true, true);
        }
        markLast();
        return;
    }

    // Stopped by the user. Thinking blocks from an unfinished turn can't be sent back,
    // so keep just the text he'd written so far.
    if (partial) {
        chat.messages.push({ role: 'assistant', content: [{ type: 'text', text: partial }], note: 'Stopped.' });
        await save();
        node.remove();
        renderChat();
    } else {
        view.content.innerHTML = '';
        appendNotice(view.body, 'Stopped.', true);
        markLast();
    }
}

// ---------- Access (trial, keys, subscription) ----------

// Errors that mean "you need a way to pay for this", and what to offer for each.
function accessAction(code, message) {
    switch (code) {
        case 'TRIAL_USED':
            return { notice: 'That\'s the end of the free tasting menu.', label: 'Keep going', open: () => acct.openPaywall(message) };
        case 'MONTHLY_LIMIT':
            return { notice: message, label: 'Options', open: () => acct.openAccount() };
        case 'BAD_KEY':
        case 'KEY_PROBLEM':
        case 'BAD_SAVED_KEY':
            return { notice: message, label: 'Update key', open: () => acct.openKeyDialog({ error: message }) };
        default:
            return null;
    }
}

// After the user adds a key or subscribes, answer the message that was waiting.
acct.onAccessGranted(() => {
    if (controller || !chat) return;
    const lastMsg = chat.messages[chat.messages.length - 1];
    if (lastMsg?.role !== 'user') return;
    renderChat({ showUnanswered: false });
    respond();
});

const accountBtn = $('account-btn');
function renderAccountButton() {
    const name = acct.displayName();
    accountBtn.querySelector('.account-initial').textContent = name === 'Guest' ? '?' : name[0].toUpperCase();
    accountBtn.querySelector('.account-name').textContent = name;
    accountBtn.querySelector('.account-status').textContent = acct.statusLine();
}
acct.onAccountChange(renderAccountButton);
accountBtn.addEventListener('click', () => {
    closeSidebarOnMobile();
    acct.openAccount();
});

// ---------- Boot ----------

try {
    if (localStorage.getItem('claudio.sidebar') === 'collapsed' && !isMobile()) app.classList.add('sidebar-collapsed');
} catch {}

renderAccountButton();
acct.handleCheckoutReturn(toast);
loadWelcome();

const startId = location.hash.slice(1);
if (startId) openChat(startId);
else newChat();
