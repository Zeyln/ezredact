# EzRedact

Redact screenshots and images on your phone, privately.

Open an image, cover what you need to hide, then share or save the result. EzRedact runs entirely in your browser: there is no server, no account, no analytics, and nothing is ever written to storage.

**Use it:** https://zeyln.github.io/ezredact/

## Privacy by design

- **No backend.** The app is static HTML, CSS and JavaScript served by GitHub Pages. A Content Security Policy blocks every network request except loading the app's own files, so an image cannot be uploaded even by accident.
- **Memory only.** The image and your edits live in in-memory canvases. EzRedact does not use cookies, `localStorage`, IndexedDB, the Cache API or a service worker.
- **Wiped on exit.** Leaving, reloading or closing the page wipes the image, the edit history and any temporary download links. The **Wipe** button does the same at any time.
- **Clean exports.** Exports are re-encoded PNGs. Redacted pixels are permanently replaced, and metadata such as EXIF location and camera details is not carried over.
- **No third-party code.** There are no dependencies, frameworks or CDNs. Everything that runs is in [`site/`](site/).

## Tools

| Tool | Use |
| --- | --- |
| **Box** | Drag to cover an area with solid black or white. This is the safest way to hide text. |
| **Pixelate** | Drag to pixelate an area. Fine for faces and photos. Pixelated *text* can sometimes be reconstructed, so use Box for text. |
| **Brush** | Paint freehand with a solid color. |
| **Move** | Drag to pan. |

Pinch with two fingers to zoom and pan with any tool. Undo and redo cover every edit.

On a computer you can also paste (Ctrl/⌘+V) or drag an image onto the page, zoom with the scroll wheel, and use the shortcuts `B` (Box), `P` (Pixelate), `D` (Brush), `M` (Move), `0` (fit), Ctrl/⌘+Z (undo) and Ctrl/⌘+Shift+Z or Ctrl+Y (redo).

### Add to home screen

- **iPhone/iPad (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** ⋮ menu → Add to Home screen.

It then opens full-screen like an app. Closing it wipes everything, just as in the browser.

## Development

There is no build step. Serve the `site/` folder with any static file server, for example:

```sh
npx serve site
```

Pushing to `main` deploys `site/` to GitHub Pages through [`.github/workflows/pages.yml`](.github/workflows/pages.yml). In the repository settings, under **Pages → Build and deployment**, set **Source** to **GitHub Actions**.
