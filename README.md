# anyPWA Media Controls

The page adapter behind the playback controls of the [anyPWA](https://anypwa.app) app
on YouTube and YouTube Music: audio-only playback, a chosen video quality, and the
connection and background profiles that switch between them.

It works through the website's own player. It chooses which stream that player loads,
and never writes volume or mute, never wraps play, pause or seek, and never reloads the
page or replaces the player.

## How the app uses it

The app ships with a copy of `media-controls.js` and checks this repository for a newer one:

- It downloads `media-controls.js` from the `main` branch about once a day and whenever
  the user updates its filter lists, but only after the user has allowed those downloads.
- It uses the download only when its major version is the one the app was built for and
  its version is higher than the copy shipped with the app. A download with another major
  version or one that does not compile is rejected, and the previous copy stays in use.
- A new version takes effect at the next page load. A page that is already playing keeps
  the copy it started with.

Every push to `main` reaches the installed apps.

## Native control

The adapter is passive until the app calls `configure({audioOnly, quality, background})`.
Version 1.1.0 adds the backwards-compatible `disable()` method: it stops preference enforcement and artwork polling,
cancels pending HLS work, and leaves the website's current stream, pause state and choices
untouched. The real pointer-press compatibility forwarding stays available while disabled.
The app calls `disable()` when the Media Controls purchase is absent or revoked.

## Versioning

The `@version` line in the leading comment follows semantic versioning:

- **MAJOR** changes only when an incompatible change is made to the interface between the script and the app: the
  arguments of `configure({audioOnly, quality, background})`, the result of `state()`, or
  the messages posted to the `anyPWAMediaControls` handler. Apps keep using the last copy
  with their own major version.
- **MINOR** covers backwards-compatible additions; **PATCH** covers fixes that keep the existing interface.

Every change to `media-controls.js` must raise the version; the test workflow checks this.
To roll back, publish the earlier code under a new, higher version.

## Development

Node.js 22 or later:

```sh
node --check media-controls.js
node --test test/*.test.mjs
node scripts/check-version.mjs origin/main
```

## License

Copyright (C) 2026 Adam Wallner

anyPWA Media Controls is dual-licensed. You may use it under either:

- the GNU General Public License, version 3 or (at your option) any later version,
  see [LICENSE](LICENSE); or
- a separate commercial license from the copyright holder.

The anyPWA app includes this script under the copyright holder's own terms. For a
commercial license, contact the copyright holder through
[GitHub](https://github.com/wallneradam).

### Contributions

By submitting a contribution, for example a pull request, you license it under
GPL-3.0-or-later and agree that the copyright holder may also distribute it under the
commercial license above, including in the anyPWA app.
