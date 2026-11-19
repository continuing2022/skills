# h5App-js Porting Reference

## Project Map

The migration moves the H5 host layer from Kotlin/JS to native JavaScript while keeping Kuikly render core and page bundles intact.

- Kotlin source: `h5App/src/jsMain/kotlin`
- JS host app: `h5App-js/src`
- Kotlin render core artifact: `h5App-js/src/libs/KuiklyCore-render-web-h5.js`
- Page bundles and manifest: `h5App-js/src/bundles`
- Build and validation entry: `h5App-js/package.json`, especially `npm run build`

Runtime shape:

1. `index.html` loads bundle config, manifest, page bundles, core lib, and `h5App.js`.
2. `KuiklyWebRenderViewDelegator` attaches the page and registers external modules, render views, and view props.
3. JS registries expose host-layer implementations to Kuikly.

## Discovery Checklist

Before implementing a migration:

- Find the Kotlin source file and read the whole class/object being ported.
- Find the JS target subsystem and nearest migrated analogue.
- Compare the original and neighboring files' class comments, domain notes, comment language, and formatting before writing the JS implementation.
- Search for constants from the Kotlin source: names, method strings, event names, prop keys, `MODULE_NAME`, `VIEW_NAME`.
- Search for every Kotlin usage site of the target: imports, callers, entry-point initialization, lifecycle cleanup, registries, factories, and sibling integrations. Map each one to the corresponding JavaScript usage or explicitly approved deferred scope.
- Audit Kotlin imports and qualified calls to dependencies such as `utils.*`, adapters, processors, SDK wrappers, sibling components, and modules.
- Map each Kotlin dependency to an existing JS file or exported helper before implementing the caller.
- Identify all browser APIs, global SDKs, callbacks, timers, object URLs, and lifecycle cleanup points.
- Identify registry changes needed in `ComponentsRegistry`, `ModuleRegistry`, or `PropHandler`.

Prefer codebase-memory graph tools for code discovery when available. Fall back to `rg` for literals, config, generated bundles, and non-code files.


## Dependency Audit And Missing Utility Gate

Run this gate before implementing any migrated caller.

1. List every Kotlin dependency used by the target file, including imports and qualified calls. Pay special attention to `utils.*`, adapters, processors, modules, components, and SDK wrappers.
2. For each dependency, look for the JS equivalent under `h5App-js/src`, preferring the matching subsystem path such as `utils/COS.js`, `utils/File.js`, `utils/Client.js`, `utils/Container.js`, or existing processor files.
3. If the JS equivalent exists, reuse it instead of duplicating behavior in the caller.
4. If the JS equivalent is missing, pause before editing the caller and ask the user whether to port the dependency now. Do not silently replace it with a partial fallback, object URL shortcut, runtime global shim, or unsupported no-op.
5. Continue only after the user chooses one path: port the dependency, intentionally defer it with a clearly documented limitation, or adjust the migration scope.

Use a concrete question such as:

```text
`WGDropUploadProp.kt` depends on `COS.uploadFiles` from `COS.kt`, but `h5App-js/src/utils/COS.js` is missing. Should I port `COS.js` first, or keep this migration blocked/deferred until COS is available?
```

Example: `WGDropUploadProp.kt` uses both `File.isImage` and `COS.uploadFiles`. A correct migration first checks whether `File.js` and `COS.js` exist. If `COS.js` is absent, ask before implementing `WGDropUploadProp.js`; do not invent a local uploader fallback unless the user explicitly approves that tradeoff.


## Component Pattern

Use this pattern when porting files from `components/`.

- Preserve `static VIEW_NAME` exactly.
- If Kotlin delegates to a core Kuikly view such as `KRTextFieldView`, `KRTextAreaView`, or `KRView`, create the core view via `kuiklyRenderExport.createRenderView(...)` in `ComponentsRegistry` and wrap it.
- Forward unknown `setProp`, `resetProp`, `call`, shadow, parent, frame, and destroy behavior to the delegate.
- Mirror Kotlin lifecycle cleanup in `onDestroy`.
- Keep custom event binding reset-aware. If props can include event modifiers, use the existing `WGEventModifier` helpers.
- Preserve comments that explain component intent, event de-duplication, browser compatibility, business-specific branches, or cleanup ownership. Match the nearest JS component's comment style and avoid comments that only restate the next line.

