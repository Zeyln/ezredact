# EzRedact

Redact screenshots and images on your phone, privately.

Open an image, cover what you need to hide, then share or save the result. EzRedact runs entirely in your browser: there is no server, no account and no analytics. EzRedact itself writes nothing to your device until you choose to save or share the edited image. Your phone or browser may still keep some traces; see [Limits](#limits).

**Use it:** https://zeyln.github.io/ezredact/

> **Alpha test build (v0.1.0-alpha.1).** Not yet verified on real devices. Check every exported image before you share it, and report problems in [Issues](https://github.com/Zeyln/ezredact/issues).

## Privacy by design

- **No backend.** The app is static HTML, CSS and JavaScript served by GitHub Pages. A Content Security Policy blocks every network request except loading the app's own files, so an image cannot be uploaded even by accident.
- **Memory only.** The image and your edits live in in-memory canvases. EzRedact does not use cookies, `localStorage`, IndexedDB, the Cache API or a service worker.
- **You decide what gets saved.** The only thing EzRedact ever writes to your device is the redacted image, and only when you tap **Save**, **Share** or **Copy**. The original image and your edit history are never saved.
- **Wiped on exit.** Leaving, reloading or closing the page wipes the image, the edit history and any temporary download links. The **Wipe** button does the same at any time.
- **Clean exports.** Exports are re-encoded PNGs. Redacted pixels are permanently replaced, and metadata such as EXIF location and camera details is not carried over.
- **Privacy shield.** The screen is covered whenever the page loses focus or goes to the background, so app-switcher previews and tab thumbnails are less likely to show your image.
- **No third-party code.** There are no dependencies, frameworks or CDNs. Everything that runs is in [`site/`](site/).

## Limits

EzRedact controls what the web page does, not what your phone or browser does around it. Outside the app's control:

- **App switcher previews and tab thumbnails.** iOS and Android save a screenshot of the screen for the app switcher, and Safari and Chrome keep thumbnails of open tabs. Native apps such as Snapchat or Teams with Intune hide content first (on iOS by covering the window when the app becomes inactive, on Android with `FLAG_SECURE`). Web pages can't use either, so EzRedact covers the screen on the earliest events browsers provide. That works reliably on Android, where the page is told as soon as the recents screen opens. On iOS the page may only be told after the snapshot has been taken.
- **Photo picker copies.** On iOS, picking a photo can make the system create a temporary copy for the browser. The system manages and clears it.
- **Clipboard.** **Copy** leaves the redacted image on the clipboard, where clipboard-history keyboards or Universal Clipboard may keep or sync it.
- **Swap.** Some Android phones (for example Samsung "RAM Plus") can move memory to storage when RAM runs low.
- **Browser caching of the app itself.** Browsers cache EzRedact's own files (HTML, script, icons). Your images are never fetched from the network, so they never enter that cache.

When you're done, close EzRedact from the app switcher.

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
