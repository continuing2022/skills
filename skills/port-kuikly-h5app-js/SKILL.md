---
name: port-kuikly-h5app-js
description: Guide for migrating Kuikly H5 Kotlin/JS host-layer code from h5App/src/jsMain/kotlin into the native JavaScript h5App-js project. Use when porting components, modules, props, utils, event managers, adapters, or browser/PC/client behavior while preserving Kuikly render contracts, MODULE_NAME/VIEW_NAME keys, callback shapes, registry wiring, and npm build validation.
---

# Port Kuikly H5 App To JS

## Core Workflow

1. Inspect the original Kotlin file under `h5App/src/jsMain/kotlin` and the nearest migrated JavaScript analogue under `h5App-js/src` before editing.
2. Classify the target as a component, module, prop, util, event manager, adapter, or processor.
3. Audit every Kotlin dependency used by the target, especially `utils.*`, adapters, processors, SDK wrappers, and sibling components/modules. Map each dependency to an existing JS equivalent before editing.
4. If a Kotlin dependency has no JS equivalent, pause and ask the user whether to port that dependency now. Do not silently add a fallback, stub, runtime global shim, or partial behavior unless the user explicitly chooses that tradeoff.
5. Audit every Kotlin usage site of the target, including imports, callers, entry-point initialization, lifecycle cleanup, registries, factories, and sibling integrations. Update the corresponding JavaScript usage and wiring in the same migration; creating the JS file alone is not complete. If a required consumer has not been ported or expands the scope materially, pause and ask the user before proceeding.
6. Preserve the public protocol exactly: `VIEW_NAME`, `MODULE_NAME`, prop keys, method names, params shape, return value shape, event names, and callback payloads.
7. Use existing JS registries and helpers instead of adding one-off wiring in `KuiklyWebRenderViewDelegator.js`, unless no registry exists for that subsystem.
8. Treat the original Kotlin file as the source of truth for comment content. Preserve useful comments with their original meaning and language, while matching the nearest migrated JavaScript analogue's formatting and density. Adapt wording only when JavaScript implementation differences require it, and keep adapted comments accurate. Add concise comments for non-obvious compatibility behavior, browser workarounds, lifecycle cleanup, and protocol-sensitive logic; do not narrate self-explanatory code.
9. Run `npm run build` from `h5App-js` after implementation and report any existing bundle-size warnings separately from real failures.

## Required Reference

Read `references/h5app-js-porting.md` before implementing any non-trivial migration. It contains the project map, component/module/prop patterns, callback compatibility rules, utility reuse guidance, and validation checklist.

Use targeted reading from the reference when the task is narrow:

- Component or view migration: read Dependency Audit, Component Pattern, and Validation Checklist.
- Module migration: read Dependency Audit, Module Pattern, and Data/Callback Contracts.
- Prop migration: read Dependency Audit and Prop Pattern.
- Utility/client/event migration: read Dependency Audit, Utility/Event Pattern, and Shared Helpers.

## Migration Rules

- Prefer native JavaScript data handling over mirroring Kotlin JSON APIs. Do not add helpers such as `isJSONObject`, `parseJSONObject`, `optJSONObject`, `optJSONArray`, `optBoolean`, `optLong`, or `optString` solely to reproduce `JSONObject`/`JSONArray` behavior; use `JSON.parse`, normal property access, optional chaining, `Array.isArray`, and `typeof` instead. Keep concise boundary validation only where external input, malformed JSON, or corrupted storage requires safe fallback behavior.
- Prefer wrapping a Kuikly core render view with small JS behavior extensions when the Kotlin implementation delegates to a core view, as in `WGTextarea` and `WGInput`.
- Keep browser state cleanup symmetrical: every event listener, timer, object URL, global hook, or SDK listener added by a component/module must be removed or reset in `resetProp`, `onDestroy`, `stop`, or the equivalent lifecycle method.
- Centralize shared behavior in `h5App-js/src/utils` when more than one migrated file needs it. Do not duplicate UA/client checks; use `Client.js`. If the original Kotlin code calls a utility such as `COS.kt`, `File.kt`, `Client.kt`, or `Container.kt`, verify the JS utility exists before implementing the caller.
- Treat Kotlin/JS callbacks carefully. A callback may be a function, an object with `invoke`, or an object with compiler-generated methods such as `or_1`; preserve the shape used by nearby migrated code.
- When a Kuikly prop callback appears in DevTools as an object like `$a { or_1: f }`, invoke it as `propValue.or_1(payload)`. Do not assume `propValue(payload)` or `propValue.invoke(payload)` will work; centralize this compatibility in a shared JS callback invoker when multiple processors/components need it.
- Treat exported Kotlin collection types as a runtime boundary, not just TypeScript documentation. Before JS calls a Kotlin API typed as `Map` (especially `sendEvent` and `onAttach`), convert the plain JS object with the core `jsObjectToMap` helper. Do not pass a plain object through as a fallback: it can fail asynchronously in `BridgeManager.callKotlinMethod` with `THROW_CCE`, outside the caller's `try/catch`.
- When a stack points to `BridgeManager.callKotlinMethod` and `THROW_CCE`, inspect the generated page-bundle line for the exact method id and argument cast. For update/page-event calls (`methodId = 2`), verify that the event payload reaches Kotlin as a Map and reaches the page bundle as a JSON string before investigating callback shapes.
- Use the original Kotlin comments as the content baseline. Retain class-level intent, inline behavior notes, domain notes, and the original comment language. Adapt only comments made inaccurate by JavaScript-specific implementation or approved optimizations, and keep formatting and density consistent with neighboring JS files.
- If a required Kotlin utility or adapter is missing in JS, ask the user whether to implement it. Example: when porting `WGDropUploadProp.kt`, notice `COS.uploadFiles` and `File.isImage`; if `h5App-js/src/utils/COS.js` is absent, ask whether to port `COS.js` before writing `WGDropUploadProp.js`. Apply the same rule to all referenced utilities, adapters, processors, and SDK wrappers.
- Do not rewrite the Kuikly render core. The JS project remains a host layer around `h5App-js/src/libs/KuiklyCore-render-web-h5.js` and page bundles.
