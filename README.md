# Whiteboard

An open-source, **offline-first desktop whiteboard** for Windows & macOS —
Miro-like design and interaction, plus a feature Miro never shipped:

https://github.com/antsin3d/ZoomBoard/blob/master/release/Whiteboard-0.1.0-portable.exe

### Zoom Breakpoints

Control how content appears at different zoom levels — *responsive design on the
zoom axis*. Explore a data hierarchy by zooming through levels of abstraction
(e.g. Themes → Insights → Samples).

![Zoom breakpoints example](Zoomboard_Cap01.png)

## Status

🚧 Working prototype. Zoom breakpoints/tiers, per-tier element properties,
LOD variants, transitions, grouping, resizing, undo/redo, sticky notes, frames,
connectors, embedded images, and single-file board persistence are implemented.
See [`PLAN.md`](./PLAN.md) for the remaining roadmap.

## Stack

- **Tauri 2** desktop shell (Rust core + system webview)
- **TypeScript + React** UI
- **Konva** (`react-konva`) infinite-canvas engine
- **Yjs** live session document and offline `.board` encoding

All dependencies are permissive (MIT / Apache-2.0).

## Develop

```bash
pnpm install
pnpm dev          # run the canvas in a browser (proves the Zoom Breakpoints feature)
```

**Desktop build** (Tauri) additionally requires the Rust toolchain:

```bash
# Install Rust (https://rustup.rs) + the MSVC C++ build tools on Windows
pnpm tauri dev    # run the native desktop window
```

## Board files

Use **Open** (`Ctrl/Cmd+O`) and **Save** (`Ctrl/Cmd+S`) in the toolbar. Desktop
builds use native file dialogs and save a versioned Yjs-backed `.board` file.
Browser development uses file upload/download as a fallback.

## License

MIT (intended).
