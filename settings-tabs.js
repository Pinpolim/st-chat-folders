/*
 * Merged Settings button
 * User Settings, Backgrounds and AI Response Formatting become tabs of one "Settings" page.
 * The Backgrounds and Formatting icons are hidden; the User Settings icon opens the page
 * (always on the User Settings tab). Nothing is moved out of SillyTavern's panels: the tab bar
 * is placed at the top of whichever of the three panels is open, and switching tabs opens the
 * matching panel the normal way.
 *
 * Extras:
 * - User Settings is split into sections (one at a time instead of three crowded columns).
 * - AI Response Formatting can hide everything that has no effect with Chat Completion
 *   (SillyTavern marks those options with [data-cc-null]).
 */
import { settings, save } from './shared.js';

const TABS = [
    { id: 'user', label: 'User Settings', short: 'Settings', icon: 'fa-user-gear', btn: 'user-settings-button', panel: 'user-settings-block' },
    { id: 'bg', label: 'Backgrounds', short: 'Backgrounds', icon: 'fa-panorama', btn: 'backgrounds-button', panel: 'Backgrounds' },
    { id: 'fmt', label: 'AI Response Formatting', short: 'Formatting', icon: 'fa-font', btn: 'advanced-formatting-button', panel: 'AdvancedFormatting' },
];

const SECTIONS = [
    { id: 'all', label: 'All' },
    { id: 'appearance', label: 'Appearance', icon: 'fa-palette' },
    { id: 'characters', label: 'Characters', icon: 'fa-address-card' },
    { id: 'chat', label: 'Chat & messages', icon: 'fa-comments' },
    { id: 'misc', label: 'Miscellaneous', icon: 'fa-sliders' },
    { id: 'css', label: 'Custom CSS', icon: 'fa-code' },
];

const on = () => settings().enabled !== false && settings().mergeSettings;
const isOpen = (id) => document.getElementById(id)?.classList.contains('openDrawer') ?? false;
let bar = null;
let switching = false;

function openTab(id) {
    const tab = TABS.find(t => t.id === id);
    if (!tab || isOpen(tab.panel)) return;
    switching = true;
    // close the other two the normal way, then open the target
    for (const t of TABS) {
        if (t.id !== id && isOpen(t.panel)) document.querySelector(`#${t.btn} .drawer-toggle`)?.click();
    }
    document.querySelector(`#${tab.btn} .drawer-toggle`)?.click();
    switching = false;
    setTimeout(sync, 30);
}

function buildBar() {
    bar = document.createElement('div');
    bar.id = 'chf-stabs';
    bar.addEventListener('click', (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        const tabBtn = t.closest('[data-tab]');
        if (tabBtn) return openTab(tabBtn.getAttribute('data-tab'));
        const sec = t.closest('[data-sec]');
        if (sec) {
            settings().settingsSection = sec.getAttribute('data-sec');
            save();
            return sync();
        }
        if (t.closest('[data-act="cc-hide"]')) {
            settings().hideCcUnused = !settings().hideCcUnused;
            save();
            return sync();
        }
    });
    return bar;
}

function renderBar(active) {
    const s = settings();
    const sec = s.settingsSection || 'appearance';
    bar.innerHTML = `
        <div class="chf-stabs-row">
            ${TABS.map(t => `<button data-tab="${t.id}" class="${t.id === active ? 'on' : ''}"><i class="fa-solid ${t.icon} fa-fw"></i><span class="chf-t-long">${t.label}</span><span class="chf-t-short">${t.short}</span></button>`).join('')}
        </div>
        ${active === 'user' ? `<div class="chf-ssec-row">${SECTIONS.map(x => `<button data-sec="${x.id}" class="${x.id === sec ? 'on' : ''}">${x.icon ? `<i class="fa-solid ${x.icon} fa-fw"></i>` : ''}${x.label}</button>`).join('')}</div>` : ''}
        ${active === 'fmt' ? `<div class="chf-ssec-row"><button data-act="cc-hide" class="${s.hideCcUnused ? 'on' : ''}" title="SillyTavern greys these out when a Chat Completion API is selected; this hides them instead."><i class="fa-solid ${s.hideCcUnused ? 'fa-eye-slash' : 'fa-eye'} fa-fw"></i>${s.hideCcUnused ? 'Showing only options used by Chat Completion' : 'Hide options unused by Chat Completion'}</button></div>` : ''}`;
}

export function sync() {
    const enabled = on();
    document.body.classList.toggle('chf-merge', enabled);
    document.body.classList.toggle('chf-cc-hide', enabled && settings().hideCcUnused);
    const sec = settings().settingsSection || 'appearance';
    for (const x of SECTIONS) document.body.classList.toggle(`chf-sec-${x.id}`, enabled && sec === x.id);

    const active = TABS.find(t => isOpen(t.panel));
    const icon = document.querySelector('#user-settings-button .drawer-icon');
    if (icon) {
        icon.title = enabled ? 'Settings' : 'User Settings';
        // keep the merged icon lit while Backgrounds / Formatting is the open tab
        if (enabled && active && active.id !== 'user') {
            icon.classList.add('openIcon');
            icon.classList.remove('closedIcon');
        } else if (enabled && !active) {
            icon.classList.remove('openIcon');
            icon.classList.add('closedIcon');
        }
    }
    if (!enabled || !active) {
        bar?.remove();
        return;
    }
    if (!bar) buildBar();
    renderBar(active.id);
    const panel = document.getElementById(active.panel);
    if (bar.parentElement !== panel) panel.prepend(bar);
}

export function initSettingsTabs() {
    // The merged icon: if Backgrounds / Formatting is the open tab, clicking it closes the page
    document.addEventListener('click', (e) => {
        if (!on() || switching) return;
        const toggle = /** @type {HTMLElement} */ (e.target)?.closest?.('#user-settings-button .drawer-toggle');
        if (!toggle) return;
        const other = TABS.find(t => t.id !== 'user' && isOpen(t.panel));
        if (other) {
            e.preventDefault();
            e.stopImmediatePropagation();
            switching = true;
            document.querySelector(`#${other.btn} .drawer-toggle`)?.click();
            switching = false;
            setTimeout(sync, 30);
        }
    }, true);

    const obs = new MutationObserver(() => { if (!switching) sync(); });
    for (const t of TABS) {
        const el = document.getElementById(t.panel);
        if (el) obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
    sync();
}
