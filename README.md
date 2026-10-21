# Chat Folders & Character Hub

A SillyTavern UI extension.

## Welcome screen

- Recent chats grouped into collapsible folders per character / group, with no display limit
- Persona avatar under each chat title (locked persona, or a dimmed guess)
- Folder buttons: new chat, pin to top; chat buttons: rename, delete
- Filter box, list / grid layout
- Cleaner header: centered adaptive 3D logo (colour sampled from your background), Assistant button, version moved to a faded footer
- Hides the welcome input bar, shortcut buttons and assistant greeting (each optional)

## Character Hub (desktop)

The Character Management icon opens a full-page hub instead of the side drawer:

- Library: sidebar with All / Recently chatted / Favorites / Groups / every tag; large card grid; search by name, tag or creator; sort; hover to Continue, start a New chat or Edit
- Profile: every card field visible in tabs (Definition, Greetings, Examples, Prompt overrides, Gallery, Lore & notes), token counts, tag editing, favorite, export, delete
- Alternate versions of Description, Personality, Scenario, Examples, Main prompt and Post-history instructions: arrows to browse, lock to use. Shares storage with the Alternate Fields extension (`data.extensions.alternate_fields`)
- Right column: this character's chats with personas, token budget, character / additional / chat lorebooks, connected personas
- Edits save through SillyTavern's own `/api/characters/merge-attributes` endpoint; the classic panel stays one click away

## Chat header

Shown above the chat only while a chat is open (replaces the Chat Top Bar extension, which is hidden while this is on):

- Chat switcher with persona / message count / last used
- Persona chip: switch persona, lock it to the chat
- Connection profile chip: profile name + grey API – model status; switch profiles
- Search in chat (Enter / Shift+Enter to step through matches), new chat, branch, rename, delete, close
- Phones / horizontal top bar: the header takes the top bar's place; a swap button flips to SillyTavern's top bar and back. Opening a chat always starts on the header

## Phone input bar

On touch phones the chat input bar gets space below and at the sides so rounded screen corners (e.g. iPhone 17 Pro) don't cut off its buttons. Uses padding, so the chat shrinks instead of being overlapped. Both amounts are adjustable.

## Settings button

User Settings, Backgrounds and AI Response Formatting are merged into one **Settings** button with tabs (opens on User Settings):

- User Settings split into sections: Appearance, Characters, Chat & messages, Miscellaneous, Custom CSS (or All). The settings search box always searches everything
- AI Response Formatting can hide every option that has no effect with Chat Completion (on by default)

## Layout manager (desktop)

- One page at a time: opening a top-bar page closes the others (and the Character Hub)
- The preset panel is the only sidebar, on the right. It sits next to the chat / welcome page, Persona Management, Lorebooks and the Character Hub (where it replaces the hub's right column). Opening it over any other page closes that page, and opening another page closes it

Settings: **Extensions → Chat Folders**.

## Install

Extensions → Install extension → paste this repository's URL.
To update, press the update button next to the extension in the Extensions panel.
