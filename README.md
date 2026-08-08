# wam-plugins

[Web Audio Module](https://www.webaudiomodules.com/) (WAM 2.0) plugins, self-hosted on GitHub Pages so they don't break when an upstream host changes or disappears.

## Plugins

### Featured

| Plugin | index.js | GUI test page |
|---|---|---|
| Pro54 — Prophet-5-style synth (dual osc, resonant filter, LFO, poly-mod, 73 params, ~140 factory presets) | [`Pro54/index.js`](https://anouar-bm.github.io/wam-plugins/Pro54/index.js) | [`Pro54/index.html`](https://anouar-bm.github.io/wam-plugins/Pro54/index.html) |

Generated from [cmajor-lang/cmajor examples/patches/Pro54](https://github.com/cmajor-lang/cmajor/tree/main/examples/patches/Pro54) via `cmaj generate --target=wam`.

### Community (58 plugins)

Mirrored build output of [boourns/wam-community](https://github.com/boourns/wam-community) (built with [boourns/burns-audio-wam](https://github.com/boourns/burns-audio-wam) as a dependency), under [`community/`](community/):

- **Sequencer Party** (25 plugins) — `community/burns-audio/`
- **Wimmics** (33 plugins) — `community/wimmics/`

Full index with names, categories, and paths: [`community/plugins.json`](https://anouar-bm.github.io/wam-plugins/community/plugins.json)

## Using a plugin in a WAM host

Point your host at the `index.js` URL, e.g.:

```js
const [pluginFactory] = await import("https://anouar-bm.github.io/wam-plugins/Pro54/index.js");
const plugin = await pluginFactory.createInstance(hostGroupId, audioContext);

// community plugin, e.g. burns-audio/distortion:
const [distortionFactory] = await import("https://anouar-bm.github.io/wam-plugins/community/burns-audio/distortion/index.js");
```

## Adding a new plugin

Cmajor-based:
```
cmaj generate --target=wam path/to/Thing.cmajorpatch --output=Thing/
git add Thing && git commit -m "Add Thing WAM build" && git push
```

Refreshing the community mirror:
```
# in a clone of boourns/wam-community
yarn install && node ./tools/build.js
cp -R dist/plugins/. path/to/wam-plugins/community/
cp dist/plugins.json path/to/wam-plugins/community/plugins.json
git add community && git commit -m "Update community plugin mirror" && git push
```

Pages serves straight from `main` at repo root, so any new `Thing/index.js` becomes live at `https://anouar-bm.github.io/wam-plugins/Thing/index.js` right after the push.
