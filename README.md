# Image

A private tool for redacting screenshots and images on your phone.

Open an image, cover what you need to hide, then share or save the result. It runs entirely in your browser: there is no server, no account and no analytics. The app itself writes nothing to your device until you choose to save or share the edited image. Your phone or browser may still keep some traces; see [Limits](#limits).

**Use it:** https://zeyln.github.io/img/

> **Alpha test build.** Not yet verified on real devices. Check every exported image before you share it, and report problems in [Issues](https://github.com/Zeyln/img/issues).

## Discreet by design

The interface is deliberately plain so it does not draw attention from people nearby: a generic name ("Image") and icon, the system light/dark look, no headlines or explanatory text, and a blank screen when the app is in the background.

## Privacy by design

- **No backend.** The app is static HTML, CSS and JavaScript served by GitHub Pages. A Content Security Policy blocks every network request except loading the app's own files, so an image cannot be uploaded even by accident.
- **Memory only.** The image and your edits live in in-memory canvases. The app does not use cookies, `localStorage`, IndexedDB, the Cache API or a service worker.
- **You decide what gets saved.** The only thing the app ever writes to your device is the redacted image, and only when you use **Save**. The original image and your edit history are never saved.
- **Cleared when you leave.** As soon as the page goes to the background (switching app or tab, going to the home screen, locking the screen) or is closed or reloaded, the image, the edit history and any temporary download links are cleared. Save first if you want to keep the result. The **Close** button does the same at any time.
- **Clean exports.** Exports are re-encoded PNGs. Redacted pixels are permanently replaced, and metadata such as EXIF location and camera details is not carried over.
- **Privacy shield.** The screen is covered whenever the page loses focus or goes to the background, so app-switcher previews and tab thumbnails are less likely to show your image.
- **No third-party code.** There are no dependencies, frameworks or CDNs. Everything that runs is in [`site/`](site/).

## Limits

The app controls what the web page does, not what your phone or browser does around it. Outside the app's control:

- **App switcher previews and tab thumbnails.** iOS and Android save a screenshot of the screen for the app switcher, and Safari and Chrome keep thumbnails of open tabs. Native apps such as Snapchat or Teams with Intune hide content first (on iOS by covering the window when the app becomes inactive, on Android with `FLAG_SECURE`). Web pages can't use either, so the app covers the screen on the earliest events browsers provide. That works reliably on Android, where the page is told as soon as the recents screen opens. On iOS the page may only be told after the snapshot has been taken.
- **Photo picker copies.** On iOS, picking a photo can make the system create a temporary copy for the browser. The system manages and clears it.
- **Download history.** If you use **Download**, the browser lists it in its download history until you clear it. The Save As dialog may also remember the last folder you saved to.
- **Where you save it.** Saving to Photos or to a cloud-synced folder (iCloud, Google Photos, OneDrive) uploads the redacted image to that service.
- **Clipboard.** **Copy** leaves the redacted image on the clipboard, where clipboard-history keyboards or Universal Clipboard may keep or sync it.
- **Swap.** Some Android phones (for example Samsung "RAM Plus") can move memory to storage when RAM runs low.
- **Browser caching of the app itself.** Browsers cache the app's own files (HTML, script, icons). Your images are never fetched from the network, so they never enter that cache.

When you're done, also close the app from the app switcher so the browser drops its preview of the page.

## Tools

| Tool | Use |
| --- | --- |
| **Box** | Drag to cover an area with solid black or white. This is the safest way to hide text. |
| **Pixelate** | Drag to pixelate an area. Fine for faces and photos. Pixelated *text* can sometimes be reconstructed, so use Box for text. |
| **Brush** | Paint freehand with a solid color. |
| **Move** | Drag to pan. |

Pinch with two fingers to zoom and pan with any tool. Undo and redo cover every edit.

On a computer you can also paste (Ctrl/⌘+V) or drag an image onto the page, zoom with the scroll wheel, and use the shortcuts `B` (Box), `P` (Pixelate), `D` (Brush), `M` (Move), `0` (fit), Ctrl/⌘+Z (undo) and Ctrl/⌘+Shift+Z or Ctrl+Y (redo).

### Saving

The app avoids ordinary browser downloads, because browsers record each one in their download history (file name, time and the site it came from).

| Option | Where | Leaves a download-history entry? |
| --- | --- | --- |
| **Save** → **Share…** → *Save Image* / *Save to Files* | Phones and tablets | No |
| **Save** → **Save as…** (a normal Save As dialog) | Desktop Chrome and Edge | No |
| **Save** → **Copy** | Most browsers | No, but see clipboard under [Limits](#limits) |
| **Save** → **Download** | Only offered when Save As isn't available, with a warning | **Yes** |

Exported files are always named `image.png` (your device adds "(1)" and so on if needed), so the name reveals nothing about redaction or when you exported. The PNG contains only the image itself: no EXIF, location, camera, date, software or text metadata.

**Check what's still visible.** On screenshots, also cover the status bar (clock, carrier, battery, signal) and any notifications: they can reveal when and where a screenshot was taken. The image keeps its original pixel size, which can hint at the device model.

### Add to home screen

- **iPhone/iPad (Safari):** Share → Add to Home Screen.
- **Android (Chrome):** ⋮ menu → Add to Home screen.

It then opens full-screen like an app. Switching away from it or closing it clears everything, just as in the browser.

## Development

There is no build step. Serve the `site/` folder with any static file server, for example:

```sh
npx serve site
```

Pushing to `main` deploys `site/` to GitHub Pages through [`.github/workflows/pages.yml`](.github/workflows/pages.yml). In the repository settings, under **Pages → Build and deployment**, set **Source** to **GitHub Actions**.
