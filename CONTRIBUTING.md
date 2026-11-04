# Contributing to BraXhn TV

*Svenska: bidrag är välkomna. Koden, kommentarerna och commit-meddelandena skrivs på svenska; ärenden och pull requests får vara på engelska.*

Thanks for wanting to help. BraXhn TV is a hobby project I maintain on my own, so bug reports with a diagnostics bundle, translations, testing on hardware I don't have (GPUs, TV browsers, cars) and pull requests all make a real difference.

## Ground rules

- **No npm dependencies.** The server uses only Node's built-in modules (Node 22+, the image runs Node 24 LTS – `node:sqlite`, `http`, `crypto`, `zlib` …) plus ffmpeg. Solve it with the standard library. The web app is plain ES modules without a framework or build step.
- **Third-party files** for the web live in `web/vendor/` with SHA-256 in `web/vendor/checksums.json` and are described in `web/vendor/VENDOR.md`. Nothing is loaded from a CDN.
- **Swedish in the code.** Comments, identifiers where they are words, log messages and commit messages are written in Swedish, like the rest of the code. Don't worry if you don't speak Swedish – write in English and I'll translate when merging.
- **Web UI text** goes through `t('Svensk text')` from `web/js/core.js`, with the English translation as a new line in `web/i18n/en.js`. The Swedish text is the key. Server error messages shown in the web app need a line there too.
- **Never delete users' media.** Scanners must not remove anything when a library folder is missing, empty, or when more than half would disappear.
- Before larger changes, read the developer guide [docs/utvecklarguide.md](docs/utvecklarguide.md) (conventions and architecture), [docs/arkitektur.md](docs/arkitektur.md) (the code's map: anchors, bridges, invariants and lessons learned) and [docs/ui-komponenter.md](docs/ui-komponenter.md) for the shared UI components. They are in Swedish.

## Tests

```bash
npm run verify && npm test
```

Everything must be green before a pull request is merged. The tests need `ffmpeg`/`ffprobe` (they run real media files) and, for the browser tests, Playwright with Chromium – those tests are skipped if it's missing. The full suite takes about 30 minutes; run a single file while you work:

```bash
node --test test/diagnostics.test.js
```

The tests must also pass as a non-root user: set `CONFIG_DIR` to a temporary folder before importing server modules, and get ports from `test/helpers/port.js` (see `test/hygiene.test.js`).

The apps (`apps/apple`, `apps/automotive`) are not part of the test suite – they are compiled by GitHub Actions on push; check the workflow run.

## Pull requests

- One change per pull request, with a short description of *why*.
- Add or update tests for what you change.
- New features: update `README.md` and `README.en.md` (feature overview, environment variables – a test checks that both list the same variables), [docs/funktioner.md](docs/funktioner.md) and `CHANGELOG.md` under *Ej utgiven*.
- By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
