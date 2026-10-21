/*
 * Chat header
 * Replaces the "Chat Top Bar" extension: chat switcher, persona picker (+ lock),
 * connection profile switcher and chat actions, shown only while a chat is open.
 *
 * Layouts
 * - Vertical icon rail (Discord theme on desktop): the header sits at the top of the chat column.
 * - Horizontal SillyTavern top bar (phones, default theme): the header takes the top bar's place.
 *   A swap button flips between the header and SillyTavern's top bar; opening a chat always
 *   starts on the header.
 */
import * as ST from '../../../../script.js';
import * as Groups from '../../../group-chats.js';
import { power_user } from '../../../power-user.js';
import { user_avatar, setUserAvatar, isPersonaLocked, togglePersonaLock } from '../../../personas.js';
import { branchChat } from '../../../bookmarks.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { LOG, settings, esc, thumb, toMoment, resolvePersona } from './shared.js';
import { openHub } from './hub.js';

let bar = null;
let menuEl = null;
let chatsCache = { key: null, list: [] };
let mode = 'header';            // 'header' | 'stbar' (only matters for the horizontal top bar)

const isRail = () => {
    const r = document.getElementById('top-settings-holder')?.getBoundingClientRect();
    return !!r && r.height > r.width * 2;
};
const isNarrow = () => window.matchMedia('(max-width: 1000px)').matches;
const enabled = () => settings().enabled !== false && settings().chatHeader;
const ctx = () => SillyTavern.getContext();

function inChat() {
    const c = ctx();
    return !!c.getCurrentChatId() && (c.groupId || c.characterId !== undefined);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function currentEntity() {
    const c = ctx();
    if (c.groupId) {
        const g = Groups.groups.find(x => x.id === c.groupId);
        return g ? { isGroup: true, id: g.id, name: g.name, g } : null;
    }
    const ch = c.characters[c.characterId];
    return ch ? { isGroup: false, id: ch.avatar, name: ch.name, ch } : null;
}

async function loadChats(force = false) {
    const e = currentEntity();
    if (!e) return [];
    const key = `${e.isGroup ? 'g' : 'c'}:${e.id}`;
    if (!force && chatsCache.key === key) return chatsCache.list;
    let list = [];
    try {
        if (e.isGroup) {
            list = (e.g.chats ?? []).map(n => ({ file_name: `${n}.jsonl` }));
        } else {
            const res = await fetch('/api/characters/chats', {
                method: 'POST', headers: ST.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: e.id, metadata: true }),
            });
            const data = await res.json();
            list = Array.isArray(data) ? data : [];
        }
    } catch (err) {
        console.warn(LOG, 'header chats failed', err);
    }
    for (const ch of list) {
        ch.name = String(ch.file_name).replace(/\.jsonl$/, '');
        const m = ch.last_mes ? toMoment(ch.last_mes) : null;
        ch._ts = m?.isValid() ? m.valueOf() : 0;
    }
    list.sort((a, b) => b._ts - a._ts || a.name.localeCompare(b.name));
    chatsCache = { key, list };
    return list;
}

function displayTitle(name, e) {
    const prefix = `${e?.name} - `;
    return e && settings().stripCharName && name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
}

function profileSelect() {
    return /** @type {HTMLSelectElement|null} */ (document.getElementById('connection_profiles'));
}

function currentProfileName() {
    const sel = profileSelect();
    if (!sel || !sel.value) return '';
    return sel.selectedOptions[0]?.textContent?.trim() ?? '';
}

async function connectionStatus() {
    const { SlashCommandParser, onlineStatus, mainApi } = ctx();
    if (!onlineStatus || onlineStatus === 'no_connection') return { online: false, text: 'Not connected' };
    const apiBlock = document.getElementById('rm_api_block');
    let api = mainApi;
    let model = onlineStatus;
    try { api = (await SlashCommandParser.commands.api?.callback({ quiet: 'true' }, '')) || api; } catch { /* ignore */ }
    try {
        const m = await SlashCommandParser.commands.model?.callback({ quiet: 'true' }, '');
        if (m && typeof m === 'string') model = m;
    } catch { /* ignore */ }
    const apiName = (apiBlock?.querySelector(`select:not(#main_api) option[value="${CSS.escape(api)}"]`) ?? apiBlock?.querySelector(`select#main_api option[value="${CSS.escape(api)}"]`))
        ?.textContent.replace(/[[(].*[\])]/, '').trim() || api;
    const modelName = apiBlock?.querySelector(`option[value="${CSS.escape(model)}"]`)?.textContent.trim() || model;
    return { online: true, text: `${apiName} – ${modelName}` };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'chf-header';
    bar.addEventListener('click', onBarClick);
    const sheld = document.getElementById('sheld');
    const chat = document.getElementById('chat');
    sheld?.insertBefore(bar, chat);

    // swap button living in SillyTavern's own top bar (horizontal layouts)
    const holder = document.getElementById('top-settings-holder');
    if (holder && !document.getElementById('chf-swap-back')) {
        const back = document.createElement('div');
        back.id = 'chf-swap-back';
        back.className = 'drawer';
        back.innerHTML = '<div class="drawer-toggle"><div class="drawer-icon fa-solid fa-hashtag fa-fw closedIcon" title="Show the chat header"></div></div>';
        back.addEventListener('click', (e) => {
            e.stopPropagation();
            setMode('header');
        }, true);
        holder.append(back);
    }
    return bar;
}

