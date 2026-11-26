# pi-btw

A "by the way" side pane for [Pi](https://pi.dev): ask side questions about the main conversation without touching it.

`/btw` opens a pane to the right of the main thread. The pane runs an in-memory agent seeded with a frozen snapshot of the main branch. Nothing is written to the session; closing the pane discards it. When something is worth keeping, `/submit` summarizes the side conversation and sends it to the main thread as a follow-up.

Requires Pi 1.6.x in fullscreen mode (`tuiMode: "fullscreen"`).

## Install

```sh
pi install /path/to/pi-btw
```

## Usage

| Command / key | Action |
|---|---|
| `/btw [question]` | Open the pane (optionally asking right away), or focus it if open |
| `/submit` (in btw) or `/btw:submit` | Summarize and send to the main thread as a follow-up, then close |
| `/close` (in btw) or `/btw:close` | Close and discard |
| `/model` (in btw) | Switch the model btw uses (btw only) |
| `alt+o` | Move focus between the main thread and btw |
| `alt+-` / `alt+=` | Make the pane narrower / wider; or drag the divider (double-click resets) |
| `Esc` | Stop the current answer, or return focus to the main thread |

The usual transcript keys (PageUp/PageDown, …) scroll the btw transcript while its editor has focus.

## Behavior

- **Snapshot:** taken once when btw opens. Later main-thread progress is not followed; reopen btw for a fresh one. If the main thread is mid tool call, the unfinished turn is left out.
- **Tools:** read-only: `read`, `grep`, `find`, `ls`, plus `webfetch` when the main session has [pi-webfetch](https://github.com/jwu/pi-webfetch) loaded. No other extensions are loaded into btw.
- **Model:** starts with the main thread's model and thinking level; `/model` changes btw only and never your defaults.
- **Look:** messages, tools, and the editor use Pi's own components; the input box follows pi-powerline's style. The pane turns grey (in the theme's muted color) while focus is elsewhere.

## Caveats

btw reaches into a few Pi 1.6.x internals (the alt-screen layout root, stack entries, the model runtime, the renderer's frame hook). Each is checked before use, but a Pi upgrade may need a follow-up release.

## Development

```sh
npm test           # unit tests
npm run typecheck  # needs Pi's packages linked into node_modules/@earendil-works
python3 test/drive.py script.json   # drive pi in a pseudo terminal (needs pyte)
```

## License

MIT
