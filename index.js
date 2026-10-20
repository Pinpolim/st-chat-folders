/*
 * Chat Folders (Welcome Screen)
 * Replaces the flat "Recent Chats" list on SillyTavern's welcome screen with
 * collapsible folders grouped by character / group.
 */
import * as ST from '../../../../script.js';
import * as Groups from '../../../group-chats.js';
import { extension_settings } from '../../../extensions.js';
import { power_user } from '../../../power-user.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { timestampToMoment } from '../../../utils.js';
import * as Welcome from '../../../welcome-screen.js';

const MODULE = 'chatFolders';
const LOG = '[Chat Folders]';

const DEFAULTS = Object.freeze({
    enabled: true,
    maxChats: 300,          // how many chat files to scan (most recent first)
    layout: 'list',         // 'list' | 'grid'
    sort: 'recent',         // 'recent' | 'name'
    showPreview: true,      // last message snippet under each chat
    showPersona: true,      // persona avatar under chat title
    stripCharName: true,    // "Aria - Road trip" -> "Road trip" inside Aria's folder
    inferPersona: true,     // fall back to character-connected / default persona when chat has no lock
    hideGreeting: true,     // hide the welcome assistant greeting + hint message
    hidePromptButtons: true,// hide the API Connections / Character Management / Extensions buttons
    hideInput: true,        // hide the chat input bar while on the welcome page
    logoStyle: 'emboss',    // 'emboss' | 'deboss' | 'mono' | 'original'
    versionFooter: true,    // move "SillyTavern x.y.z" to a faded footer at the bottom
    assistantButton: true,  // replace "Temporary Chat" with "new chat with your assistant"
    expanded: [],           // folder keys that are open
    pinned: [],             // folder keys pinned to top
});

/** @returns {typeof DEFAULTS} */
function settings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(DEFAULTS);
    }
    const s = extension_settings[MODULE];
    // one-time migration from v0.2
    if (s.monoLogo !== undefined) {
        if (s.logoStyle === undefined) s.logoStyle = s.monoLogo ? 'emboss' : 'original';
        if (!s.hideGreeting) s.hideGreeting = true;
        delete s.monoLogo;
    }
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    return s;
}

const save = () => ST.saveSettingsDebounced();

// ---------- helpers ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));

function thumb(type, file) {
    return typeof ST.getThumbnailUrl === 'function'
        ? ST.getThumbnailUrl(type, file)
        : `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`;
}

function toMoment(ts) {
    try {
        return timestampToMoment(ts);
    } catch {
        return null;
    }
}

function momentValue(ts) {
    const m = toMoment(ts);
    return m && m.isValid() ? m.valueOf() : 0;
}

/** Remembers which folders are open / pinned. */
function toggleListItem(listName, key, on) {
    const s = settings();
    const set = new Set(s[listName]);
    on ? set.add(key) : set.delete(key);
    s[listName] = [...set];
    save();
}

// ---------- data ----------

/**
 * Fetches recent chats from the server, including chat metadata (for persona locks).
 * @returns {Promise<any[]>}
 */
async function fetchChats() {
    const response = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: ST.getRequestHeaders(),
        body: JSON.stringify({ max: settings().maxChats, pinned: [], metadata: true }),
        cache: 'no-cache',
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : [];
}

/**
 * Groups chats into folders keyed by character avatar or group id.
 */
function buildFolders(chats) {
    /** @type {Map<string, any>} */
    const folders = new Map();
    const s = settings();

    for (const chat of chats) {
        if (!chat?.file_name) continue;
        let key, folder;
        if (chat.group) {
            const group = Groups.groups.find(g => g.id === chat.group);
            if (!group) continue;
            key = `g:${group.id}`;
            folder = folders.get(key) ?? { key, isGroup: true, id: group.id, entity: group, name: group.name, chats: [] };
        } else if (chat.avatar) {
            const character = ST.characters.find(c => c.avatar === chat.avatar);
            if (!character) continue;
            key = `c:${character.avatar}`;
            folder = folders.get(key) ?? { key, isGroup: false, id: character.avatar, entity: character, name: character.name, chats: [] };
        } else {
            continue; // loose chats (e.g. temporary) have no folder
        }
        chat.chat_name = String(chat.file_name).replace(/\.jsonl$/, '');
        chat._ts = momentValue(chat.last_mes);
        folder.chats.push(chat);
        folders.set(key, folder);
    }

    const list = [...folders.values()];
    for (const f of list) {
        f.chats.sort((a, b) => b._ts - a._ts);
        f.last = f.chats[0]?._ts ?? 0;
        f.pinned = s.pinned.includes(f.key);
    }
    list.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (s.sort === 'name') return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        return b.last - a.last;
    });
    return list;
}