function setMode(m) {
    mode = m;
    sync();
}

/** Shows / hides the header for the current state. */
export function sync() {
    if (!enabled()) {
        bar?.classList.add('chf-hidden');
        document.body.classList.remove('chf-hdr', 'chf-hdr-replace', 'chf-hdr-stbar', 'chf-hdr-enabled');
        return;
    }
    document.body.classList.add('chf-hdr-enabled');
    ensureBar();
    const show = inChat();
    const horizontal = !isRail();
    const replace = show && horizontal && mode === 'header';
    bar.classList.toggle('chf-hidden', !show || (horizontal && mode !== 'header'));
    bar.classList.toggle('chf-compact', isNarrow());
    document.body.classList.toggle('chf-hdr', show);
    document.body.classList.toggle('chf-hdr-replace', replace);
    document.body.classList.toggle('chf-hdr-stbar', show && horizontal && mode !== 'header');
}

async function render() {
    sync();
    if (!bar || bar.classList.contains('chf-hidden') && !inChat()) return;
    const e = currentEntity();
    if (!e) return;
    const chatId = ctx().getCurrentChatId();
    const compact = isNarrow();
    const persona = user_avatar;
    const personaName = power_user.personas?.[persona] ?? persona;
    const locked = safe(() => isPersonaLocked('chat'), false);
    const profile = currentProfileName();
    const horizontal = !isRail();

    bar.innerHTML = `
        <button class="chf-h-chat" data-act="chats" title="${esc(chatId)}">
            <i class="fa-solid fa-hashtag"></i><span>${esc(displayTitle(chatId, e))}</span><i class="fa-solid fa-chevron-down chf-h-caret"></i>
        </button>
        <div class="chf-h-spacer"></div>
        <button class="chf-h-chip chf-h-persona" data-act="persona" title="Speaking as ${esc(personaName)}${locked ? ' (locked to this chat)' : ''}">
            <img src="${esc(thumb('persona', persona))}" alt="">${compact ? '' : `<span>${esc(personaName)}</span>`}${locked ? '<i class="fa-solid fa-lock"></i>' : ''}
        </button>
        <button class="chf-h-chip chf-h-conn" data-act="conn" title="Connection profile">
            <span class="chf-h-dot"></span>${compact ? '<i class="fa-solid fa-plug"></i>' : `<span class="chf-h-prof">${esc(profile || 'No profile')}</span><span class="chf-h-status">…</span>`}
        </button>
        ${compact ? '' : `<span class="chf-h-sep"></span>
        <button class="chf-h-ic" data-act="search" title="Search in this chat"><i class="fa-solid fa-magnifying-glass"></i></button>
        <button class="chf-h-ic" data-act="new" title="New chat"><i class="fa-solid fa-plus"></i></button>
        <button class="chf-h-ic" data-act="branch" title="Branch from the last message"><i class="fa-solid fa-code-branch"></i></button>
        <button class="chf-h-ic" data-act="rename" title="Rename chat"><i class="fa-solid fa-pen"></i></button>
        <button class="chf-h-ic" data-act="delete" title="Delete chat"><i class="fa-solid fa-trash"></i></button>
        <button class="chf-h-ic" data-act="close" title="Close chat"><i class="fa-solid fa-xmark"></i></button>`}
        ${compact ? '<button class="chf-h-ic" data-act="more" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>' : ''}
        ${horizontal ? '<button class="chf-h-ic chf-h-swap" data-act="swap" title="Show SillyTavern\'s top bar"><i class="fa-solid fa-bars"></i></button>' : ''}
        <div class="chf-h-search chf-hidden"><i class="fa-solid fa-magnifying-glass"></i><input type="search" placeholder="Search this chat… (Enter = next)"><small></small><button class="chf-h-ic" data-act="search-close"><i class="fa-solid fa-xmark"></i></button></div>`;

    updateStatus();
}

