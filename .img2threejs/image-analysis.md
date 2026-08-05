# Image analysis — current reference

## Intake verdict

The supplied image is a five-view contact sheet of one stylized futuristic tracked main battle tank: front three-quarter, rear three-quarter, side, top, and frontal views. It is a suitable multi-view target for a real-time procedural Three.js reconstruction. The target is a compound hard-surface object with repeated bilateral systems and enough views to infer the major hidden-side proportions.

## Macro structure

- Low tracked hull with a tapered/wedge front glacis, broad side armor, rear engine block, and a raised top deck.
- Independent faceted turret with a long main barrel, mantlet, roof sensor housings, antenna-like posts, and paired cylindrical side canisters.
- Bilateral track assemblies with six visible road-wheel positions, drive/idler wheels, suspension members, and repeated tread links.

## Meso structure

- Front glacis has a centered raised segmented armor plate, two recessed suspension channels, angular cheek blocks, and dark rectangular lamps/openings.
- Hull sides have layered skirts, repeated fasteners/hinges, small vents, access panels, and narrow reflective inset strips.
- Turret has a low polygonal dome, stepped front cheeks, a central barrel root, rear/top equipment blocks, and side-mounted paired cylinders.
- Rear view exposes rectangular engine/deck modules, vents, access panels, and two separate track loops.
- Top view confirms bilateral symmetry, turret footprint, longitudinal hull layout, and the barrel axis.

## Materials and surface response

- Main armor: muted olive painted composite/metal, satin-to-semi-matte response, faceted edge highlights, sparse edge wear.
- Track links and recessed hardware: dark rubber/painted metal with high roughness and low-value cavities.
- Wheels, rods, barrel rings, and canisters: dark gunmetal with localized brighter worn edges.
- Optics and inset strips: smoked blue-grey glass or coated optical material with lower roughness and restrained transmission/clearcoat.
- Reference lighting is soft studio lighting on a dark neutral background; do not bake it into albedo for the relightable model.

## Identity-defining features

1. Long low tracked silhouette with six-wheel cadence.
2. Angular split glacis and raised central front armor pattern.
3. Faceted low turret with long stepped cannon.
4. Paired cylindrical side canisters on the turret.
5. Repeated side-skirt fasteners and layered armor segments.
6. Rear engine vents and modular rectangular panels.
7. Muted olive palette separated from dark tracks and gunmetal details.

## Hidden or uncertain regions

The underside, internal suspension, internal turret ring, and unseen faces of small mounted modules remain inferred. The five-view contact sheet substantially reduces uncertainty, but it does not prove internal topology or exact dimensions. The output must be described as a procedural reconstruction, not an exact production mesh.

## Build implications

- Use separate named groups for hull, each track, turret, barrel, glacis, skirts, wheels, suspension, sensors, vents, canisters, launchers, and rear modules.
- Carry silhouette-critical armor and suspension relief as geometry; use procedural material variation only for micro-surface response.
- Keep the two track systems and turret independently pivotable, explodable, and selectable.
- Review front three-quarter, rear three-quarter, side, top, and frontal views; use orbit renders for 3D truth rather than relying on one projected sheet.