/**
 * Works out which persona belongs to a chat.
 * Priority: persona locked to the chat > persona connected to the character/group > default persona.
 */
function resolvePersona(chat, folder) {
    const personas = power_user?.personas ?? {};
    const exists = (avatar) => avatar && Object.hasOwn(personas, avatar);

    const locked = chat.chat_metadata?.persona;
    if (exists(locked)) return { avatar: locked, source: 'chat' };

    if (!settings().inferPersona) return null;

    const type = folder.isGroup ? 'group' : 'character';
    const connected = Object.entries(power_user?.persona_descriptions ?? {})
        .filter(([avatar, d]) => exists(avatar) && d?.connections?.some(c => c.type === type && c.id === folder.id))
        .map(([avatar]) => avatar);
    if (connected.length) return { avatar: connected[0], source: 'character', extra: connected.length - 1 };

    if (exists(power_user?.default_persona)) return { avatar: power_user.default_persona, source: 'default' };
    return null;
}

// ---------- actions ----------

function characterIndex(avatar) {
    return ST.characters.findIndex(c => c.avatar === avatar);
}

async function openChat(folder, chatName) {
    try {
        if (folder.isGroup) {
            await Groups.openGroupById(folder.id);
            if (ST.getCurrentChatId() !== chatName) await Groups.openGroupChat(folder.id, chatName);
        } else {
            const id = characterIndex(folder.id);
            if (id < 0) throw new Error('Character not found');
            await ST.selectCharacterById(id);
            if (ST.getCurrentChatId() !== chatName) await ST.openCharacterChat(chatName);
        }
    } catch (err) {
        console.error(LOG, 'open failed', err);
        toastr.error('Could not open chat. See console for details.');
    }
}

async function newChat(folder) {
    try {
        if (folder.isGroup) {
            await Groups.openGroupById(folder.id);
            await Groups.createNewGroupChat(folder.id);
        } else {
            const id = characterIndex(folder.id);
            if (id < 0) throw new Error('Character not found');
            await ST.selectCharacterById(id);
            await ST.doNewChat({ deleteCurrentChat: false });
        }
    } catch (err) {
        console.error(LOG, 'new chat failed', err);
        toastr.error('Could not start a new chat. See console for details.');
    }
}

async function renameChat(folder, chatName, root) {
    const newName = await callGenericPopup('Enter the new name for this chat:', POPUP_TYPE.INPUT, chatName);
    if (!newName || typeof newName !== 'string' || newName === chatName) return;
    try {
        if (folder.isGroup) {
            await ST.renameGroupOrCharacterChat({ groupId: folder.id, oldFileName: chatName, newFileName: newName, loader: false });
        } else {
            const id = characterIndex(folder.id);
            await ST.renameGroupOrCharacterChat({ characterId: String(id), oldFileName: chatName, newFileName: newName, loader: false });
            if (typeof ST.updateRemoteChatName === 'function') await ST.updateRemoteChatName(id, newName);
        }
        toastr.success('Chat renamed.');
        await refreshRoot(root);
    } catch (err) {
        console.error(LOG, 'rename failed', err);
        toastr.error('Could not rename chat. See console for details.');
    }
}