Canonical example: `WGTextarea.js` wraps `KRTextAreaView`, handles paste/keydown/lineHeight/focusCursorToPosition, then delegates everything else. Use it as the default component style unless the Kotlin source owns the full DOM element.

Registry shape:

```js
[
  WGTextarea.VIEW_NAME,
  kuiklyRenderExport => new WGTextarea(kuiklyRenderExport.createRenderView('KRTextAreaView')),
]
```

## Module Pattern

Use this pattern when porting files from `module/`.

- Preserve `static MODULE_NAME` exactly, including legacy names such as `HRBridgeModule`.
- Implement `call(method, params, callback)` unless the local JS module pattern requires a wrapper.
- Treat `params` as the same type Kotlin expected, usually a JSON string. Parse with `JSON.parse(params || '{}')` only when Kotlin parsed JSON.
- Preserve synchronous return values. If Kotlin returned a string, JS should return a string.
- Preserve async callback payloads. If Kotlin used a `ModuleResponse.success/error` shape, keep that shape.
- Unknown methods should match nearby migrated behavior: return `null`, or callback an error only if the existing module does so.

Registration belongs in `h5App-js/src/modules/ModuleRegistry.js`:

```js
const baseModules = [
  [WGLogModule.MODULE_NAME, () => new WGLogModule()],
];
```

Use existing utilities such as `UI.js`, `Url.js`, `FileStore.js`, and `Client.js` instead of reimplementing browser helpers inside modules. If the Kotlin module calls a utility that has not been ported, ask whether to port that utility before completing the module.

## Prop Pattern

Use this pattern when porting files from `props/`.

- Preserve each Kotlin `KEY` and the generated external key convention: `wgH5` + capitalized key, for example `width` -> `wgH5Width`.
- Legacy props such as `customElementAttr` register by the raw key.
- Keep both set and reset handlers in `PropHandler.js`.
- Return `true` when the prop is handled, even when the target DOM element is missing, matching the Kotlin handlers.
- Reset should mirror Kotlin behavior, including clearing style, dataset, DOM handlers, or attributes.

Registry shape:

```js
const setHandlers = {
  [WGCustomElementAttr.KEY]: WGCustomElementAttr.set,
  [getKey(WGWidthProp.KEY)]: WGWidthProp.set,
};
```

Known migrated props:

- `WGCustomElementAttr`: date input and PC date range behavior, using `Client.PC`.
- `WGWidthProp`: delayed `width: auto` override.
- `WGCursorProp`: pointer/default cursor.
- `WGDropUploadProp`: drop upload event wiring and upload result dispatch.
- `WGHoverProp`: `data-hover` values consumed by CSS in `index.html`.

## Utility/Event Pattern

Use this pattern when porting utilities, adapters, event managers, and processors.

- Put shared browser/platform helpers in `h5App-js/src/utils`.
- Use `Client.js` for UA, mobile, WeChat, mini app, PC, CEF bridge, and container id checks.
- Use `FileStore` for temporary file/object URL lifecycle when a feature creates browser-side file handles.
- Use existing paste and keydown processors instead of duplicating clipboard or shortcut parsing.
- For event managers, keep start/stop symmetry and remove listeners from both `window` and top-window equivalents when the Kotlin source did.
- For global SDKs such as WeChat, Sensors, PAG, IM, or COS, first determine whether the Kotlin wrapper utility has a JS equivalent. If the wrapper is missing, ask whether to port it before relying on globals or fallback behavior.

## Data And Callback Contracts

Kotlin/JS callbacks are not always plain JavaScript functions. Nearby migrated code may call callbacks directly, but new shared code should support these forms when possible:

```js
function invokeKuiklyCallback(callback, payload) {
  if (!callback) return;
  if (typeof callback === 'function') callback(payload);
  else if (typeof callback.invoke === 'function') callback.invoke(payload);
  else if (typeof callback.or_1 === 'function') callback.or_1(payload);
}
```

