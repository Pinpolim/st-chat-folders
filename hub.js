/*
 * Character Hub
 * A full-page character library + profile editor that replaces the
 * "Character Management" drawer on desktop.
 *
 * Saving: edits are written with SillyTavern's own /api/characters/merge-attributes
 * endpoint (the same one writeExtensionField uses), the in-memory character is
 * updated, and if the character is the one loaded in the stock editor, the stock
 * form fields are updated too so a later stock save can't overwrite our edits.
 */
import * as ST from '../../../../script.js';
import * as Groups from '../../../group-chats.js';
import { tags as allTags, tag_map, addTagsToEntity, removeTagFromEntity } from '../../../tags.js';
import { world_info, world_names, openWorldInfoEditor, charSetAuxWorlds } from '../../../world-info.js';
import { power_user } from '../../../power-user.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { getSanitizedFilename } from '../../../utils.js';
import { extension_settings, writeExtensionField } from '../../../extensions.js';
import * as Welcome from '../../../welcome-screen.js';
import { LOG, settings, save, esc, thumb, toMoment, resolvePersona, personaLabelHtml } from './shared.js';
import { registerHub, beforeHubOpens, sidebarOpen, sidebarWidth, layoutActive } from './layout.js';

// ---------------------------------------------------------------------------
// Field model
// ---------------------------------------------------------------------------

/**
 * paths: where the value lives on the character object / card (top-level V1 + data V2)
 * form:  matching control in SillyTavern's stock editor
 * alt:   Alternate Fields extension save key (extensions.alternate_fields[alt])
 */
const FIELDS = {
    description: { label: 'Description', icon: 'fa-scroll', paths: ['description', 'data.description'], form: '#description_textarea', alt: 'alt_descriptions', perm: true },
    personality: { label: 'Personality', icon: 'fa-masks-theater', paths: ['personality', 'data.personality'], form: '#personality_textarea', alt: 'alt_personalities', perm: true },
    scenario: { label: 'Scenario', icon: 'fa-mountain-sun', paths: ['scenario', 'data.scenario'], form: '#scenario_pole', alt: 'alt_scenarios', perm: true },
    depth_prompt: { label: "Character's note", icon: 'fa-thumbtack', paths: ['data.extensions.depth_prompt.prompt'], form: '#depth_prompt_prompt', perm: true },
    first_mes: { label: 'First message', icon: 'fa-comment-dots', paths: ['first_mes', 'data.first_mes'], form: '#firstmessage_textarea' },
    mes_example: { label: 'Example dialogue', icon: 'fa-comments', paths: ['mes_example', 'data.mes_example'], form: '#mes_example_textarea', alt: 'alt_example_dialogue' },
    system_prompt: { label: 'Main prompt override', icon: 'fa-terminal', paths: ['data.system_prompt'], form: '#system_prompt_textarea', alt: 'alt_main_prompts', hint: 'Replaces your global Main Prompt for this character. Use {{original}} to include the global one.' },
    post_history_instructions: { label: 'Post-history instructions', icon: 'fa-forward', paths: ['data.post_history_instructions'], form: '#post_history_instructions_textarea', alt: 'alt_post_history', hint: 'Sent after the chat history. Use {{original}} to include the global one.' },
    creator_notes: { label: "Creator's notes", icon: 'fa-note-sticky', paths: ['creatorcomment', 'data.creator_notes'], form: '#creator_notes_textarea', hint: 'Not sent to the AI.' },
    creator: { label: 'Created by', icon: 'fa-user-pen', paths: ['data.creator'], form: '#creator_textarea', single: true },
    character_version: { label: 'Version', icon: 'fa-code-branch', paths: ['data.character_version'], form: '#character_version_textarea', single: true },
};

const TABS = [
    { id: 'definition', label: 'Definition' },
    { id: 'greetings', label: 'Greetings' },
    { id: 'examples', label: 'Examples' },
    { id: 'overrides', label: 'Prompt overrides' },
    { id: 'gallery', label: 'Gallery' },
    { id: 'notes', label: 'Lore & notes' },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
    open: false,
    view: 'library',          // 'library' | 'profile'
    filter: { type: 'all', tag: null },
    query: '',
    avatar: null,             // profile character avatar key
    tab: 'definition',
    altView: {},              // field -> index being viewed (null = live value)
    showAllTags: false,
    chats: null,
    bypass: false,            // let the next click through to the classic drawer
};

let hubEl = null;
const pending = new Map();    // debounced saves
let statusTimer = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
        o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
}

const charIndex = (avatar) => ST.characters.findIndex(c => c.avatar === avatar);
const currentChar = () => ST.characters[charIndex(state.avatar)];
const isFav = (c) => c?.fav === true || c?.fav === 'true' || c?.data?.extensions?.fav === true;
const fullAvatar = (c) => (settings().hubHdImages ? `/characters/${encodeURIComponent(c.avatar)}` : thumb('avatar', c.avatar));

function readField(c, key) {
    const f = FIELDS[key];
    for (const p of f.paths) {
        const v = getPath(c, p);
        if (typeof v === 'string' && v.length) return v;
    }
    return '';
}

function entityTags(key) {
    const ids = tag_map[key] ?? [];
    return ids.map(id => allTags.find(t => t.id === id)).filter(Boolean);
}

function relTime(ts) {
    if (!ts) return '';
    const m = toMoment(ts);
    return m?.isValid() ? m.fromNow() : '';
}

function setStatus(text, kind = '') {
    const el = hubEl?.querySelector('.chh-status');
    if (!el) return;
    el.className = `chh-status ${kind}`;
    el.innerHTML = text;
    clearTimeout(statusTimer);
    if (kind === 'ok') statusTimer = setTimeout(() => { el.innerHTML = ''; }, 2500);
}

function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
}

const tokenCache = new Map();
async function tokens(text) {
    if (!text) return 0;
    if (tokenCache.has(text)) return tokenCache.get(text);
    try {
        let n = await getTokenCountAsync(text);
        // SillyTavern caches results; if the tokenizer wasn't ready on the first call, that cached
        // value is 0 forever. A slightly different string skips that cache entry.
        if (!n) n = Math.max(0, (await getTokenCountAsync(`${text}\n`)) - 1);
        if (n > 0) tokenCache.set(text, n);
        return n;
    } catch {
        return Math.round(text.length / 3.6);
    }
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * Writes a set of {path: value} changes to the character card.
 * @param {string} avatar
 * @param {Record<string, any>} changes
 */
async function writeCard(avatar, changes) {
    const idx = charIndex(avatar);
    const c = ST.characters[idx];
    if (!c) throw new Error('Character not found');

    const body = { avatar };
    for (const [p, v] of Object.entries(changes)) setPath(body, p, v);

    const res = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: ST.getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        throw new Error(msg || `HTTP ${res.status}`);
    }

    // keep the in-memory character + its json_data in sync
    for (const [p, v] of Object.entries(changes)) setPath(c, p, v);
    if (c.json_data) {
        try {
            const json = JSON.parse(c.json_data);
            for (const [p, v] of Object.entries(changes)) setPath(json, p, v);
            c.json_data = JSON.stringify(json);
        } catch { /* ignore */ }
    }

    // if the stock editor has this character loaded, update its fields silently
    if (String(idx) === String(ST.this_chid)) {
        $('#character_json_data').val(c.json_data);
    }
}

function syncStockForm(avatar, key, value) {
    if (String(charIndex(avatar)) !== String(ST.this_chid)) return;
    const sel = FIELDS[key]?.form;
    if (sel) $(sel).val(value);
}