async function deleteChat(folder, chatName, root) {
    const ok = await callGenericPopup(`Delete the chat <b>${esc(chatName)}</b>?<br><small>This cannot be undone.</small>`, POPUP_TYPE.CONFIRM);
    if (!ok) return;
    try {
        if (folder.isGroup) {
            await Groups.deleteGroupChatByName(folder.id, chatName);
        } else {
            await ST.deleteCharacterChatByName(String(characterIndex(folder.id)), chatName);
        }
        toastr.success('Chat deleted.');
        await refreshRoot(root);
    } catch (err) {
        console.error(LOG, 'delete failed', err);
        toastr.error('Could not delete chat. See console for details.');
    }
}

// ---------- rendering ----------

function folderAvatarHtml(folder) {
    if (folder.isGroup) return '<div class="chf-avatar chf-group-avatar"></div>';
    return `<div class="chf-avatar"><img src="${esc(thumb('avatar', folder.entity.avatar))}" alt="" loading="lazy"></div>`;
}

function personaHtml(chat, folder) {
    if (!settings().showPersona) return '';
    const p = resolvePersona(chat, folder);
    if (!p) return '';
    const name = power_user.personas[p.avatar] || p.avatar;
    const why = {
        chat: 'Persona locked to this chat',
        character: 'Persona connected to this character (chat has no lock)',
        default: 'Default persona (chat has no lock)',
    }[p.source];
    const more = p.extra ? ` <span class="chf-muted">+${p.extra}</span>` : '';
    return `<div class="chf-persona chf-src-${p.source}" title="${esc(`${name}\n${why}`)}">
        <img src="${esc(thumb('persona', p.avatar))}" alt="" loading="lazy">
        <span>${esc(name)}</span>${more}
        ${p.source === 'chat' ? '<i class="fa-solid fa-lock fa-2xs"></i>' : ''}
    </div>`;
}

function displayTitle(chat, folder) {
    const name = chat.chat_name;
    if (!settings().stripCharName) return name;
    const prefix = `${folder.name} - `;
    return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
}

function chatHtml(chat, folder) {
    const m = toMoment(chat.last_mes);
    const short = m?.isValid() ? m.format('l') : '';
    const long = m?.isValid() ? m.format('LL LT') : '';
    const preview = settings().showPreview && chat.mes
        ? `<div class="chf-preview" title="${esc(chat.mes)}">${esc(chat.mes)}</div>` : '';
    return `<div class="chf-chat" role="button" tabindex="0" data-file="${esc(chat.chat_name)}">
        <div class="chf-chat-main">
            <div class="chf-chat-title" title="${esc(chat.file_name)}">${esc(displayTitle(chat, folder))}</div>
            ${personaHtml(chat, folder)}
            ${preview}
        </div>
        <div class="chf-chat-side">
            <div class="chf-chat-meta">
                <small title="${esc(long)}">${esc(short)}</small>
                <small title="Messages"><i class="fa-solid fa-comment fa-xs"></i> ${Number(chat.chat_items) || 0}</small>
            </div>
            <div class="chf-chat-actions">
                <button class="chf-btn" data-act="rename" title="Rename chat"><i class="fa-solid fa-pen-to-square"></i></button>
                <button class="chf-btn chf-danger" data-act="delete" title="Delete chat"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    </div>`;
}

function folderHtml(folder, open) {
    const m = folder.last ? moment(folder.last) : null;
    const count = folder.chats.length;
    return `<div class="chf-folder${open ? ' open' : ''}${folder.pinned ? ' pinned' : ''}" data-key="${esc(folder.key)}">
        <div class="chf-folder-head" role="button" tabindex="0" aria-expanded="${open}">
            <i class="chf-chevron fa-solid fa-chevron-right fa-fw"></i>
            ${folderAvatarHtml(folder)}
            <div class="chf-folder-info">
                <div class="chf-folder-name">
                    ${folder.isGroup ? '<i class="fa-solid fa-users fa-xs chf-muted" title="Group"></i>' : ''}
                    <span>${esc(folder.name)}</span>
                </div>
                <div class="chf-folder-sub">
                    <span>${count} chat${count === 1 ? '' : 's'}</span>
                    ${m ? `<span class="chf-dot">·</span><span title="${esc(m.format('LL LT'))}">${esc(m.fromNow())}</span>` : ''}
                </div>
            </div>
            <div class="chf-folder-actions">
                <button class="chf-btn" data-act="new" title="New chat with ${esc(folder.name)}"><i class="fa-solid fa-plus"></i></button>
                <button class="chf-btn chf-pin${folder.pinned ? ' active' : ''}" data-act="pin" title="${folder.pinned ? 'Unpin folder' : 'Pin folder to top'}"><i class="fa-solid fa-thumbtack"></i></button>
            </div>
        </div>
        <div class="chf-folder-body">
            ${folder.chats.map(c => chatHtml(c, folder)).join('')}
        </div>
    </div>`;
}

