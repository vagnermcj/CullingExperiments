# CLAUDE.md

## What this project is

A WebGPU test bed for **GPU-driven culling** on a real industrial CAD model (the P-75 `envmesh` dataset, ~499 M triangles in ~1.47 M octree cells, streamed as an HLOD hierarchy). The goal is to study and benchmark two techniques:

1. **GPU-driven frustum culling**: a compute shader tests every resident cell's bounding box against the six frustum planes and writes the `instanceCount` of its indirect draw arguments. The CPU never reads visibility back.
2. **Two-pass occlusion culling (GPU driven, Hi-Z)**: the cells visible last frame are drawn first, a hierarchical depth buffer (Hi-Z / depth pyramid) is built from that depth, and then everything else is tested against the pyramid; the newly visible cells are drawn in a second pass. This avoids the one-frame lag of reprojection-based schemes and needs no CPU readback.

Stack: Vite + TypeScript, raw WebGPU API and WGSL shaders. three.js is used only for math, cameras and fly controls (no three.js renderer, no TSL / node materials). React + leva for the UI.

See `README.md` for the full description of loading, HLOD selection, the GPU frustum culling pipeline and the benchmark.

## Layout

- `src/cad/`: hierarchy, HLOD selection, streaming, worker decoding, CPU culling hooks (`cullingHooks.ts`, also holds `cullingConfig.mode`).
- `src/gpu/`: renderer, cell slots and buffers, frustum plane extraction, shaders (`cull.wgsl`, `render.wgsl`, `overlay.wgsl`).
- `src/benchmark/`: camera path, runner, results UI, saved runs (localStorage).
- `public/data/cad/`: the dataset (git-ignored, multi-GB).

## Working rules

- **The user writes the culling techniques by hand, to learn them.** Do not implement occlusion culling, the Hi-Z pyramid, the two-pass pipeline or their infrastructure unless explicitly asked for that specific piece. Loading, HLOD, environment, tooling and benchmark work is fine. When unsure whether something is "the technique" or "the environment", ask.
- The occlusion extension point is already marked in `cull.wgsl` (reserved `FLAG_OCCLUSION` bit, a spot after the frustum test). The main pass renders to a `depth32float` texture with `TEXTURE_BINDING` usage and no MSAA, so a depth pyramid can be built from it.
- Culled cells are simply not drawn, everywhere (main view and minimap). No tinted or debug-coloured "culled" geometry.
- Code, comments and UI text are in English. Chat with the user in Portuguese.

## Testing

- **Do not run visual tests** (opening the app in a browser, screenshots, flying the camera, checking the rendered image). The user does those.
- **Only run the formatting / static checks** after a change:

```bash
npm run format:check
npm run lint
npx tsc --noEmit
```

Use `npm run format` / `npm run lint:fix` to fix what they report.

## Main references

- Ulrich Haar and Sebastian Aaltonen, _GPU-Driven Rendering Pipelines_ (Assassin's Creed Unity, Ubisoft), Advances in Real-Time Rendering course, SIGGRAPH 2015. The origin of the two-pass occlusion culling scheme used here: https://advances.realtimerendering.com/s2015/
- Milosz Krupa, _Two-Pass Occlusion Culling_: https://medium.com/@mil_kru/two-pass-occlusion-culling-4100edcad501
- _Two-Pass Hierarchical Z-Buffer Occlusion Culling_: https://medium.com/@Lucmomber/two-pass-hierarchical-z-buffer-occlusion-culling-93171c5a9808