async function updateStatus() {
    if (!bar) return;
    const s = await connectionStatus();
    const dot = bar.querySelector('.chf-h-dot');
    dot?.classList.toggle('off', !s.online);
    const st = bar.querySelector('.chf-h-status');
    if (st) st.textContent = s.text;
    const chip = bar.querySelector('.chf-h-conn');
    if (chip) chip.title = `${currentProfileName() || 'No profile'}\n${s.text}`;
}

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

function closeMenu() {
    menuEl?.remove();
    menuEl = null;
    bar?.querySelectorAll('.on').forEach(b => b.classList.remove('on'));
}

function openMenu(anchor, html, cls) {
    closeMenu();
    anchor.classList.add('on');
    menuEl = document.createElement('div');
    menuEl.className = `chf-h-menu ${cls}`;
    menuEl.innerHTML = html;
    document.body.append(menuEl);
    const r = anchor.getBoundingClientRect();
    const w = menuEl.offsetWidth;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${r.bottom + 6}px`;
    menuEl.addEventListener('click', onMenuClick);
    menuEl.addEventListener('input', onMenuInput);
    menuEl.querySelector('input[type="search"]')?.focus();
    return menuEl;
}

async function openChatsMenu(anchor) {
    const e = currentEntity();
    const current = ctx().getCurrentChatId();
    const m = openMenu(anchor, `<div class="chf-h-list"><div class="chf-h-empty"><i class="fa-solid fa-circle-notch fa-spin"></i></div></div>`, 'chf-h-menu-chats');
    const list = await loadChats(true);
    if (!m.isConnected) return;
    const folder = { isGroup: e.isGroup, id: e.id };
    m.querySelector('.chf-h-list').innerHTML = list.length ? list.map((ch) => {
        const p = !e.isGroup ? resolvePersona(ch, folder) : null;
        const pn = p ? (power_user.personas?.[p.avatar] ?? p.avatar) : '';
        const when = ch._ts ? toMoment(ch._ts)?.fromNow() : '';
        return `<div class="chf-h-row${ch.name === current ? ' cur' : ''}" data-chat="${esc(ch.name)}" tabindex="0">
            <div class="chf-h-row-main"><div class="chf-h-row-t">${esc(displayTitle(ch.name, e))}</div>
            <div class="chf-h-row-p">${p ? `<img src="${esc(thumb('persona', p.avatar))}" class="${p.source !== 'chat' ? 'dim' : ''}" alt="">${esc(pn)}${p.source === 'chat' ? ' <i class="fa-solid fa-lock fa-2xs"></i>' : ''} · ` : ''}${ch.chat_items != null ? `${Number(ch.chat_items)} msgs` : ''}</div></div>
            <span class="chf-h-row-d">${esc(when ?? '')}</span></div>`;
    }).join('') : '<div class="chf-h-empty">No chats</div>';
}

function openPersonaMenu(anchor) {
    const e = currentEntity();
    const all = Object.keys(power_user.personas ?? {});
    const type = e?.isGroup ? 'group' : 'character';
    const connected = new Set(Object.entries(power_user.persona_descriptions ?? {})
        .filter(([, d]) => d?.connections?.some(c => c.type === type && c.id === e?.id)).map(([k]) => k));
    const sorted = [...all].sort((a, b) => (connected.has(b) - connected.has(a)) || (power_user.personas[a] ?? a).localeCompare(power_user.personas[b] ?? b));
    const locked = safe(() => isPersonaLocked('chat'), false);
    openMenu(anchor, `
        <h5>Persona for this chat</h5>
        ${all.length > 8 ? '<div class="chf-h-filter"><i class="fa-solid fa-magnifying-glass"></i><input type="search" placeholder="Filter personas…"></div>' : ''}
        <div class="chf-h-list">${sorted.map(a => `<div class="chf-h-prow${a === user_avatar ? ' cur' : ''}" data-persona="${esc(a)}" tabindex="0">
            <img src="${esc(thumb('persona', a))}" alt=""><span>${esc(power_user.personas[a] ?? a)}</span>
            <small>${connected.has(a) ? 'connected' : (power_user.default_persona === a ? 'default' : '')}</small></div>`).join('')}</div>
        <label class="chf-h-lock"><input type="checkbox" data-act="lock" ${locked ? 'checked' : ''}><span class="chf-h-tg"></span>Lock persona to this chat</label>`, 'chf-h-menu-persona');
}

async function openConnMenu(anchor) {
    const sel = profileSelect();
    const opts = sel ? [...sel.options] : [];
    const s = await connectionStatus();
    openMenu(anchor, `
        <h5>Connection profile</h5>
        <div class="chf-h-statusline"><span class="chf-h-dot${s.online ? '' : ' off'}"></span>${esc(s.text)}</div>
        <div class="chf-h-list">${opts.length ? opts.map(o => `<div class="chf-h-prow${o.value === sel.value ? ' cur' : ''}${o.value ? '' : ' none'}" data-profile="${esc(o.value)}" tabindex="0"><i class="fa-solid fa-plug fa-fw"></i><span>${esc(o.textContent.trim())}</span></div>`).join('')
            : '<div class="chf-h-empty">Connection Manager is not enabled.</div>'}</div>
        <button class="chf-h-link" data-act="open-conn"><i class="fa-solid fa-gear"></i> Open Connections</button>`, 'chf-h-menu-conn');
}

function openMoreMenu(anchor) {
    openMenu(anchor, `
        <button data-act="search"><i class="fa-solid fa-magnifying-glass fa-fw"></i>Search in chat</button>
        <button data-act="new"><i class="fa-solid fa-plus fa-fw"></i>New chat</button>
        <button data-act="branch"><i class="fa-solid fa-code-branch fa-fw"></i>Branch from last message</button>
        <button data-act="rename"><i class="fa-solid fa-pen fa-fw"></i>Rename chat</button>
        <button data-act="delete" class="chf-h-danger"><i class="fa-solid fa-trash fa-fw"></i>Delete chat</button>
        <button data-act="close"><i class="fa-solid fa-xmark fa-fw"></i>Close chat</button>`, 'chf-h-menu-more');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function doAction(act, el) {
    const c = ctx();
    switch (act) {
        case 'profile': {
            const e = currentEntity();
            if (e && !e.isGroup && window.matchMedia('(min-width: 1000px)').matches && settings().hubEnabled) openHub('profile', e.id);
            else document.getElementById('option_select_chat')?.click();
            return;
        }
        case 'chats': return openChatsMenu(el);
        case 'persona': return openPersonaMenu(el);
        case 'conn': return openConnMenu(el);
        case 'more': return openMoreMenu(el);
        case 'swap': return setMode('stbar');
        case 'new': closeMenu(); return document.getElementById('option_start_new_chat')?.click();
        case 'close': closeMenu(); return document.getElementById('option_close_chat')?.click();
        case 'branch': {
            closeMenu();
            const last = c.chat.length - 1;
            if (last < 0) return;
            try { await branchChat(last); } catch (err) { console.error(LOG, err); toastr.error('Could not branch.'); }
            return;
        }
        case 'rename': {
            closeMenu();
            const cur = c.getCurrentChatId();
            const name = await callGenericPopup('Rename this chat:', POPUP_TYPE.INPUT, cur);
            if (name && typeof name === 'string' && name !== cur) await c.renameChat(cur, name);
            return;
        }
        case 'delete': {
            closeMenu();
            if (await callGenericPopup('Delete this chat? This cannot be undone.', POPUP_TYPE.CONFIRM)) {
                await c.executeSlashCommandsWithOptions('/delchat');
            }
            return;
        }
        case 'search': {
            closeMenu();
            const box = bar.querySelector('.chf-h-search');
            box.classList.remove('chf-hidden');
            box.querySelector('input').focus();
            return;
        }
        case 'search-close': {
            const box = bar.querySelector('.chf-h-search');
            box.classList.add('chf-hidden');
            box.querySelector('input').value = '';
            clearHighlights();
            return;
        }
        case 'open-conn': {
            closeMenu();
            document.querySelector('#sys-settings-button .drawer-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return;
        }
    }
}

function onBarClick(e) {
    const btn = /** @type {HTMLElement} */ (e.target).closest('[data-act]');
    if (!btn) return;
    e.stopPropagation();
    if (btn.classList.contains('on') && menuEl) return closeMenu();
    doAction(btn.dataset.act, btn);
}

async function onMenuClick(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    const row = t.closest('[data-chat]');
    if (row) {
        closeMenu();
        const name = row.getAttribute('data-chat');
        const c = ctx();
        if (name === c.getCurrentChatId()) return;
        if (c.groupId) await Groups.openGroupChat(c.groupId, name);
        else await c.openCharacterChat(name);
        return;
    }
    const prow = t.closest('[data-persona]');
    if (prow) {
        await setUserAvatar(prow.getAttribute('data-persona'));
        closeMenu();
        return render();
    }
    const profileRow = t.closest('[data-profile]');
    if (profileRow) {
        const sel = profileSelect();
        if (sel) {
            sel.value = profileRow.getAttribute('data-profile');
            sel.dispatchEvent(new Event('change'));
        }
        closeMenu();
        setTimeout(render, 400);
        return;
    }
    if (t.matches('input[data-act="lock"]')) {
        await togglePersonaLock('chat');
        return render();
    }
    const btn = t.closest('button[data-act]');
    if (btn) doAction(btn.dataset.act, btn);
}

function onMenuInput(e) {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.type !== 'search') return;
    const q = t.value.trim().toLowerCase();
    menuEl.querySelectorAll('[data-chat], [data-persona]').forEach((r) => {
        r.classList.toggle('chf-hidden', !!q && !r.textContent.toLowerCase().includes(q));
    });
}

// ----- in-chat search -----

let hits = [];
let hitIndex = -1;

function clearHighlights() {
    document.querySelectorAll('#chat mark.chf-hl').forEach((m) => {
        m.replaceWith(document.createTextNode(m.textContent));
    });
    document.querySelectorAll('#chat .mes_text').forEach(n => n.normalize());
    hits = [];
    hitIndex = -1;
}

function highlight(q) {
    clearHighlights();
    const counter = bar?.querySelector('.chf-h-search small');
    if (!q || q.length < 2) { if (counter) counter.textContent = ''; return; }
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    for (const root of document.querySelectorAll('#chat .mes_text')) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) {
            const text = node.nodeValue;
            if (!re.test(text)) continue;
            re.lastIndex = 0;
            const frag = document.createDocumentFragment();
            let last = 0;
            text.replace(re, (m, idx) => {
                frag.append(text.slice(last, idx));
                const mark = document.createElement('mark');
                mark.className = 'chf-hl';
                mark.textContent = m;
                frag.append(mark);
                hits.push(mark);
                last = idx + m.length;
                return m;
            });
            frag.append(text.slice(last));
            node.replaceWith(frag);
        }
    }
    if (counter) counter.textContent = hits.length ? `${hits.length}` : 'none';
    if (hits.length) jump(1);
}

function jump(dir) {
    if (!hits.length) return;
    hits[hitIndex]?.classList.remove('cur');
    hitIndex = (hitIndex + dir + hits.length) % hits.length;
    const m = hits[hitIndex];
    m.classList.add('cur');
    m.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const counter = bar?.querySelector('.chf-h-search small');
    if (counter) counter.textContent = `${hitIndex + 1}/${hits.length}`;
}

let searchTimer;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export function initHeader() {
    document.addEventListener('click', (e) => {
        if (menuEl && !menuEl.contains(/** @type {Node} */ (e.target)) && !bar?.contains(/** @type {Node} */ (e.target))) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && menuEl) closeMenu();
    });
    document.addEventListener('input', (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        if (!t.closest?.('#chf-header .chf-h-search')) return;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => highlight(/** @type {HTMLInputElement} */ (t).value.trim()), 250);
    });
    document.addEventListener('keydown', (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        if (e.key === 'Enter' && t.closest?.('#chf-header .chf-h-search')) {
            e.preventDefault();
            jump(e.shiftKey ? -1 : 1);
        }
    });

    const { eventSource, eventTypes } = ctx();
    const rerender = () => setTimeout(render, 0);
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        mode = 'header';          // opening a chat always starts on the header
        chatsCache.key = null;
        clearHighlights();
        closeMenu();
        rerender();
    });
    for (const ev of ['CHAT_RENAMED', 'CHAT_DELETED', 'GROUP_CHAT_DELETED', 'PERSONA_CHANGED', 'ONLINE_STATUS_CHANGED',
        'CONNECTION_PROFILE_LOADED', 'CONNECTION_PROFILE_UPDATED', 'SETTINGS_UPDATED', 'APP_READY']) {
        if (eventTypes[ev]) eventSource.on(eventTypes[ev], () => { chatsCache.key = null; rerender(); });
    }
    window.addEventListener('resize', () => { if (bar && !bar.classList.contains('chf-hidden')) render(); else sync(); });
    render();
}