function applyFilter(root, query) {
    const q = query.trim().toLowerCase();
    let visible = 0;
    root.querySelectorAll('.chf-folder').forEach((el) => {
        const name = el.querySelector('.chf-folder-name')?.textContent.toLowerCase() ?? '';
        const nameHit = !q || name.includes(q);
        let chatHits = 0;
        el.querySelectorAll('.chf-chat').forEach((c) => {
            const hit = !q || nameHit || c.dataset.file.toLowerCase().includes(q);
            c.classList.toggle('chf-hidden', !hit);
            if (hit && q && !nameHit) chatHits++;
        });
        const show = nameHit || chatHits > 0;
        el.classList.toggle('chf-hidden', !show);
        el.classList.toggle('chf-force-open', !!q && !nameHit && chatHits > 0);
        if (show) visible++;
    });
    root.querySelector('.chf-empty-filter')?.classList.toggle('chf-hidden', visible > 0);
}

function render(root, folders) {
    const s = settings();
    root.className = `chf-root chf-layout-${s.layout}`;
    const totalChats = folders.reduce((n, f) => n + f.chats.length, 0);

    root.innerHTML = `
        <div class="chf-toolbar">
            <div class="chf-title">Chats <span class="chf-muted">${folders.length} folders · ${totalChats} chats</span></div>
            <div class="chf-search"><i class="fa-solid fa-magnifying-glass fa-xs"></i><input type="search" class="text_pole" placeholder="Filter characters or chats…"></div>
            <div class="chf-toolbar-actions">
                <button class="chf-btn" data-act="collapse-all" title="Collapse all"><i class="fa-solid fa-folder-closed"></i></button>
                <button class="chf-btn" data-act="layout" title="Switch list / grid"><i class="fa-solid ${s.layout === 'grid' ? 'fa-list' : 'fa-table-cells-large'}"></i></button>
                <button class="chf-btn" data-act="refresh" title="Refresh"><i class="fa-solid fa-rotate"></i></button>
            </div>
        </div>
        <div class="chf-list">
            ${folders.length ? folders.map(f => folderHtml(f, s.expanded.includes(f.key))).join('') : '<div class="chf-empty"><i class="fa-solid fa-comment-dots"></i> No chats yet</div>'}
        </div>
        <div class="chf-empty chf-empty-filter chf-hidden">Nothing matches that filter.</div>`;

    // group avatars use SillyTavern's own collage renderer
    root.querySelectorAll('.chf-folder').forEach((el) => {
        const folder = folders.find(f => f.key === el.dataset.key);
        const slot = el.querySelector('.chf-group-avatar');
        if (folder?.isGroup && slot && typeof Groups.getGroupAvatar === 'function') {
            try { $(slot).append(Groups.getGroupAvatar(folder.entity)); } catch { /* ignore */ }
        }
    });

    const byKey = (el) => folders.find(f => f.key === el.closest('.chf-folder')?.dataset.key);

    const toggleFolder = (folderEl) => {
        const open = !folderEl.classList.contains('open');
        folderEl.classList.toggle('open', open);
        folderEl.querySelector('.chf-folder-head')?.setAttribute('aria-expanded', String(open));
        toggleListItem('expanded', folderEl.dataset.key, open);
    };

    root.addEventListener('click', async (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        const btn = target.closest('button[data-act]');
        if (btn) {
            e.stopPropagation();
            const act = btn.getAttribute('data-act');
            const folder = byKey(btn);
            const chatName = btn.closest('.chf-chat')?.getAttribute('data-file');
            switch (act) {
                case 'new': return newChat(folder);
                case 'pin':
                    toggleListItem('pinned', folder.key, !folder.pinned);
                    return refreshRoot(root);
                case 'rename': return renameChat(folder, chatName, root);
                case 'delete': return deleteChat(folder, chatName, root);
                case 'collapse-all':
                    settings().expanded = [];
                    save();
                    root.querySelectorAll('.chf-folder.open').forEach(el => el.classList.remove('open'));
                    return;
                case 'layout':
                    settings().layout = settings().layout === 'grid' ? 'list' : 'grid';
                    save();
                    syncSettingsUi();
                    return render(root, folders);
                case 'refresh': return refreshRoot(root);
            }
            return;
        }
        const chatEl = target.closest('.chf-chat');
        if (chatEl) return openChat(byKey(chatEl), chatEl.getAttribute('data-file'));
        const head = target.closest('.chf-folder-head');
        if (head) return toggleFolder(head.closest('.chf-folder'));
    });

    root.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const target = /** @type {HTMLElement} */ (e.target);
        if (target.matches('.chf-folder-head, .chf-chat')) {
            e.preventDefault();
            target.click();
        }
    });

    const input = root.querySelector('.chf-search input');
    input?.addEventListener('input', () => applyFilter(root, input.value));
}

