# CodeSculptAi / MBT-01

CodeSculptAi is a code-only procedural Three.js reconstruction of a futuristic main battle tank. The active runtime is generated from object-sculpt-spec.json with the img2threejs forge workflow.

## Canonical workflow

1. Keep the five-view reference at .img2threejs/reference.png.
2. Run intake and strict validation.
3. Generate the current sequential pass:

~~~powershell
python C:\Users\dakem\.codex\skills\img2threejs\forge\stage2_spec\validate_sculpt_spec.py object-sculpt-spec.json --strict-quality
python C:\Users\dakem\.codex\skills\img2threejs\forge\stage3_build\generate_threejs_factory.py object-sculpt-spec.json --out src\generatedModel.ts --pass-id optimization-pass --force
~~~

4. Use the viewer for fixed front/side/top views, orbit, explode, wireframe, and component selection.
5. Run the complete local verification:

~~~powershell
npm run verify
~~~

The verify command runs TypeScript, Vite, reference admission/probing, strict spec validation, part coverage, sequential pass status, and generated-runtime contract checks. It only writes public/pipeline-status.json as ASSET READY after all checks pass.

## Runtime contract

src/runtimeAdapter.ts is the only active model adapter. It consumes root.userData.sculptRuntime from the generated factory and exposes:

- root, nodes, meshes, and componentOrder;
- setExplode, setWireframe, setSelected, tick, and dispose;
- generated sockets, collider proxies, and destruction groups;
- cloned per-mesh materials so selection highlighting cannot mutate shared materials.

The source image is a contact sheet, so projection is intentionally skipped and documented as a limitation. Hidden underside, internal suspension, and turret-ring surfaces remain explicit approximations.

## Materials and assets

Armor, gunmetal, and sensor glass use procedural 1024px PBR maps with independent albedo, roughness, height, normal, and AO channels. Color maps use sRGB; scalar/vector maps use NoColorSpace. All active asset references are relative. Review captures and comparison sheets live under output/review; old implementations and stale snapshots are under archive/legacy and are excluded from the active build.

