# Python + fontTools core; every frontend is an HTTP consumer of it

The single capability layer is a pure Python library (a fontTools pipeline: subset → normalize → graft glyphs → rebuild tables), with no UI. The CLI calls the core directly. The desktop GUI is Tauri 2 with the core bundled as a binary sidecar — native windows on Windows, macOS, and Linux. The WebApp is a pure static site (github.io / vercel) that drives real merges through `fontalloy serve`, a localhost HTTP service (bound to 127.0.0.1 only, CORS limited to the WebApp origin), and degrades to a "copy CLI command" button when no local service answers. Rationale: browsers cannot do glyph-table-level merging (preview only), and this layering gives the GUI and WebApp one shared core API and one shared frontend, with the merge logic existing exactly once.

## Considered options

- FontForge Python module (the old storefront pipeline): heavy install burden — even Nerd Fonts byte-patches its output. Rejected.
- Rust core (write-fonts / fontc): the merge-capability gap is too large to bridge. Rejected.
- PySide6 GUI: pure Python with no sidecar, but a weak canvas ecosystem for large glyph grids and heavy three-platform packaging. Rejected.