async function refreshRoot(root) {
    if (!root?.isConnected) return;
    const chat = document.getElementById('chat');
    const scroll = chat?.scrollTop ?? 0;
    const query = root.querySelector('.chf-search input')?.value ?? '';
    try {
        const folders = buildFolders(await fetchChats());
        // A new copy of the root avoids stacking event listeners.
        const fresh = root.cloneNode(false);
        root.replaceWith(fresh);
        render(/** @type {HTMLElement} */ (fresh), folders);
        if (query) {
            const input = fresh.querySelector('.chf-search input');
            input.value = query;
            applyFilter(fresh, query);
        }
        if (chat) chat.scrollTop = scroll;
    } catch (err) {
        console.error(LOG, err);
        root.innerHTML = '<div class="chf-empty">Could not load chats. See console for details.</div>';
    }
}

// ---------- adaptive logo ----------

const MASK_CIRCUIT = new URL('./img/logo-circuit.png', import.meta.url).href;
const MASK_LETTERS = new URL('./img/logo-letters.png', import.meta.url).href;

function buildLogo(style) {
    const el = document.createElement('div');
    el.className = `chf-logo chf-logo3d chf-logo-${style}`;
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'SillyTavern');
    el.style.setProperty('--chf-mask-circuit', `url("${MASK_CIRCUIT}")`);
    el.style.setProperty('--chf-mask-letters', `url("${MASK_LETTERS}")`);
    el.innerHTML = '<div class="chf-lw chf-lw-circuit"><div class="chf-l chf-l-circuit"></div></div>'
        + '<div class="chf-lw chf-lw-letters"><div class="chf-l chf-l-letters"></div></div>';
    return el;
}

/** Parses "rgb(...)"/"rgba(...)" into [r, g, b, a] (0-255, alpha 0-1). */
function parseRgb(str) {
    const m = String(str).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

const imageCache = new Map();

function loadImage(url) {
    if (!imageCache.has(url)) {
        imageCache.set(url, new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = url;
        }));
    }
    return imageCache.get(url);
}

/**
 * Average colour of the background image *exactly behind* the given element,
 * honouring the background's cover/contain/stretch sizing.
 */
