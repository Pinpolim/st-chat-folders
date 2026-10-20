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

Settings: **Extensions → Chat Folders**.

## Install

Extensions → Install extension → paste this repository's URL.
To update, press the update button next to the extension in the Extensions panel.