/** Debounce helper: one pending job per id; flushSaves() runs them immediately. */
function schedule(id, job, delay = 700) {
    const prev = pending.get(id);
    if (prev) clearTimeout(prev.timer);
    setStatus('<i class="fa-solid fa-circle-notch fa-spin"></i> Saving…');
    const run = async () => {
        pending.delete(id);
        try {
            await job();
            if (!pending.size) setStatus('<i class="fa-solid fa-check"></i> Saved', 'ok');
        } catch (err) {
            console.error(LOG, 'save failed', id, err);
            setStatus('<i class="fa-solid fa-triangle-exclamation"></i> Save failed', 'err');
            toastr.error(`Could not save your change. ${err?.message ?? ''}`);
        }
    };
    pending.set(id, { timer: setTimeout(run, delay), run });
}

/** Debounced save of one field. */
function queueFieldSave(avatar, key, value) {
    schedule(`${avatar}::${key}`, async () => {
        const changes = {};
        for (const p of FIELDS[key].paths) changes[p] = value;
        await writeCard(avatar, changes);
        syncStockForm(avatar, key, value);
    });
}

function queueRawSave(avatar, id, changes, after) {
    schedule(id, async () => {
        await writeCard(avatar, changes);
        after?.();
    });
}

/** Saves alternates through the same API the Alternate Fields extension uses. */
function queueAltSave(avatar) {
    schedule(`${avatar}::alts`, async () => {
        const idx = charIndex(avatar);
        const c = ST.characters[idx];
        await writeExtensionField(idx, 'alternate_fields', c.data.extensions.alternate_fields);
    });
}

/** Runs every pending save right now (used when closing the hub / leaving a profile). */
async function flushSaves() {
    const jobs = [...pending.values()];
    for (const j of jobs) clearTimeout(j.timer);
    await Promise.all(jobs.map(j => j.run()));
}

// ---------------------------------------------------------------------------
// Alternate fields (compatible with nbrown725/SillyTavern-AlternateDescriptions)
// ---------------------------------------------------------------------------

function getAlts(c, key) {
    const f = FIELDS[key];
    if (!f.alt) return null;
    c.data ??= {};
    c.data.extensions ??= {};
    // migrate the extension's very old storage (descriptions only)
    if (key === 'description' && Array.isArray(c.data.extensions.alternate_descriptions) && !c.data.extensions.alternate_fields?.alt_descriptions) {
        const old = c.data.extensions.alternate_descriptions;
        c.data.extensions.alternate_fields ??= {};
        c.data.extensions.alternate_fields.alt_descriptions = old.map((d, i) => (typeof d === 'string'
            ? { title: `Description #${i + 1}`, content: d }
            : { title: d.title ?? `Description #${i + 1}`, content: d.content ?? d.description ?? '' }));
    }
    c.data.extensions.alternate_fields ??= {};
    c.data.extensions.alternate_fields[f.alt] ??= [];
    return c.data.extensions.alternate_fields[f.alt];
}

const altMatch = (alts, value) => alts.findIndex(a => (a.content ?? '').trim() === (value ?? '').trim() && (a.content ?? '').trim() !== '');

// ---------------------------------------------------------------------------
// Hub shell
// ---------------------------------------------------------------------------

function positionHub() {
    if (!hubEl) return;
    const rail = document.getElementById('top-settings-holder') ?? document.getElementById('top-bar');
    const r = rail?.getBoundingClientRect();
    hubEl.style.left = hubEl.style.top = '0px';
    if (r && r.width && r.height) {
        if (r.height > r.width * 2) hubEl.style.left = `${Math.round(r.right)}px`;
        else hubEl.style.top = `${Math.round(r.bottom)}px`;
    }
    // the preset sidebar takes the place of the hub's own right column
    const side = sidebarOpen() ? sidebarWidth() : 0;
    hubEl.style.right = `${side}px`;
    hubEl.classList.toggle('chh-with-sidebar', side > 0);
}

function hubAllowed() {
    return settings().enabled !== false && settings().hubEnabled && window.matchMedia('(min-width: 1000px)').matches;
}

export function openHub(view = 'library', avatar = null) {
    if (!hubEl) {
        hubEl = document.createElement('div');
        hubEl.id = 'chh-hub';
        hubEl.className = 'chh';
        document.body.append(hubEl);
        hubEl.addEventListener('click', onHubClick);
        hubEl.addEventListener('input', onHubInput);
        hubEl.addEventListener('change', onHubChange);
        hubEl.addEventListener('keydown', onHubKey);
    }
    beforeHubOpens();
    // close the stock drawer if it is open
    if ($('#right-nav-panel').hasClass('openDrawer') && !$('#right-nav-panel').hasClass('pinnedOpen')) {
        state.bypass = true;
        $('#unimportantYes').trigger('click');
        state.bypass = false;
    }
    state.open = true;
    document.body.classList.add('chh-open');
    $('#rightNavDrawerIcon').removeClass('closedIcon').addClass('openIcon');
    positionHub();
    if (view === 'profile' && avatar) showProfile(avatar);
    else showLibrary();
}

export function closeHub() {
    if (!state.open) return;
    void flushSaves();
    state.open = false;
    document.body.classList.remove('chh-open');
    $('#rightNavDrawerIcon').removeClass('openIcon').addClass('closedIcon');
    if (hubEl) hubEl.innerHTML = '';
}