async function backgroundBehind(el) {
    const bg = document.getElementById('bg1');
    if (!bg) return null;
    const style = getComputedStyle(bg);
    const url = style.backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
    if (!url) return null;
    const img = await loadImage(url);
    if (!img || !img.naturalWidth) return null;

    const box = bg.getBoundingClientRect();
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const size = style.backgroundSize;
    let sx, sy;
    if (size.includes('contain')) sx = sy = Math.min(box.width / iw, box.height / ih);
    else if (size.includes('100% 100%')) { sx = box.width / iw; sy = box.height / ih; }
    else if (size === 'auto' || size === 'auto auto') sx = sy = 1;
    else sx = sy = Math.max(box.width / iw, box.height / ih); // cover (SillyTavern default)
    const [px, py] = style.backgroundPosition.split(' ').map(v => (v.endsWith('%') ? parseFloat(v) / 100 : 0.5));
    const offX = box.left + (box.width - iw * sx) * (isNaN(px) ? 0.5 : px);
    const offY = box.top + (box.height - ih * sy) * (isNaN(py) ? 0.5 : py);

    const r = el.getBoundingClientRect();
    const x0 = Math.max(0, (r.left - offX) / sx), y0 = Math.max(0, (r.top - offY) / sy);
    const w = Math.min(iw - x0, r.width / sx), h = Math.min(ih - y0, r.height / sy);
    if (w <= 0 || h <= 0) return null;
    try {
        const c = document.createElement('canvas');
        c.width = 12; c.height = 12;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, x0, y0, w, h, 0, 0, 12, 12);
        const d = ctx.getImageData(0, 0, 12, 12).data;
        let rr = 0, gg = 0, bb = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) { rr += d[i]; gg += d[i + 1]; bb += d[i + 2]; n++; }
        return [rr / n, gg / n, bb / n];
    } catch {
        return null;
    }
}

/** Composites every translucent layer between the background image and the logo. */
async function surfaceBehind(el) {
    let base = (await backgroundBehind(el)) ?? [24, 24, 24];
    const layers = [];
    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        const c = parseRgb(getComputedStyle(n).backgroundColor);
        if (c && c[3] > 0) layers.push(c);
    }
    for (const [r, g, b, a] of layers.reverse()) {
        base = [base[0] * (1 - a) + r * a, base[1] * (1 - a) + g * a, base[2] * (1 - a) + b * a];
    }
    return base;
}