Use the local subsystem's established payload convention:

- Component DOM events often callback JSON strings.
- Module callbacks often callback JS objects or `ModuleResponse`-like structures.
- Events sent to the page should go through the delegator or `WGEventManager.sendEvent`, preserving event names and `paramData` nesting.
- Data passed into the Kotlin delegator should remain plain JS objects unless the delegator helper converts them to Kotlin maps.
- A direct call to an exported Kotlin method typed as `Map`, such as `kuiklyRenderRootView.sendEvent(event, data)`, must pass a Kotlin Map. Convert `data` with the core `jsObjectToMap(data, Object.keys(data))` helper (centralized in `KuiklyInterop`) or route through a delegator that performs that conversion. A plain object is not runtime-compatible merely because JavaScript accepts the call.
- Do not fall back from a missing Map converter by returning the original JS object. Fail synchronously with a clear interop error; otherwise the value can cross an async render queue and surface later as `THROW_CCE` in `BridgeManager.callKotlinMethod`, where the originating call is no longer in the stack and its `try/catch` cannot help.

### Diagnosing `BridgeManager.callKotlinMethod` CCEs

Use the generated bundle stack line to identify the failed cast before changing host code:

- `methodId = 1` creates a page and expects page id, URL, and params JSON string.
- `methodId = 2` updates a page/fires a page event and expects page id, event name, and event payload JSON string.
- If the failure is on the third argument cast for `methodId = 2`, audit every direct `sendEvent` call. The Kotlin render context converts Kotlin `Map`/`List`/`JSONObject`/`JSONArray` arguments to JSON strings, but it intentionally passes an unrecognized plain JS object through unchanged.
- Remember that render-context calls may be queued. A `try/catch` around `rootView.sendEvent(...)` does not prove the payload was valid if the cast occurs later on the queue.

## Validation Checklist

After implementing a migration:

- Confirm the file exports the expected class/object name and constants.
- Confirm registry wiring exists and uses the same `VIEW_NAME`, `MODULE_NAME`, or prop key as Kotlin.
- Confirm every Kotlin usage site of the migrated target has corresponding JavaScript wiring, including entry-point initialization and lifecycle cleanup. A migrated file that is never imported, registered, initialized, or called where Kotlin used it is incomplete.
- Confirm every Kotlin dependency used by the migrated file is either mapped to an existing JS helper or explicitly approved by the user as a new dependency migration/deferred limitation.
- Confirm unsupported or delegated props/methods still flow to the wrapped delegate where applicable.
- Confirm reset/destroy removes listeners, clears DOM style/attributes/dataset, and releases object URLs or timers.
- Confirm callback payloads match Kotlin behavior and nearby JS migrations.
- Confirm every JS call into a Kotlin parameter typed as `Map` uses the shared JS-to-Kotlin Map converter, including direct root-view calls that bypass the main delegator.
- For event-bridge changes, exercise an object payload and an empty/null payload; verify neither reaches `BridgeManager` as a raw object or null.
- Confirm class-level and non-obvious behavioral comments were preserved or adapted, and that their language, density, and formatting match neighboring JS files.
- Run from `h5App-js`:

```bash
npm run build
```

Existing Webpack asset-size warnings are not migration failures. Syntax errors, missing imports, unresolved aliases, and changed callback contracts are failures.

## Common Pitfalls

- Do not add registrations directly in `KuiklyWebRenderViewDelegator.js` when a registry exists.
- Do not assume Kotlin callbacks are always plain functions.
- Do not change public string constants to more JavaScript-like names.
- Do not duplicate PC/mobile/client detection; use `Client.js`.
- Do not implement caller-local versions of missing Kotlin utilities such as COS, File, Container, Client, WeChat, or IM helpers. Ask whether to port the missing utility first.
- Do not drop meaningful Kotlin comments during migration or introduce a different comment style from neighboring JS files.
- Do not introduce a new dependency unless the Kotlin feature cannot be represented with existing browser APIs or already-loaded globals, and the user has approved the dependency decision.
- Do not rewrite generated bundle files under `h5App-js/src/bundles` while migrating host-layer code.
