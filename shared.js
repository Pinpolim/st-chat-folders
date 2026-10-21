/* Shared helpers for Chat Folders + Character Hub */
import * as ST from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { power_user } from '../../../power-user.js';
import { timestampToMoment } from '../../../utils.js';

export const MODULE = 'chatFolders';
export const LOG = '[Chat Folders]';

export const DEFAULTS = Object.freeze({
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
    chatHeader: true,       // chat header bar (replaces the Chat Top Bar extension)
    layoutManager: true,    // one page at a time; preset panel is the right sidebar (desktop)
    hubEnabled: true,       // character icon opens the Character Hub (desktop only)
    hubSort: 'recent',      // 'recent' | 'name' | 'added' | 'size'
    hubTagLimit: 3,         // tags shown on a library card before "+N"
    hubCardSize: 160,       // px, min card width in the library grid
    hubHdImages: true,      // full-resolution card art in the library (thumbnails are blurry)
    expanded: [],           // folder keys that are open
    pinned: [],             // folder keys pinned to top
});

/** @returns {typeof DEFAULTS} */
export function settings() {
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

export const save = () => ST.saveSettingsDebounced();

// ---------- helpers ----------

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));

export function thumb(type, file) {
    return typeof ST.getThumbnailUrl === 'function'
        ? ST.getThumbnailUrl(type, file)
        : `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`;
}

export function toMoment(ts) {
    try {
        return timestampToMoment(ts);
    } catch {
        return null;
    }
}

export function momentValue(ts) {
    const m = toMoment(ts);
    return m && m.isValid() ? m.valueOf() : 0;
}


/**
 * Works out which persona belongs to a chat.
 * Priority: persona locked to the chat > persona connected to the character/group > default persona.
 */
export function resolvePersona(chat, folder) {
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