const mix = (c, t, k) => c.map((v, i) => Math.round(v + (t[i] - v) * k));
const css = (c, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
const luminance = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

async function colorLogos() {
    const W = [255, 255, 255], K = [0, 0, 0];
    for (const el of document.querySelectorAll('.chf-logo3d')) {
        const surface = await surfaceBehind(el);
        const dark = luminance(surface) < 0.22;
        const v = {
            // material colour: the surface itself, nudged slightly
            '--chf-fill': css(mix(surface, dark ? W : K, dark ? 0.14 : 0.05)),
            '--chf-fill-hi': css(mix(surface, W, dark ? 0.28 : 0.35)),
            '--chf-fill-lo': css(mix(surface, K, dark ? 0.10 : 0.12)),
            '--chf-letter': css(mix(surface, dark ? W : K, dark ? 0.38 : 0.32)),
            '--chf-letter-hi': css(mix(surface, W, dark ? 0.55 : 0.4)),
            // lighting
            '--chf-hl': css(W, dark ? 0.22 : 0.9),
            '--chf-sh': css(K, dark ? 0.85 : 0.35),
            // flat mono: high contrast against the surface
            '--chf-mono-a': dark ? css(mix(surface, W, 0.9)) : css(mix(surface, K, 0.85)),
            '--chf-mono-b': dark ? css(mix(surface, K, 0.6)) : css(mix(surface, W, 0.9)),
        };
        for (const [k, val] of Object.entries(v)) el.style.setProperty(k, val);
        el.dataset.tone = dark ? 'dark' : 'light';
    }
}

let recolorTimers = [];
/** Theme colours fade with a CSS transition, so measure again once it has settled. */
function scheduleRecolor() {
    recolorTimers.forEach(clearTimeout);
    recolorTimers = [setTimeout(colorLogos, 150), setTimeout(colorLogos, 1200)];
}

function assistantButton() {
    const avatar = typeof Welcome.getPermanentAssistantAvatar === 'function' ? Welcome.getPermanentAssistantAvatar() : null;
    const character = avatar ? ST.characters.find(c => c.avatar === avatar) : null;
    const name = character?.name || ST.neutralCharacterName || 'Assistant';
    const btn = document.createElement('button');
    btn.className = 'menu_button menu_button_icon chf-assistant-btn';
    btn.title = `Start a new chat with your assistant (${name})`;
    btn.innerHTML = character
        ? `<img src="${esc(thumb('avatar', character.avatar))}" alt=""><span>${esc(name)}</span>`
        : `<i class="fa-solid fa-robot"></i><span>${esc(name)}</span>`;
    btn.addEventListener('click', async () => {
        try {
            await ST.newAssistantChat({ temporary: false });
            document.getElementById('send_textarea')?.focus();
        } catch (err) {
            console.error(LOG, 'assistant chat failed', err);
            toastr.error('Could not open the assistant. See console for details.');
        }
    });
    return btn;
}

/** Rearranges the welcome panel header: shortcuts left, big logo right, version to a footer. */
function tweakHeader(panel) {
    const s = settings();
    const title = panel.querySelector('.welcomeHeaderTitle');
    const shortcuts = panel.querySelector('.welcomeShortcuts');
    const logo = panel.querySelector('.welcomeHeaderLogo');
    const version = panel.querySelector('.welcomeHeaderVersionDisplay');

    if (title && shortcuts) {
        panel.classList.add('chf-header');
        title.prepend(shortcuts);
    }
    if (title && logo) {
        logo.classList.add('chf-logo');
        if (s.logoStyle === 'original') {
            title.append(logo);
        } else {
            const logo3d = buildLogo(s.logoStyle);
            title.append(logo3d);
            logo.remove();
            colorLogos();
            scheduleRecolor();
        }
    }
    if (s.versionFooter && version) {
        const chat = document.getElementById('chat');
        chat?.querySelectorAll(':scope > .chf-footer').forEach(el => el.remove());
        const footer = document.createElement('div');
        footer.className = 'chf-footer';
        footer.textContent = version.textContent.trim().startsWith('SillyTavern') ? version.textContent.trim() : `SillyTavern ${version.textContent.trim()}`;
        chat?.append(footer);
        version.remove();
    }
    const temp = panel.querySelector('button.openTemporaryChat');
    if (s.assistantButton && temp) {
        temp.replaceWith(assistantButton());
    }
}

async function enhancePanel(panel) {
    if (!settings().enabled || panel.dataset.chf) return;
    panel.dataset.chf = '1';
    panel.classList.add('chf-active');
    tweakHeader(panel);
    const root = document.createElement('div');
    root.className = 'chf-root';
    root.innerHTML = '<div class="chf-empty"><i class="fa-solid fa-spinner fa-spin"></i> Loading chats…</div>';
    const anchor = panel.querySelector('.welcomeRecent') ?? panel.lastElementChild;
    anchor ? anchor.before(root) : panel.append(root);
    await refreshRoot(root);
}

function scanChat() {
    document.querySelectorAll('#chat .welcomePanel').forEach(p => enhancePanel(/** @type {HTMLElement} */ (p)));
}

function syncBodyClasses() {
    const s = settings();
    const on = s.enabled;
    document.body.classList.toggle('chf-welcome', !!document.querySelector('#chat .welcomePanel'));
    document.body.classList.toggle('chf-hide-greeting', on && s.hideGreeting);
    document.body.classList.toggle('chf-hide-prompt', on && s.hidePromptButtons);
    document.body.classList.toggle('chf-hide-input', on && s.hideInput);
}

/** Re-renders the whole welcome screen so header/footer changes apply. */
function rerenderAll() {
    syncBodyClasses();
    if (document.querySelector('#chat .welcomePanel') && typeof Welcome.openWelcomeScreen === 'function') {
        Welcome.openWelcomeScreen({ force: true });
    }
}

// ---------- settings UI ----------

const SETTINGS_HTML = `
<div class="chf-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Chat Folders</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="checkbox" data-key="enabled"> Replace "Recent Chats" with folders</label>
            <label class="checkbox_label"><input type="checkbox" data-key="showPersona"> Show persona under chat title</label>
            <label class="checkbox_label" title="If a chat has no persona locked to it, show the persona connected to the character, or your default persona (dimmed)."><input type="checkbox" data-key="inferPersona"> Guess persona when the chat has no lock</label>
            <label class="checkbox_label"><input type="checkbox" data-key="stripCharName"> Hide character name at the start of chat titles</label>
            <label class="checkbox_label"><input type="checkbox" data-key="showPreview"> Show last message preview</label>
            <hr class="sysHR">
            <b>Welcome page</b>
            <div class="chf-settings-row">
                <label title="Colours adapt automatically to your background image and theme.">Logo style</label>
                <select class="text_pole" data-key="logoStyle">
                    <option value="emboss">Embossed (adaptive)</option>
                    <option value="deboss">Pressed in (adaptive)</option>
                    <option value="mono">Flat mono (adaptive)</option>
                    <option value="original">Original red</option>
                </select>
            </div>
            <label class="checkbox_label"><input type="checkbox" data-key="versionFooter"> Move version info to a faded footer</label>
            <label class="checkbox_label"><input type="checkbox" data-key="assistantButton"> Replace "Temporary Chat" with an Assistant button</label>
            <label class="checkbox_label"><input type="checkbox" data-key="hideInput"> Hide the chat input bar</label>
            <label class="checkbox_label"><input type="checkbox" data-key="hidePromptButtons"> Hide the API / Character Management / Extensions buttons</label>
            <label class="checkbox_label"><input type="checkbox" data-key="hideGreeting"> Hide the assistant greeting message</label>
            <hr class="sysHR">
            <div class="chf-settings-row">
                <label>Layout</label>
                <select class="text_pole" data-key="layout"><option value="list">List</option><option value="grid">Grid</option></select>
            </div>
            <div class="chf-settings-row">
                <label>Sort folders by</label>
                <select class="text_pole" data-key="sort"><option value="recent">Most recent chat</option><option value="name">Name</option></select>
            </div>
            <div class="chf-settings-row">
                <label title="How many of your most recent chat files are loaded. Higher = more complete folders, slightly slower welcome screen.">Chats to load</label>
                <input type="number" class="text_pole" data-key="maxChats" min="10" max="5000" step="10">
            </div>
        </div>
    </div>
</div>`;

function syncSettingsUi() {
    const s = settings();
    document.querySelectorAll('.chf-settings [data-key]').forEach((el) => {
        const key = el.getAttribute('data-key');
        if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!s[key];
        else if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) el.value = String(s[key]);
    });
}

