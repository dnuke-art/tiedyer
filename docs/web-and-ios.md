# One codebase, two products: the website and the iOS app

Written 2026-09-17, after a day of UI changes, to answer "how does this work on
the iOS app?" once and for all.

## The short version

There is one app. It is the TypeScript + WebGL2 web app in `src/`. The website
serves it from GitHub Pages. The iOS app is the same built files, copied into an
Xcode project and shown full-screen inside a web view (Capacitor). Every button,
slider, canvas, swatch and popup you interact with on the iPhone is the web app,
drawn by the iOS browser engine (WebKit, the same one Safari uses). There is no
separate iOS user interface to keep in sync.

So: **any change to the UI lands in both products automatically**, as soon as it
is built into each one. The two products differ only in a handful of things that
are deliberately switched at build time or at run time. Those are listed below.

## What is web and what is native on iOS

| Piece | On the website | In the iOS app |
|---|---|---|
| Everything you see: views, sidebar, sliders, swatches, chips, hints | The web app | The same web app, in a WKWebView |
| Simulation (folds, cloth, dye, bleach, diffusion) | WebGL2 in the browser | WebGL2 in WebKit, on the device GPU |
| Colour picker popup | The browser's own picker for `<input type="color">`: Chrome's popup on Linux/Windows, the macOS Colors panel on a Mac | iOS's system colour sheet (the one with grid, spectrum and sliders). We never wrote a picker; we only decide when it opens |
| Save / Image export | A file download | The iOS share sheet, with Save Image / Save to Files (`src/native.ts`) |
| Haptics on strokes and bands | Nothing | A light tap via the Haptics plugin |
| GitHub link in the header | Shown | Hidden (`.native a.gh`) |
| Umami analytics tag | Loaded from `index.html` | Stripped at build time (`vite build --mode native`) |
| Safe areas (notch, home indicator) | n/a | Padding from `env(safe-area-inset-*)` under the `.native` class |
| Autosave of the current plan | `localStorage` | `localStorage` inside the web view (persists between launches) |
| App icon, splash, name, privacy manifest, App Store listing | n/a | `ios/` and `ios/appstore/` |

The only bridge is `src/native.ts`, about thirty lines. At run time it asks
whether `window.Capacitor` exists (iOS injects it before our scripts run). If it
does, the body gets the `native` class and the share/haptics plugins are loaded
on demand; if not, everything falls back to plain web behaviour. The website
bundle never includes the plugins.

## Mouse, touch and pen

The app listens to pointer events, so one handler serves mouse, finger and Apple
Pencil. A few interactions are naturally different by input device:

| Action | Mouse (website, or iPad with a mouse) | Touch (iPhone / iPad) |
|---|---|---|
| Squirt dye / place band | Left-drag | One finger |
| Keep pouring so it soaks deeper | Hold the button still | Hold the finger still |
| Orbit the 3D bundle | Right-drag always; left-drag when Paint is off | Two fingers always; one finger when Paint is off |
| Zoom | Wheel, or + / − | Pinch, or + / − |
| Pan | Shift-drag | (use fit, then orbit) |
| Draw a fold line | Click, move to set the angle, click, click the side | Tap, move, tap, tap |
| Select a dye | Click its swatch | Tap its swatch |
| Change a dye's colour | Click the selected swatch again | Tap the selected swatch again; the iOS colour sheet slides up |
| Cancel a fold line / undo a stroke | Esc / z | Undo buttons in the sidebar |

Long-press on the canvases does not show the iOS text callout or magnifier
because the canvases set `touch-action: none` and `-webkit-touch-callout: none`,
which is what makes hold-to-pour work with a finger.

## Which version is where right now

- **Website** (dnuke-art.github.io/tiedyer): every push to `main` rebuilds it
  (`.github/workflows/pages.yml`). It already has everything from today: bleach
  and cloth colour, the paint toggle, the fold preview and mode chip,
  hold-to-pour, and the swatch click fix.
- **iOS app in App Review**: version 0.1.2, build 1789489120, uploaded
  2026-09-15, waiting for review. It predates all of today's changes. That is
  fine: it is a complete app on its own, and a review in progress should not be
  disturbed by swapping builds.
- **Next iOS build**: after 0.1.2 is approved (or if Apple asks for a new build),
  tag `ios-v0.2.0`. GitHub Actions builds and uploads it to TestFlight on a
  macOS runner (`.github/workflows/ios.yml`), then `asc_listing.py` from the
  app-store-release skill fills the listing for 0.2.0 and it goes to review.
  New What's New text and, ideally, a bleach screenshot belong to that step.

## How a change flows

```
edit src/ ──► git push main ──► Pages workflow ──► website updated (minutes)
                 │
                 └─► git tag ios-vX.Y.Z ──► ios.yml on macOS ──► TestFlight
                                                                    │
                                              asc_listing.py ──► App Store review
```

`npm run build` makes the website. `npm run build:ios` makes the native variant
(analytics stripped) and copies it into `ios/App/App/public` for Xcode. Nothing
in `ios/` needs editing for a UI change; it changes only for app-level things
(icon, permissions, plugins, version).

## Things worth knowing

- **The picker looks different on every platform, by design.** It is the
  platform's control. If we ever want it to look the same everywhere, or to
  offer dye presets, we would write our own picker in the web app and it would
  then be identical on the site and in the app.
- **Chrome versus Safari.** The website is used mostly in Chrome; the iOS app
  is always WebKit. Anything that renders differently between the two shows up
  as a website-vs-app difference. The headless test harness (`tools/shot.mjs`)
  runs Chromium, so WebKit-only issues are found on a device, via TestFlight.
- **TestFlight is the preview channel.** Any tag builds in about ten minutes
  and appears on the phone automatically (internal group, automatic
  distribution). Tag freely; it does not touch the App Store version.
- **The autosaved plan is per product.** The website's last plan lives in the
  browser; the app's lives in the app. They do not sync. Save / Load moves a
  plan between them as a JSON file.
