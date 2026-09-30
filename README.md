# Whiteboard

An open-source, **offline-first desktop whiteboard** for Windows & macOS —
Miro-like design and interaction, plus a feature Miro never shipped:

https://github.com/antsin3d/ZoomBoard/blob/master/release/Whiteboard.exe

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

## Remote collaboration (preview)

Use **Share / Join** to host a board or paste an invite link/code. Sessions
include shared cursors, follow, local favorites with reachability checks, and
host-controlled editing and Save/Copy permissions. Save after first sharing
to preserve the reusable invite in your board file.

No servers to operate: public PeerJS signaling and STUN help establish direct
WebRTC connections. There is no TURN fallback, so some networks cannot connect.
Guests receive board data even when Save/Copy is disabled; this is not copy
protection. See [collaboration details and limits](docs/collaboration.md).

Run `pnpm test` for automated protocol/lifecycle tests and `pnpm build` for the
TypeScript and production frontend build.

## License

MIT (intended).
