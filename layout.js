/*
 * Layout manager (desktop)
 * - One page at a time: opening any top-bar page closes the others (and the Character Hub).
 * - The preset panel (AI Response Configuration) is the only sidebar, on the right.
 *   It can sit next to: the chat / welcome page, Persona Management, Lorebooks and the Character Hub
 *   (which hides its own right column while the preset is open).
 *   Opening it over any other page closes that page; opening another page closes the preset.
 */
import { settings } from './shared.js';

const SIDEBAR = 'left-nav-panel';
const SQUISHABLE = new Set(['PersonaManagement', 'WorldInfo']);
const PAGES = ['rm_api_block', 'AdvancedFormatting', 'WorldInfo', 'user-settings-block', 'Backgrounds', 'rm_extensions_block', 'PersonaManagement'];

/** hooks provided by the hub */
let hub = { isOpen: () => false, close: () => {}, reposition: () => {} };
export function registerHub(api) {
    hub = api;
}

export function layoutActive() {
    return settings().enabled !== false && settings().layoutManager && window.matchMedia('(min-width: 1000px)').matches;
}

const isOpen = (id) => document.getElementById(id)?.classList.contains('openDrawer') ?? false;

export function closeDrawer(id) {
    const el = document.getElementById(id);
    if (!el || !isOpen(id)) return;
    $(el).hide().removeClass('openDrawer').addClass('closedDrawer');
    const icon = el.closest('.drawer')?.querySelector('.drawer-icon');
    if (icon) {
        icon.classList.remove('openIcon');
        icon.classList.add('closedIcon');
    }
}

/** Called by the hub right before it opens. */
export function beforeHubOpens() {
    if (!layoutActive()) return;
    PAGES.forEach(closeDrawer);
}

export function sidebarOpen() {
    return layoutActive() && isOpen(SIDEBAR);
}

export function sidebarWidth() {
    const el = document.getElementById(SIDEBAR);
    return el && isOpen(SIDEBAR) ? Math.round(el.getBoundingClientRect().width) : 0;
}

function railWidth() {
    const rail = document.getElementById('top-settings-holder');
    const r = rail?.getBoundingClientRect();
    return r && r.height > r.width * 2 ? Math.round(r.right) : 0;
}

/**
 * The preset panel must not auto-close when clicking elsewhere (SillyTavern closes unpinned
 * drawers on outside clicks), so while the layout manager is on it is treated as pinned.
 */
function pinSidebar(on) {
    const el = document.getElementById(SIDEBAR);
    const icon = document.getElementById('leftNavDrawerIcon');
    if (!el) return;
    if (on && !el.classList.contains('pinnedOpen')) {
        el.classList.add('pinnedOpen');
        icon?.classList.add('drawerPinnedOpen');
        el.dataset.chfPinned = '1';
    } else if (!on && el.dataset.chfPinned) {
        delete el.dataset.chfPinned;
        const userPinned = SillyTavern.getContext().accountStorage?.getItem('LNavLockOn') === 'true';
        if (!userPinned) {
            el.classList.remove('pinnedOpen');
            icon?.classList.remove('drawerPinnedOpen');
        }
    }
}

export function syncLayout() {
    const on = layoutActive();
    pinSidebar(on);
    document.body.classList.toggle('chf-layout', on);
    document.body.classList.toggle('chf-sidebar-open', on && isOpen(SIDEBAR));
    document.body.style.setProperty('--chf-sidebar-w', `${sidebarWidth()}px`);
    document.body.style.setProperty('--chf-rail-w', `${railWidth()}px`);
    hub.reposition();
}

function onToggleClick(e) {
    if (!layoutActive()) return;
    const toggle = /** @type {HTMLElement} */ (e.target)?.closest?.('.drawer-toggle');
    if (!toggle) return;
    const id = toggle.closest('.drawer')?.querySelector('.drawer-content')?.id;
    if (!id || id === 'right-nav-panel') return; // the character icon is handled by the hub
    if (isOpen(id)) {
        setTimeout(syncLayout, 60); // closing: let the default handler do it
        return;
    }

    if (id === SIDEBAR) {
        // preset opens next to compatible pages only
        PAGES.filter(p => !SQUISHABLE.has(p)).forEach(closeDrawer);
    } else {
        if (hub.isOpen()) hub.close();
        PAGES.filter(p => p !== id).forEach(closeDrawer);
        if (!SQUISHABLE.has(id)) closeDrawer(SIDEBAR);
    }
    setTimeout(syncLayout, 60);
}

export function initLayout() {
    document.addEventListener('click', onToggleClick, true);
    const observer = new MutationObserver(() => syncLayout());
    const side = document.getElementById(SIDEBAR);
    if (side) observer.observe(side, { attributes: true, attributeFilter: ['class', 'style'] });
    window.addEventListener('resize', syncLayout);
    syncLayout();
}
