# wam-plugins

[Web Audio Module](https://www.webaudiomodules.com/) (WAM 2.0) plugins, generated from [Cmajor](https://cmajor.dev) DSP patches via `cmaj generate --target=wam`, hosted on GitHub Pages for use in any WAM host.

## Plugins

| Plugin | index.js | GUI test page |
|---|---|---|
| Pro54 — Prophet-5-style synth (dual osc, resonant filter, LFO, poly-mod, 73 params, ~140 factory presets) | [`Pro54/index.js`](https://anouar-bm.github.io/wam-plugins/Pro54/index.js) | [`Pro54/index.html`](https://anouar-bm.github.io/wam-plugins/Pro54/index.html) |

Source: [cmajor-lang/cmajor examples/patches/Pro54](https://github.com/cmajor-lang/cmajor/tree/main/examples/patches/Pro54)

## Using a plugin in a WAM host

Point your host at the `index.js` URL, e.g.:

```js
const [pluginFactory] = await import("https://anouar-bm.github.io/wam-plugins/Pro54/index.js");
const plugin = await pluginFactory.createInstance(hostGroupId, audioContext);
```

## Adding a new plugin

```
cmaj generate --target=wam path/to/Thing.cmajorpatch --output=Thing/
git add Thing && git commit -m "Add Thing WAM build" && git push
```

Pages serves straight from `main` at repo root, so `Thing/index.js` becomes live at `https://anouar-bm.github.io/wam-plugins/Thing/index.js` right after the push.