function openClassic() {
    closeHub();
    state.bypass = true;
    $('#unimportantYes').trigger('click');
    state.bypass = false;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

function libraryEntities() {
    const s = settings();
    const q = state.query.trim().toLowerCase();
    const { type, tag } = state.filter;
    let list;

    if (type === 'groups') {
        list = Groups.groups.map(g => ({ kind: 'group', key: g.id, name: g.name, g, last: Number(g.date_last_chat) || 0, added: Number(g.date_added) || 0, size: 0 }));
    } else {
        list = ST.characters.map(c => ({
            kind: 'char', key: c.avatar, name: c.name, c,
            last: Number(c.date_last_chat) || 0,
            added: Number(c.date_added) || 0,
            size: Number(c.chat_size) || 0,
        }));
        if (type === 'fav') list = list.filter(e => isFav(e.c));
        if (type === 'recent') list = list.filter(e => e.last > 0);
        if (type === 'tag') list = list.filter(e => (tag_map[e.key] ?? []).includes(tag));
        if (type === 'untagged') list = list.filter(e => !(tag_map[e.key] ?? []).length);
    }

    if (q) {
        list = list.filter((e) => {
            if (e.name?.toLowerCase().includes(q)) return true;
            if (e.c?.data?.creator?.toLowerCase().includes(q)) return true;
            return entityTags(e.key).some(t => t.name.toLowerCase().includes(q));
        });
    }

    const sort = type === 'recent' ? 'recent' : s.hubSort;
    const cmp = {
        recent: (a, b) => b.last - a.last || a.name.localeCompare(b.name),
        name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        added: (a, b) => b.added - a.added,
        size: (a, b) => b.size - a.size,
    }[sort] ?? ((a, b) => b.last - a.last);
    list.sort(cmp);
    if (type === 'recent') list = list.slice(0, 40);
    return list;
}

function sidebarHtml() {
    const { type, tag } = state.filter;
    const chars = ST.characters;
    const counts = {
        all: chars.length,
        recent: Math.min(40, chars.filter(c => Number(c.date_last_chat) > 0).length),
        fav: chars.filter(isFav).length,
        groups: Groups.groups.length,
        untagged: chars.filter(c => !(tag_map[c.avatar] ?? []).length).length,
    };
    const tagCounts = new Map();
    for (const c of chars) for (const id of tag_map[c.avatar] ?? []) tagCounts.set(id, (tagCounts.get(id) ?? 0) + 1);
    const usedTags = allTags.filter(t => tagCounts.get(t.id)).sort((a, b) => a.name.localeCompare(b.name));

    const item = (t, icon, label, n, extra = '') => `<div class="chh-nav${type === t && !extra ? ' on' : ''}" data-nav="${t}" tabindex="0" role="button">${icon}<span>${esc(label)}</span><small>${n}</small></div>`;
    return `
        ${item('all', '<i class="fa-solid fa-users-rectangle fa-fw"></i>', 'All characters', counts.all)}
        ${item('recent', '<i class="fa-solid fa-clock-rotate-left fa-fw"></i>', 'Recently chatted', counts.recent)}
        ${item('fav', '<i class="fa-solid fa-star fa-fw"></i>', 'Favorites', counts.fav)}
        ${item('groups', '<i class="fa-solid fa-user-group fa-fw"></i>', 'Groups', counts.groups)}
        <h4>Tags</h4>
        <div class="chh-tagnav">
        ${usedTags.map(t => `<div class="chh-nav${type === 'tag' && tag === t.id ? ' on' : ''}" data-nav="tag" data-tag="${esc(t.id)}" tabindex="0" role="button">
            <span class="chh-dot" style="background:${esc(t.color || 'var(--chh-muted)')}"></span><span>${esc(t.name)}</span><small>${tagCounts.get(t.id)}</small></div>`).join('')}
        ${counts.untagged ? item('untagged', '<span class="chh-dot chh-dot-empty"></span>', 'Untagged', counts.untagged) : ''}
        </div>`;
}

function tagChips(key, limit) {
    const list = entityTags(key);
    const shown = list.slice(0, limit);
    const rest = list.length - shown.length;
    return shown.map(t => `<span class="chh-tag" ${t.color ? `style="--chh-tag:${esc(t.color)}"` : ''}>${esc(t.name)}</span>`).join('')
        + (rest > 0 ? `<span class="chh-tag chh-tag-more" title="${esc(list.slice(limit).map(t => t.name).join(', '))}">+${rest}</span>` : '');
}

function cardHtml(e) {
    const s = settings();
    if (e.kind === 'group') {
        return `<div class="chh-card chh-card-group" data-group="${esc(e.key)}" tabindex="0">
            <div class="chh-card-img chh-group-slot"></div>
            <div class="chh-card-ov"><button data-act="open-group"><i class="fa-solid fa-comment"></i> Open</button></div>
            <div class="chh-card-meta"><div class="chh-card-name">${esc(e.name)}</div>
            <div class="chh-card-sub">${e.g.members?.length ?? 0} members${e.last ? ` · ${esc(relTime(e.last))}` : ''}</div></div></div>`;
    }
    const c = e.c;
    return `<div class="chh-card" data-avatar="${esc(c.avatar)}" tabindex="0">
        <div class="chh-card-img"><img src="${esc(fullAvatar(c))}" alt="" loading="lazy" decoding="async"></div>
        ${isFav(c) ? '<i class="fa-solid fa-star chh-card-fav"></i>' : ''}
        <div class="chh-card-ov">
            <button data-act="continue" title="Continue the last chat"><i class="fa-solid fa-comment"></i> Continue</button>
            <button data-act="newchat" title="Start a new chat"><i class="fa-solid fa-plus"></i></button>
            <button data-act="edit" title="Open profile"><i class="fa-solid fa-pen"></i></button>
        </div>
        <div class="chh-card-meta">
            <div class="chh-card-name" title="${esc(c.name)}">${esc(c.name)}</div>
            <div class="chh-card-sub">${e.last ? `Last chat ${esc(relTime(e.last))}` : 'No chats yet'}</div>
            <div class="chh-tags">${tagChips(c.avatar, s.hubTagLimit)}</div>
        </div>
    </div>`;
}

function showLibrary() {
    state.view = 'library';
    state.avatar = null;
    const s = settings();
    const list = libraryEntities();
    const { type, tag } = state.filter;
    const title = type === 'tag' ? (allTags.find(t => t.id === tag)?.name ?? 'Tag')
        : { all: 'All characters', recent: 'Recently chatted', fav: 'Favorites', groups: 'Groups', untagged: 'Untagged' }[type];

    hubEl.innerHTML = `
    <div class="chh-lib">
        <aside class="chh-side">${sidebarHtml()}</aside>
        <section class="chh-main">
            <header class="chh-top">
                <i class="fa-solid fa-hashtag chh-muted"></i><span class="chh-title">${esc(title)}</span><span class="chh-muted">· ${list.length}</span>
                <label class="chh-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" data-input="query" placeholder="Search name, tag, creator…" value="${esc(state.query)}"></label>
                <select class="chh-select" data-input="sort" title="Sort" ${type === 'recent' ? 'disabled' : ''}>
                    ${[['recent', 'Last chatted'], ['name', 'Name'], ['added', 'Date added'], ['size', 'Most chatted']].map(([v, l]) => `<option value="${v}"${s.hubSort === v ? ' selected' : ''}>${l}</option>`).join('')}
                </select>
                <button class="chh-btn" data-act="import" title="Import character file"><i class="fa-solid fa-file-import"></i><span>Import</span></button>
                <button class="chh-btn chh-primary" data-act="create" title="Create a new character"><i class="fa-solid fa-plus"></i><span>New</span></button>
                <button class="chh-icon" data-act="classic" title="Open the classic character panel"><i class="fa-solid fa-table-list"></i></button>
                <button class="chh-icon" data-act="close" title="Close (Esc)"><i class="fa-solid fa-xmark"></i></button>
            </header>
            <div class="chh-grid" style="--chh-card:${Number(s.hubCardSize) || 160}px">
                ${list.length ? list.map(cardHtml).join('') : '<div class="chh-empty">Nothing here.</div>'}
            </div>
        </section>
    </div>`;

    hubEl.querySelectorAll('.chh-card-group').forEach((el) => {
        const g = Groups.groups.find(x => x.id === el.getAttribute('data-group'));
        const slot = el.querySelector('.chh-group-slot');
        if (g && slot && typeof Groups.getGroupAvatar === 'function') {
            try { $(slot).append(Groups.getGroupAvatar(g)); } catch { /* ignore */ }
        }
    });
    if (state.query) {
        const input = hubEl.querySelector('[data-input="query"]');
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }
}

function refreshGrid() {
    const grid = hubEl.querySelector('.chh-grid');
    if (!grid) return showLibrary();
    const list = libraryEntities();
    grid.innerHTML = list.length ? list.map(cardHtml).join('') : '<div class="chh-empty">Nothing matches.</div>';
    const n = hubEl.querySelector('.chh-top .chh-muted:nth-of-type(2)');
    if (n) n.textContent = `· ${list.length}`;
    hubEl.querySelectorAll('.chh-card-group').forEach((el) => {
        const g = Groups.groups.find(x => x.id === el.getAttribute('data-group'));
        const slot = el.querySelector('.chh-group-slot');
        if (g && slot) try { $(slot).append(Groups.getGroupAvatar(g)); } catch { /* ignore */ }
    });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

async function showProfile(avatar) {
    await flushSaves();
    const idx = charIndex(avatar);
    if (idx < 0) return showLibrary();
    hubEl.innerHTML = '<div class="chh-loading"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
    try {
        if (ST.characters[idx].shallow && typeof ST.unshallowCharacter === 'function') await ST.unshallowCharacter(String(idx));
    } catch (err) {
        console.warn(LOG, 'unshallow failed', err);
    }
    state.view = 'profile';
    if (state.avatar !== avatar) {
        state.avatar = avatar;
        state.altView = {};
        state.showAllTags = false;
        state.chats = null;
    }
    renderProfile();
    loadChats(avatar);
}

function headerTagsHtml(c) {
    const list = entityTags(c.avatar);
    const limit = state.showAllTags ? list.length : 8;
    const shown = list.slice(0, limit);
    const rest = list.length - shown.length;
    return shown.map(t => `<span class="chh-tag chh-tag-x" ${t.color ? `style="--chh-tag:${esc(t.color)}"` : ''}>${esc(t.name)}<i class="fa-solid fa-xmark" data-act="untag" data-tag="${esc(t.id)}" title="Remove tag"></i></span>`).join('')
        + (rest > 0 ? `<button class="chh-tag chh-tag-more" data-act="alltags">+${rest} more</button>` : '')
        + (state.showAllTags && list.length > 8 ? '<button class="chh-tag chh-tag-more" data-act="alltags">less</button>' : '')
        + `<span class="chh-tag-add"><input list="chh-taglist" data-input="newtag" placeholder="+ tag" size="6"><datalist id="chh-taglist">${allTags.map(t => `<option value="${esc(t.name)}">`).join('')}</datalist></span>`;
}

function renderProfile() {
    const c = currentChar();
    if (!c) return showLibrary();
    const img = fullAvatar(c);
    const altGreets = c.data?.alternate_greetings ?? [];
    const tabLabel = (t) => t.id === 'greetings' ? `${t.label} <small>${1 + altGreets.length}</small>` : t.label;

    hubEl.innerHTML = `
    <div class="chh-prof">
        <header class="chh-top">
            <button class="chh-btn" data-act="back"><i class="fa-solid fa-arrow-left"></i><span>Library</span></button>
            <span class="chh-muted chh-crumb">${esc(state.filter.type === 'tag' ? (allTags.find(t => t.id === state.filter.tag)?.name ?? '') : 'Characters')} ›</span>
            <span class="chh-title">${esc(c.name)}</span>
            <span class="chh-status"></span>
            <button class="chh-icon" data-act="classic-edit" title="Open in the classic editor"><i class="fa-solid fa-table-list"></i></button>
            <button class="chh-icon" data-act="close" title="Close (Esc)"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <div class="chh-prof-body">
            <div class="chh-prof-main">
                <div class="chh-banner" style="--chh-banner:url('${esc(img)}')">
                    <div class="chh-pavatar"><img src="${esc(img)}" alt=""></div>
                </div>
                <div class="chh-phead">
                    <div class="chh-pinfo">
                        <div class="chh-pname">${esc(c.name)} <button class="chh-favbtn${isFav(c) ? ' on' : ''}" data-act="fav" title="Favorite"><i class="fa-solid fa-star"></i></button></div>
                        <div class="chh-pby">${c.data?.creator ? `by ${esc(c.data.creator)}` : '<span class="chh-muted">No creator</span>'}${c.data?.character_version ? ` · v${esc(c.data.character_version)}` : ''}</div>
                        <div class="chh-tags chh-ptags">${headerTagsHtml(c)}</div>
                    </div>
                    <div class="chh-pacts">
                        <button class="chh-btn chh-primary" data-act="continue"><i class="fa-solid fa-comment"></i><span>Continue chat</span></button>
                        <button class="chh-btn" data-act="newchat"><i class="fa-solid fa-plus"></i><span>New chat</span></button>
                        <div class="chh-menu-wrap">
                            <button class="chh-btn" data-act="menu" title="More"><i class="fa-solid fa-ellipsis"></i></button>
                            <div class="chh-menu" hidden>
                                <button data-act="export"><i class="fa-solid fa-file-export fa-fw"></i>Export PNG</button>
                                <button data-act="assistant"><i class="fa-solid fa-robot fa-fw"></i>Set as welcome assistant</button>
                                <button data-act="classic-edit"><i class="fa-solid fa-table-list fa-fw"></i>Rename / avatar (classic editor)</button>
                                <button data-act="delete" class="chh-danger"><i class="fa-solid fa-trash fa-fw"></i>Delete character…</button>
                            </div>
                        </div>
                    </div>
                </div>
                <nav class="chh-tabs">${TABS.map(t => `<button data-tab="${t.id}" class="${state.tab === t.id ? 'on' : ''}">${tabLabel(t)}</button>`).join('')}</nav>
                <div class="chh-tabbody"></div>
            </div>
            <aside class="chh-pside"></aside>
        </div>
    </div>`;
    renderTab();
    renderSide();
}

// ----- field cards -----

function fieldCardHtml(c, key, { wide = true, extra = '' } = {}) {
    const f = FIELDS[key];
    const alts = getAlts(c, key);
    const live = readField(c, key);
    let shown = live;
    let altBar = '';
    let cls = '';
    let altLabel = '';
    if (alts) {
        let i = state.altView[key];
        if (i === undefined) i = state.altView[key] = (altMatch(alts, live) >= 0 ? altMatch(alts, live) : null);
        const n = alts.length;
        if (i !== null) shown = i < n ? (alts[i].content ?? '') : '';
        const active = i === null || (i < n && altMatch([alts[i]], live) === 0);
        const pos = i === null ? (n ? 'current' : '') : (i < n ? `${i + 1}/${n}` : 'new');
        const title = i !== null && i < n ? (alts[i].title || `#${i + 1}`) : '';
        cls = n || i !== null ? (active ? ' chh-alt-active' : ' chh-alt-inactive') : '';
        if (i !== null && i >= n) altLabel = '<span class="chh-alt-name">new version</span>';
        else if (n && i !== null) altLabel = `<span class="chh-alt-name${active ? ' on' : ''}">${esc(title)}${active ? ' · in use' : ' · not in use'}</span>`;
        altBar = `<div class="chh-alt" data-field="${key}">
            <button data-act="alt-prev" title="Previous version" ${i === 0 || (i === null && !n) ? 'disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
            <button data-act="alt-lock" class="${active && n ? 'on' : ''}" title="${active ? 'This version is in use' : 'Use this version'}" ${active || (i !== null && i >= n) ? 'disabled' : ''}><i class="fa-solid ${active ? 'fa-lock' : 'fa-lock-open'}"></i></button>
            <button data-act="alt-next" title="Next version (the last one is a new, empty slot)" ${i !== null && i >= n ? 'disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
            <small title="${esc(title)}">${esc(pos)}</small>
        </div>`;
    }
    return `<div class="chh-field${wide ? ' wide' : ''}${cls}" data-field="${key}">
        <div class="chh-fh"><i class="fa-solid ${f.icon} fa-fw"></i>${esc(f.label)}${altLabel}${extra}<span class="chh-tk" data-tk="${key}"></span></div>
        ${f.hint ? `<div class="chh-hint">${esc(f.hint)}</div>` : ''}
        <div class="chh-fbody">
            <textarea data-field="${key}" spellcheck="true" rows="2" placeholder="${(state.altView[key] ?? null) !== null && (state.altView[key] >= (alts?.length ?? 0)) ? 'New version — start typing…' : 'Empty — click to write'}">${esc(shown)}</textarea>
            ${altBar}
        </div>
    </div>`;
}

function singleInputHtml(c, key) {
    const f = FIELDS[key];
    return `<label class="chh-single"><span><i class="fa-solid ${f.icon} fa-fw"></i>${esc(f.label)}</span><input type="text" data-field="${key}" value="${esc(readField(c, key))}"></label>`;
}

function renderTab() {
    const c = currentChar();
    const body = hubEl.querySelector('.chh-tabbody');
    if (!c || !body) return;
    hubEl.querySelectorAll('.chh-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));

    if (state.tab === 'definition') {
        const dp = c.data?.extensions?.depth_prompt ?? {};
        body.innerHTML = `<div class="chh-fields">
            ${fieldCardHtml(c, 'description')}
            ${fieldCardHtml(c, 'personality', { wide: false })}
            ${fieldCardHtml(c, 'scenario', { wide: false })}
            ${fieldCardHtml(c, 'depth_prompt', { extra: `<span class="chh-fh-ctl">depth <input type="number" min="0" max="9999" data-input="dp-depth" value="${Number(dp.depth ?? 4)}">
                <select data-input="dp-role">${['system', 'user', 'assistant'].map(r => `<option${(dp.role ?? 'system') === r ? ' selected' : ''}>${r}</option>`).join('')}</select></span>` })}
        </div>`;
    } else if (state.tab === 'greetings') {
        const alts = c.data?.alternate_greetings ?? [];
        body.innerHTML = `<div class="chh-fields">
            ${fieldCardHtml(c, 'first_mes')}
            ${alts.map((g, i) => `<div class="chh-field wide" data-greet="${i}">
                <div class="chh-fh"><i class="fa-solid fa-comment-dots fa-fw"></i>Alternate greeting ${i + 1}<span class="chh-tk"></span>
                <button class="chh-icon chh-sm" data-act="greet-del" data-i="${i}" title="Delete this greeting"><i class="fa-solid fa-trash"></i></button></div>
                <div class="chh-fbody"><textarea data-greet="${i}" rows="2">${esc(g)}</textarea></div></div>`).join('')}
            <button class="chh-btn chh-add" data-act="greet-add"><i class="fa-solid fa-plus"></i><span>Add alternate greeting</span></button>
        </div>`;
    } else if (state.tab === 'examples') {
        body.innerHTML = `<div class="chh-fields">${fieldCardHtml(c, 'mes_example')}</div>`;
    } else if (state.tab === 'overrides') {
        body.innerHTML = `<div class="chh-fields">${fieldCardHtml(c, 'system_prompt')}${fieldCardHtml(c, 'post_history_instructions')}</div>`;
    } else if (state.tab === 'gallery') {
        body.innerHTML = '<div class="chh-gallery"><div class="chh-empty"><i class="fa-solid fa-circle-notch fa-spin"></i></div></div>';
        loadGallery(c);
    } else if (state.tab === 'notes') {
        const talk = Number(c.talkativeness ?? c.data?.extensions?.talkativeness ?? 0.5);
        body.innerHTML = `<div class="chh-fields">
            <div class="chh-field wide chh-meta-grid">
                ${singleInputHtml(c, 'creator')}
                ${singleInputHtml(c, 'character_version')}
                <label class="chh-single"><span><i class="fa-solid fa-comments fa-fw"></i>Talkativeness <small class="chh-muted">(group chats)</small></span>
                    <span class="chh-range"><input type="range" min="0" max="1" step="0.05" data-input="talk" value="${talk}"><output>${talk.toFixed(2)}</output></span></label>
                <div class="chh-single"><span><i class="fa-solid fa-calendar fa-fw"></i>Created</span><div class="chh-ro" title="${esc(c.create_date || '')}">${esc(c.create_date && moment(c.create_date).isValid() ? moment(c.create_date).format('LL') : (c.create_date || '—'))}</div></div>
                <div class="chh-single"><span><i class="fa-solid fa-file-image fa-fw"></i>File</span><div class="chh-ro">${esc(c.avatar)}</div></div>
            </div>
            ${fieldCardHtml(c, 'creator_notes')}
        </div>`;
    }
    body.querySelectorAll('textarea').forEach(autosize);
    updateTokenBadges();
}

let tokenRetries = 0;
async function updateTokenBadges() {
    const c = currentChar();
    if (!c || !hubEl) return;
    let missing = false;
    for (const el of hubEl.querySelectorAll('.chh-tabbody .chh-field')) {
        const ta = el.querySelector('textarea');
        const badge = el.querySelector('.chh-tk');
        if (!ta || !badge) continue;
        const n = await tokens(ta.value);
        if (ta.value.trim() && !n) missing = true;
        badge.textContent = ta.value ? (n ? `${n.toLocaleString()} tokens` : '… tokens') : '';
    }
    await renderBudget();
    // right after a page load the tokenizer can still be warming up and return 0: try again shortly
    if (missing && tokenRetries < 8) {
        tokenRetries++;
        setTimeout(updateTokenBadges, 1500);
    } else if (!missing) {
        tokenRetries = 0;
    }
}

// ----- right column -----

function renderSide() {
    const side = hubEl.querySelector('.chh-pside');
    const c = currentChar();
    if (!side || !c) return;
    const books = linkedBooks(c);
    const personas = connectedPersonas(c.avatar);
    side.innerHTML = `
        <h4>Chats ${state.chats ? `<small>${state.chats.length}</small>` : ''}</h4>
        <div class="chh-chats">${chatsHtml()}</div>
        <h4>Token budget</h4>
        <div class="chh-budget"></div>
        <h4>Lorebooks</h4>
        <div class="chh-linked">
            ${bookRow('fa-book', 'Character', books.primary ? [books.primary] : [], 'Primary lorebook bound to the card', 'primary')}
            ${bookRow('fa-book-medical', 'Additional', books.extra, 'Auxiliary lorebooks linked to this character', 'extra')}
            ${bookRow('fa-book-bookmark', 'Chat', books.chat, 'Lorebooks bound to individual chats of this character (change them from inside the chat)', 'chat')}
        </div>
        <h4>Personas</h4>
        <div class="chh-linked">${personas.length ? personas.map(p => `<div class="chh-persona"><img src="${esc(thumb('persona', p))}" alt=""><span>${personaLabelHtml(p)}</span></div>`).join('') : '<span class="chh-muted">No connected persona</span>'}</div>`;
    renderBudget();
}

function bookRow(icon, label, names, tip, kind) {
    const editable = kind !== 'chat';
    const chips = names.map((n) => {
        const name = n.name ?? n;
        return `<span class="chh-bookchip"><button class="chh-link" data-act="book" data-book="${esc(name)}" title="Open in the lorebook editor">${esc(name)}${n.count ? ` <small>×${n.count}</small>` : ''}</button>${editable ? `<button class="chh-bookx" data-act="book-unbind" data-kind="${kind}" data-book="${esc(name)}" title="Unbind ${esc(name)}"><i class="fa-solid fa-xmark"></i></button>` : ''}</span>`;
    }).join('');
    const add = !editable ? '' : (kind === 'primary' && names.length
        ? `<button class="chh-bookadd" data-act="book-add" data-kind="primary" title="Change the character lorebook"><i class="fa-solid fa-arrow-right-arrow-left"></i></button>`
        : `<button class="chh-bookadd" data-act="book-add" data-kind="${kind}" title="${kind === 'primary' ? 'Bind a character lorebook' : 'Add an additional lorebook'}"><i class="fa-solid fa-plus"></i></button>`);
    return `<div class="chh-book" title="${esc(tip)}"><span class="chh-book-l"><i class="fa-solid ${icon} fa-fw"></i>${label}</span>
        <span class="chh-book-r">${chips || (editable ? '' : '<span class="chh-muted">—</span>')}${add}</span></div>`;
}

// ----- lorebook binding -----

function closePicker() {
    hubEl?.querySelector('.chh-picker')?.remove();
}

function openBookPicker(anchor, kind) {
    closePicker();
    const c = currentChar();
    const books = linkedBooks(c);
    const taken = new Set(kind === 'primary' ? [books.primary] : [books.primary, ...books.extra]);
    const names = [...(world_names ?? [])].filter(n => !taken.has(n)).sort((a, b) => a.localeCompare(b));
    const el = document.createElement('div');
    el.className = 'chh-picker';
    el.innerHTML = `<div class="chh-picker-h">${kind === 'primary' ? 'Character lorebook' : 'Add additional lorebook'}</div>
        <input type="search" class="chh-picker-q" placeholder="Filter lorebooks…">
        <div class="chh-picker-list">${names.length ? names.map(n => `<button data-pick="${esc(n)}"><i class="fa-solid fa-book fa-fw"></i><span>${esc(n)}</span></button>`).join('') : '<div class="chh-muted">No other lorebooks.</div>'}</div>`;
    hubEl.append(el);
    const r = anchor.getBoundingClientRect();
    const h = hubEl.getBoundingClientRect();
    el.style.top = `${Math.min(r.bottom - h.top + 6, h.height - el.offsetHeight - 10)}px`;
    el.style.left = `${Math.max(8, r.right - h.left - el.offsetWidth)}px`;
    const q = el.querySelector('.chh-picker-q');
    q.focus();
    q.addEventListener('input', () => {
        const v = q.value.trim().toLowerCase();
        el.querySelectorAll('[data-pick]').forEach(b => b.classList.toggle('chh-hidden', !!v && !b.dataset.pick.toLowerCase().includes(v)));
    });
    el.addEventListener('click', (e) => {
        e.stopPropagation();
        const b = /** @type {HTMLElement} */ (e.target).closest('[data-pick]');
        if (!b) return;
        closePicker();
        bindBook(kind, b.dataset.pick, true);
    });
}

async function bindBook(kind, name, on) {
    const c = currentChar();
    if (!c) return;
    try {
        if (kind === 'primary') {
            const value = on ? name : '';
            await writeCard(c.avatar, { 'data.extensions.world': value });
            if (String(charIndex(c.avatar)) === String(ST.this_chid)) $('#character_world').val(value);
        } else {
            const fileName = c.avatar.replace(/\.[^.]+$/, '');
            const current = linkedBooks(c).extra;
            charSetAuxWorlds(fileName, on ? [...current, name] : current.filter(n => n !== name));
        }
        setStatus('<i class="fa-solid fa-check"></i> Saved', 'ok');
    } catch (err) {
        console.error(LOG, 'lorebook bind failed', err);
        toastr.error(`Could not change the lorebook. ${err?.message ?? ''}`);
    }
    renderSide();
}

function linkedBooks(c) {
    const fileName = c.avatar.replace(/\.[^.]+$/, '');
    const primary = c.data?.extensions?.world || '';
    const extra = (world_info?.charLore ?? []).find(e => e.name === fileName)?.extraBooks ?? [];
    const chatMap = new Map();
    for (const ch of state.chats ?? []) {
        const b = ch.chat_metadata?.world_info;
        if (b) chatMap.set(b, (chatMap.get(b) ?? 0) + 1);
    }
    return { primary, extra, chat: [...chatMap].map(([name, count]) => ({ name, count })) };
}

function connectedPersonas(avatar) {
    return Object.entries(power_user?.persona_descriptions ?? {})
        .filter(([, d]) => d?.connections?.some(x => x.type === 'character' && x.id === avatar))
        .map(([k]) => k);
}

function chatsHtml() {
    if (!state.chats) return '<div class="chh-muted"><i class="fa-solid fa-circle-notch fa-spin"></i></div>';
    if (!state.chats.length) return '<div class="chh-muted">No chats yet</div>';
    const c = currentChar();
    const folder = { isGroup: false, id: c.avatar };
    const prefix = `${c.name} - `;
    return state.chats.slice(0, state.allChats ? undefined : 6).map((ch) => {
        const name = String(ch.file_name).replace(/\.jsonl$/, '');
        const title = name.startsWith(prefix) && settings().stripCharName ? name.slice(prefix.length) : name;
        const p = resolvePersona(ch, folder);
        const pName = p ? (power_user.personas?.[p.avatar] ?? p.avatar) : '';
        return `<div class="chh-chat" data-chat="${esc(name)}" tabindex="0" role="button" title="${esc(name)}">
            <div class="chh-chat-t">${esc(title)}</div>
            <div class="chh-chat-p">${p ? `<img src="${esc(thumb('persona', p.avatar))}" alt="" class="${p.source !== 'chat' ? 'dim' : ''}"><span>${personaLabelHtml(p.avatar)}</span>${p.source === 'chat' ? '<i class="fa-solid fa-lock fa-2xs"></i>' : ''} · ` : ''}<span>${esc(relTime(ch._ts))}</span> · <span>${Number(ch.chat_items) || 0} msgs</span></div>
        </div>`;
    }).join('') + (state.chats.length > 6 ? `<button class="chh-link" data-act="allchats">${state.allChats ? 'Show fewer' : `Show all ${state.chats.length}`}</button>` : '');
}

async function loadChats(avatar) {
    try {
        const res = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: ST.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, metadata: true }),
        });
        const data = await res.json();
        const list = Array.isArray(data) ? data : [];
        for (const ch of list) {
            const m = toMoment(ch.last_mes);
            ch._ts = m?.isValid() ? m.valueOf() : 0;
        }
        list.sort((a, b) => b._ts - a._ts);
        if (state.avatar !== avatar) return;
        state.chats = list;
    } catch (err) {
        console.warn(LOG, 'chats failed', err);
        state.chats = [];
    }
    if (state.view === 'profile') renderSide();
}

