# ScratchWWW navigation reuse (2026-11-20)

## Changes

- Added `dev-server/scratch-navbar.js`, a shared server-rendered navigation partial for the local profile, My Stuff, and account-settings pages.
- The partial mirrors the DOM structure and class names from `src/components/navigation/www/navigation.jsx` and `src/components/navigation/www/accountnav.jsx` (`#navigation`, `.inner`, `.logo`, `.create`, `.explore`, `.ideas`, `.search`, `.messages`, `.mystuff`, `.account-nav`, `.user-info`, `.dropdown`).
- Loads the generated `/common.css` and the existing normalize stylesheet, so the actual ScratchWWW navigation SCSS (`navigation/base`, `navigation/www`, `accountnav`, and `dropdown`) styles the pages. Removed the hand-written duplicate navigation CSS from `scratch-pages.js`.
- Added accessible account dropdown behavior (toggle, outside click, Escape) and reused the existing local logout endpoint.

## Validation

- `node --check dev-server/scratch-pages.js`: passed.
- `node --check dev-server/scratch-navbar.js`: passed.
- Static assertions: shared partial is used, old duplicate navigation CSS is absent, `/common.css` is linked.
- ZIP integrity check: passed.
- Full Webpack build/browser visual check: not run because dependencies are not installed in this workspace.