function mountSettings() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || host.querySelector('.chf-settings')) return;
    host.insertAdjacentHTML('beforeend', SETTINGS_HTML);
    syncSettingsUi();
    host.querySelector('.chf-settings').addEventListener('change', (e) => {
        const el = /** @type {HTMLInputElement} */ (e.target);
        const key = el.getAttribute('data-key');
        if (!key) return;
        const s = settings();
        if (el.type === 'checkbox') s[key] = el.checked;
        else if (el.type === 'number') s[key] = Math.min(5000, Math.max(10, parseInt(el.value) || DEFAULTS.maxChats));
        else s[key] = el.value;
        save();
        syncSettingsUi();
        rerenderAll();
    });
}

// ---------- boot ----------

jQuery(() => {
    settings();
    mountSettings();
    syncBodyClasses();

    // Re-tint the logo when the theme colours or background image change
    const recolorObserver = new MutationObserver(scheduleRecolor);
    recolorObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    recolorObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const bg1 = document.getElementById('bg1');
    if (bg1) recolorObserver.observe(bg1, { attributes: true, attributeFilter: ['style'] });

    const chat = document.getElementById('chat');
    if (chat) {
        new MutationObserver((mutations) => {
            syncBodyClasses();
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node instanceof HTMLElement && (node.matches('.welcomePanel') || node.querySelector?.('.welcomePanel'))) {
                        scanChat();
                        return;
                    }
                }
            }
        }).observe(chat, { childList: true });
    }
    scanChat();
});