async function renderBudget() {
    const el = hubEl?.querySelector('.chh-budget');
    const c = currentChar();
    if (!el || !c) return;
    const parts = [
        ['Description', readField(c, 'description'), 'var(--chh-c1)'],
        ['Personality', readField(c, 'personality'), 'var(--chh-c2)'],
        ['Scenario', readField(c, 'scenario'), 'var(--chh-c3)'],
        ["Character's note", readField(c, 'depth_prompt'), 'var(--chh-c4)'],
    ];
    const temp = [
        ['First message', readField(c, 'first_mes'), 'var(--chh-c5)'],
        ['Examples', readField(c, 'mes_example'), 'var(--chh-c6)'],
    ];
    const counts = await Promise.all([...parts, ...temp].map(p => tokens(p[1])));
    const perm = counts.slice(0, parts.length).reduce((a, b) => a + b, 0);
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    el.innerHTML = `<div class="chh-bar">${[...parts, ...temp].map((p, i) => counts[i] ? `<i style="width:${(counts[i] / total) * 100}%;background:${p[2]}" title="${esc(p[0])}: ${counts[i]}"></i>` : '').join('')}</div>
        <div class="chh-kv"><span>Permanent <i class="fa-solid fa-circle-info chh-muted" title="Sent with every message: description, personality, scenario, character's note"></i></span><b>${perm.toLocaleString()}</b></div>
        <div class="chh-kv"><span>With greeting + examples</span><b>${counts.reduce((a, b) => a + b, 0).toLocaleString()}</b></div>`;
}

