# 图片压缩（tupian-yasuo）v1.5

基于 [Squoosh] 的本地图片压缩 Web 应用，支持单图对比和批量压缩，图片全程在浏览器内处理。

版本变化见 [CHANGELOG.md](CHANGELOG.md)。

# Privacy

Squoosh does not send your image to a server. All image compression processes locally.

This variant does not load upstream Google Analytics.

# Developing

To develop for Squoosh:

1. Clone the repository
1. To install node packages, run:
   ```sh
   npm ci --ignore-scripts
   ```
1. Then build the app by running:
   ```sh
   npm run build
   ```
1. After building, start the development server by running:
   ```sh
   npm run dev
   ```

# Contributing

Squoosh is an open-source project that appreciates all community involvement. To contribute to the project, follow the [contribute guide](/CONTRIBUTING.md).

[squoosh]: https://squoosh.app

## Local Development

`npm run dev` works on Windows, macOS, and Linux. It uses port 5000 or the next
available port. Set `DEV_PORT` to choose a starting port. Production files are
written to `build/`; configure your server with the headers in `serve.json`.
Set `SITE_ORIGIN` when building for a specific domain to emit its canonical URL.

## Batch Processing

JPEG, WebP, and PNG use the same codecs as the single-image editor. JPEG outputs
flatten transparency onto white. Batch tasks run on 1–4 parallel workers (half the
CPU cores, at most 2 on devices with ≤ 4 GB memory) and can be cancelled. Size
limits apply to the long edge or the width and use the editor's Lanczos3 resampler.
"Keep original if larger", per-item retry, "compress unfinished" and saved batch
settings are available. TIFF is only decodable in Safari.
ZIP downloads use a preparation step followed by a normal download link, which
avoids browser multiple-download restrictions. ZIP32 archives must remain below
4 GB and contain at most 65535 files. Run `npm test` for focused regressions and `npm run test:e2e` for the
Playwright suites. `npm run serve` serves the production `build/` directory.

`tests/layout.cjs` checks the source CSS with layout fixtures; it is not an
application end-to-end test. `tests/browser.cjs` checks the built application at
`BASE_URL`, including real compression and ZIP downloads. Both scripts use an
existing Playwright installation via `PLAYWRIGHT_MODULE`; set `TEST_OUTPUT` for
screenshots and downloads, and optionally `BROWSER_EXECUTABLE`.

`tests/edge-browser.cjs` covers SVG/QOI/WebP/AVIF decoding, resizing, JPEG
transparency, invalid saved settings, reduced motion, and offline reload.
See `OPTIMIZATION-AUDIT.md` for verification and unresolved dependency risks.
This package has not passed dependency security audit and has not been deployed.
Deploy with the headers in `serve.json` (or `src/copy/_headers` on Netlify);
without COOP/COEP the multithreaded codecs fall back to single-threaded mode.
