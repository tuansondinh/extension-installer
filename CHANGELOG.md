# Changelog

## [1.1.1] - 2026-04-23

### Other
- Improve npm keywords for better discoverability

## [1.1.0] - 2026-04-22

### Features

- Allow installing package directly from preview by pressing `Enter`

## [1.0.1] - 2026-04-22

### Bug Fixes

- Readme preview now scrollable with ↑/↓ arrow keys (previously truncated at 800 chars with no scroll)
- Scroll position indicator shows current line range (e.g. `lines 1–20 of 84`)
- Any non-arrow key closes the preview
- Full readme loaded instead of 800-char truncation

## [1.0.0] - 2026-04-22

### Features

- Browse Pi community packages from the npm registry via `/extensions` command
- Arrow-key navigation (↑↓ move cursor, ←→/n·p page through results)
- Space to multi-select packages for batch install
- Enter to preview readme and links for any package
- Live search with `/` — filters registry results
- Install selected packages (`i`) via npm + auto-register in pi settings.json
- Manage installed packages (`u`) — shows all registered packages with arrow navigation
- Uninstall packages from manage view (Space to select, Enter to uninstall)
- Detects already-installed packages and skips redundant npm install (avoids ENOTEMPTY on macOS)
- Scoped package names (`@scope/pkg`) handled correctly throughout
- `/reload` hint shown after install and uninstall
- Download counts (last month) shown per package
- Installed markers (✓) in browse view