// ----- gallery -----

async function loadGallery(c) {
    const box = hubEl.querySelector('.chh-gallery');
    try {
        const folder = extension_settings.gallery?.folders?.[c.avatar] ?? c.name;
        const res = await fetch('/api/images/list', {
            method: 'POST',
            headers: ST.getRequestHeaders(),
            body: JSON.stringify({ folder, sortField: 'date', sortOrder: 'desc', type: 0b011 }),
        });
        const files = res.ok ? await res.json() : [];
        const safe = await getSanitizedFilename(folder);
        if (!box?.isConnected || state.avatar !== c.avatar) return;
        if (!files.length) {
            box.innerHTML = `<div class="chh-empty"><i class="fa-regular fa-images"></i> No images yet.<br><small>Put images in <code>user/images/${esc(safe)}</code> or drop them into SillyTavern's gallery.</small></div>`;
            return;
        }
        box.innerHTML = files.map((f) => {
            const src = `user/images/${encodeURIComponent(safe)}/${encodeURIComponent(f)}`;
            return /\.(mp4|webm|mov|mkv)$/i.test(f)
                ? `<a class="chh-gimg" href="${esc(src)}" target="_blank"><video src="${esc(src)}" muted preload="metadata"></video></a>`
                : `<a class="chh-gimg" href="${esc(src)}" data-act="zoom" target="_blank"><img src="${esc(src)}" loading="lazy" alt=""></a>`;
        }).join('');
    } catch (err) {
        console.warn(LOG, 'gallery failed', err);
        if (box) box.innerHTML = '<div class="chh-empty">Could not load the gallery.</div>';
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

async function openCharacterChat(avatar, chatName = null, fresh = false) {
    const idx = charIndex(avatar);
    if (idx < 0) return;
    closeHub();
    try {
        await ST.selectCharacterById(idx);
        if (fresh) await ST.doNewChat({ deleteCurrentChat: false });
        else if (chatName && ST.getCurrentChatId() !== chatName) await ST.openCharacterChat(chatName);
    } catch (err) {
        console.error(LOG, err);
        toastr.error('Could not open the chat.');
    }
}

function onHubKey(e) {
    if (e.key === 'Escape' && !document.querySelector('.popup[open], dialog[open]')) {
        e.stopPropagation();
        closeHub();
        return;
    }
    const t = /** @type {HTMLElement} */ (e.target);
    if ((e.key === 'Enter' || e.key === ' ') && t.matches('.chh-card, .chh-nav, .chh-chat')) {
        e.preventDefault();
        t.click();
    }
    if (e.key === 'Enter' && t.matches('[data-input="newtag"]')) {
        e.preventDefault();
        addTag(/** @type {HTMLInputElement} */ (t).value);
    }
}

function addTag(name) {
    name = String(name ?? '').trim();
    const c = currentChar();
    if (!name || !c) return;
    let tag = allTags.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (!tag) {
        tag = {
            id: crypto.randomUUID(), name, folder_type: 'NONE', filter_state: 'UNDEFINED',
            sort_order: Math.max(0, ...allTags.map(t => t.sort_order ?? 0)) + 1,
            is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now(),
        };
        allTags.push(tag);
    }
    addTagsToEntity(tag, c.avatar);
    const box = hubEl.querySelector('.chh-ptags');
    if (box) box.innerHTML = headerTagsHtml(c);
    hubEl.querySelector('[data-input="newtag"]')?.focus();
}

async function onHubClick(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    // close an open ⋯ menu / lorebook picker when clicking elsewhere
    if (!t.closest('.chh-menu-wrap')) hubEl.querySelectorAll('.chh-menu').forEach(m => m.hidden = true);
    if (!t.closest('.chh-picker, [data-act="book-add"]')) closePicker();

    const nav = t.closest('.chh-nav');
    if (nav) {
        state.filter = { type: nav.dataset.nav, tag: nav.dataset.tag ?? null };
        return showLibrary();
    }
    const tabBtn = t.closest('[data-tab]');
    if (tabBtn) {
        state.tab = tabBtn.dataset.tab;
        return renderTab();
    }
    const chatEl = t.closest('.chh-chat');
    if (chatEl) return openCharacterChat(state.avatar, chatEl.dataset.chat);

    const btn = t.closest('[data-act]');
    const card = t.closest('.chh-card');
    const act = btn?.getAttribute('data-act');
    const c = currentChar();

    switch (act) {
        case 'close': return closeHub();
        case 'classic': return openClassic();
        case 'classic-edit': {
            const avatar = state.avatar;
            closeHub();
            await ST.selectCharacterById(charIndex(avatar));
            state.bypass = true;
            if (!$('#right-nav-panel').hasClass('openDrawer')) $('#unimportantYes').trigger('click');
            state.bypass = false;
            return;
        }
        case 'back': await flushSaves(); return showLibrary();
        case 'import': closeHub(); return $('#character_import_button').trigger('click');
        case 'create': {
            closeHub();
            state.bypass = true;
            if (!$('#right-nav-panel').hasClass('openDrawer')) $('#unimportantYes').trigger('click');
            state.bypass = false;
            return $('#rm_button_create').trigger('click');
        }
        case 'continue': return openCharacterChat(card?.dataset.avatar ?? state.avatar);
        case 'newchat': return openCharacterChat(card?.dataset.avatar ?? state.avatar, null, true);
        case 'edit': return showProfile(card.dataset.avatar);
        case 'open-group': {
            const id = card?.dataset.group;
            closeHub();
            return Groups.openGroupById(id);
        }
        case 'menu': {
            const m = btn.parentElement.querySelector('.chh-menu');
            m.hidden = !m.hidden;
            return;
        }
        case 'fav': {
            const v = !isFav(c);
            await writeCard(c.avatar, { fav: v, 'data.extensions.fav': v }).catch(err => toastr.error(err.message));
            if (String(charIndex(c.avatar)) === String(ST.this_chid)) $('#fav_checkbox').prop('checked', v);
            btn.classList.toggle('on', v);
            ST.printCharactersDebounced?.();
            return;
        }
        case 'untag': {
            const tag = allTags.find(x => x.id === btn.dataset.tag);
            if (tag) removeTagFromEntity(tag, c.avatar);
            hubEl.querySelector('.chh-ptags').innerHTML = headerTagsHtml(c);
            return;
        }
        case 'alltags':
            state.showAllTags = !state.showAllTags;
            hubEl.querySelector('.chh-ptags').innerHTML = headerTagsHtml(c);
            return;
        case 'allchats':
            state.allChats = !state.allChats;
            hubEl.querySelector('.chh-chats').innerHTML = chatsHtml();
            return;
        case 'book-add': return openBookPicker(btn, btn.dataset.kind);
        case 'book-unbind': return bindBook(btn.dataset.kind, btn.dataset.book, false);
        case 'book': {
            const name = btn.dataset.book;
            closeHub();
            return openWorldInfoEditor?.(name);
        }
        case 'export': {
            try {
                const res = await fetch('/api/characters/export', {
                    method: 'POST', headers: ST.getRequestHeaders(),
                    body: JSON.stringify({ format: 'png', avatar_url: c.avatar }),
                });
                const blob = await res.blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = c.avatar;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            } catch (err) { toastr.error('Export failed.'); }
            return;
        }
        case 'assistant': return Welcome.assignCharacterAsAssistant?.(String(charIndex(c.avatar)));
        case 'delete': {
            const ok = await callGenericPopup(`<h3>Delete ${esc(c.name)}?</h3>This removes the character card <b>and all of its chats</b>. This cannot be undone.`, POPUP_TYPE.CONFIRM);
            if (!ok) return;
            const avatar = c.avatar;
            await ST.deleteCharacter(avatar, { deleteChats: true });
            return showLibrary();
        }
        case 'greet-add': {
            const list = [...(c.data?.alternate_greetings ?? []), ''];
            setPath(c, 'data.alternate_greetings', list);
            renderTab();
            hubEl.querySelector(`textarea[data-greet="${list.length - 1}"]`)?.focus();
            return;
        }
        case 'greet-del': {
            const i = Number(btn.dataset.i);
            const list = [...(c.data?.alternate_greetings ?? [])];
            if (list[i]?.trim() && !(await callGenericPopup('Delete this alternate greeting?', POPUP_TYPE.CONFIRM))) return;
            list.splice(i, 1);
            await writeCard(c.avatar, { 'data.alternate_greetings': list }).catch(err => toastr.error(err.message));
            return renderTab();
        }
        case 'alt-prev':
        case 'alt-next':
            return altNavigate(btn.closest('.chh-alt').dataset.field, act === 'alt-next' ? 1 : -1);
        case 'alt-lock':
            return altLock(btn.closest('.chh-alt').dataset.field);
        case 'zoom': {
            e.preventDefault();
            const src = btn.getAttribute('href');
            return callGenericPopup(`<img src="${esc(src)}" style="max-width:100%;max-height:80vh;border-radius:8px">`, POPUP_TYPE.DISPLAY, '', { wide: true, large: true });
        }
    }
    if (card && !btn) {
        if (card.dataset.avatar) return showProfile(card.dataset.avatar);
        if (card.dataset.group) {
            closeHub();
            return Groups.openGroupById(card.dataset.group);
        }
    }
}

// ----- alternates -----

function altNavigate(key, dir) {
    const c = currentChar();
    const alts = getAlts(c, key);
    const live = readField(c, key);
    let i = state.altView[key] ?? null;

    if (i === null) {
        // first time: keep the live text as version #1 so nothing is lost
        const m = altMatch(alts, live);
        if (m >= 0) i = m;
        else if (live.trim()) {
            alts.push({ title: `${FIELDS[key].label} #${alts.length + 1}`, content: live });
            i = alts.length - 1;
            queueAltSave(c.avatar);
        } else i = 0;
    } else if (i < alts.length && !(alts[i].content ?? '').trim() && altMatch([alts[i]], live) !== 0) {
        // leaving an emptied, unused version removes it
        alts.splice(i, 1);
        queueAltSave(c.avatar);
        if (dir > 0) dir = 0;
    }
    state.altView[key] = Math.max(0, Math.min(alts.length, i + dir));
    rerenderField(key);
}

function altLock(key) {
    const c = currentChar();
    const alts = getAlts(c, key);
    const i = state.altView[key];
    if (i === null || i === undefined || i >= alts.length) return;
    const value = alts[i].content ?? '';
    setPath(c, FIELDS[key].paths[0], value);
    queueFieldSave(c.avatar, key, value);
    rerenderField(key);
    toastr.success(`${FIELDS[key].label}: "${alts[i].title || `#${i + 1}`}" is now in use.`);
}

function rerenderField(key) {
    const c = currentChar();
    const old = hubEl.querySelector(`.chh-field[data-field="${key}"]`);
    if (!old) return;
    const wide = old.classList.contains('wide');
    let extra = '';
    if (key === 'depth_prompt') extra = old.querySelector('.chh-fh-ctl')?.outerHTML ?? '';
    const tmp = document.createElement('div');
    tmp.innerHTML = fieldCardHtml(c, key, { wide, extra });
    const fresh = tmp.firstElementChild;
    old.replaceWith(fresh);
    fresh.querySelectorAll('textarea').forEach(autosize);
    updateTokenBadges();
}

// ----- typing -----

function onHubInput(e) {
    const t = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (e.target);
    if (t.matches('[data-input="query"]')) {
        state.query = t.value;
        return refreshGrid();
    }
    if (t.tagName === 'TEXTAREA') autosize(t);
    const c = currentChar();
    if (!c) return;

    if (t.matches('[data-input="talk"]')) {
        const v = Number(t.value);
        t.nextElementSibling.textContent = v.toFixed(2);
        return queueRawSave(c.avatar, `${c.avatar}::talk`, { talkativeness: v, 'data.extensions.talkativeness': v }, () => {
            if (String(charIndex(c.avatar)) === String(ST.this_chid)) $('#talkativeness_slider').val(v);
        });
    }

    if (t.dataset.greet !== undefined) {
        const i = Number(t.dataset.greet);
        const list = [...(c.data?.alternate_greetings ?? [])];
        list[i] = t.value;
        setPath(c, 'data.alternate_greetings', list);
        queueRawSave(c.avatar, `${c.avatar}::greets`, { 'data.alternate_greetings': list });
        return debounceTokens();
    }

    const key = t.dataset.field;
    if (!key || !FIELDS[key]) return;
    const alts = getAlts(c, key);
    const i = state.altView[key] ?? null;

    if (alts && i !== null) {
        const live = readField(c, key);
        if (i >= alts.length) {
            if (!t.value.trim()) return;
            alts.push({ title: `${FIELDS[key].label} #${alts.length + 1}`, content: t.value });
            queueAltSave(c.avatar);
            rerenderFieldKeepCaret(key, t);
            return;
        }
        const wasActive = altMatch([alts[i]], live) === 0;
        alts[i].content = t.value;
        queueAltSave(c.avatar);
        if (wasActive) {
            setPath(c, FIELDS[key].paths[0], t.value);
            queueFieldSave(c.avatar, key, t.value);
        }
    } else {
        // live value; if it matched an alternate, keep that alternate in sync
        if (alts) {
            const m = altMatch(alts, readField(c, key));
            if (m >= 0) { alts[m].content = t.value; queueAltSave(c.avatar); }
        }
        setPath(c, FIELDS[key].paths[0], t.value);
        queueFieldSave(c.avatar, key, t.value);
    }
    debounceTokens();
}

function rerenderFieldKeepCaret(key, ta) {
    const pos = ta.selectionStart;
    rerenderField(key);
    const fresh = hubEl.querySelector(`textarea[data-field="${key}"]`);
    if (fresh) {
        fresh.focus();
        fresh.setSelectionRange(pos, pos);
    }
}

let tokenTimer;
function debounceTokens() {
    clearTimeout(tokenTimer);
    tokenTimer = setTimeout(updateTokenBadges, 600);
}

function onHubChange(e) {
    const t = /** @type {HTMLInputElement} */ (e.target);
    const c = currentChar();
    if (t.matches('[data-input="sort"]')) {
        settings().hubSort = t.value;
        save();
        return refreshGrid();
    }
    if (!c) return;
    if (t.matches('[data-input="newtag"]') && allTags.some(x => x.name === t.value)) return addTag(t.value);
    if (t.matches('[data-input="dp-depth"], [data-input="dp-role"]')) {
        const depth = Number(hubEl.querySelector('[data-input="dp-depth"]').value) || 0;
        const role = hubEl.querySelector('[data-input="dp-role"]').value;
        return queueRawSave(c.avatar, `${c.avatar}::dp`, { 'data.extensions.depth_prompt.depth': depth, 'data.extensions.depth_prompt.role': role }, () => {
            if (String(charIndex(c.avatar)) === String(ST.this_chid)) {
                $('#depth_prompt_depth').val(depth);
                $('#depth_prompt_role').val(role);
            }
        });
    }
    if (t.matches('input[type="text"][data-field]')) {
        const key = t.dataset.field;
        setPath(c, FIELDS[key].paths[0], t.value);
        return queueFieldSave(c.avatar, key, t.value);
    }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export function initHub() {
    // Intercept the Character Management icon (capture phase, before jQuery/theme handlers)
    registerHub({ isOpen: () => state.open, close: closeHub, reposition: () => state.open && positionHub() });

    document.addEventListener('click', (e) => {
        // any other top-bar button closes the hub and opens right away
        // (with the layout manager on, the preset sidebar may stay open next to the hub)
        const other = /** @type {HTMLElement} */ (e.target)?.closest?.('.drawer-toggle');
        if (state.open && other && other.id !== 'unimportantYes') {
            const id = other.closest('.drawer')?.querySelector('.drawer-content')?.id;
            if (!(layoutActive() && id === 'left-nav-panel')) closeHub();
            return;
        }
        const toggle = /** @type {HTMLElement} */ (e.target)?.closest?.('#unimportantYes');
        if (!toggle || state.bypass || !hubAllowed()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        state.open ? closeHub() : openHub();
    }, true);

    window.addEventListener('resize', () => {
        if (!state.open) return;
        if (!hubAllowed()) closeHub();
        else positionHub();
    });

    // Close when a chat opens from anywhere else
    ST.eventSource?.on?.(ST.event_types.CHAT_CHANGED, () => {
        if (state.open && state.view === 'library') closeHub();
    });
}
