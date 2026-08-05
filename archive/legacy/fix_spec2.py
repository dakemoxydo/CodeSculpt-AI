import json
from pathlib import Path

path = Path("object-sculpt-spec.json")
spec = json.loads(path.read_text(encoding="utf-8"))
map_paths = {
    "albedo": ".img2threejs/pbr-evidence/painted-metal_albedo.png",
    "roughness": ".img2threejs/pbr-evidence/painted-metal_roughness.png",
    "height": ".img2threejs/pbr-evidence/painted-metal_height.png",
    "normal": ".img2threejs/pbr-evidence/painted-metal_normal.png",
    "ao": ".img2threejs/pbr-evidence/painted-metal_ao.png",
}
spec["preSpecAssessment"]["unknownsToResolveBeforeImplementation"] = []
for material in spec.get("materials", []):
    pbr = material.get("referencePbr")
    if isinstance(pbr, dict):
        pbr["maps"] = {channel: {"path": value, "channel": channel} for channel, value in map_paths.items()}
for detail in spec["preSpecAssessment"]["detailInventory"]["details"]:
    if detail["id"] == "turret-canister-gloss":
        detail["mapsTo"]["ref"] = "canister-gloss"
    if detail["id"] == "suspension-rods":
        detail["kind"] = "ridge"

def add_component(cid, name, parent, position, evidence):
    return {
        "id": cid, "name": name, "level": "meso", "role": "panel", "importance": 0.68, "confidence": 0.74,
        "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": f"The visible {name.lower()} is a separate shallow armored module attached to the hull.",
        "geometryDescriptor": {"topologyIntent": "shallow rigid armor module", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"},
        "parent": parent, "attachment": {"parentId": parent, "parentSocket": f"{parent}-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.22], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": evidence},
        "dimensions": {"width": 0.92, "height": 0.42, "depth": 0.38, "units": "meters", "confidence": 0.74}, "transform": {"position": position, "rotation": [0, 0, 0], "scale": [1, 1, 1]},
        "actionProfile": {"animationRole": "detachable-panel", "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.74}, "transformChannels": {"translate": True, "rotate": True, "scale": True, "detach": True, "visibility": True, "materialState": True}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": False}, "constraints": [], "destruction": {"breakable": True, "fractureGroup": cid, "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"}},
        "material": "armor", "materialLayers": ["armor"], "deformations": [], "joints": [], "seams": [], "localFeatures": [cid + "-seam"], "surfaceDetail": {"macroRoughness": 0.4, "microRoughness": 0.2, "bumpAmplitude": 0.06}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(102, 121, 82, 1.0)", "secondaryAlbedo": "rgba(52, 64, 43, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(102, 121, 82, 1.0)"}, {"position": 1, "color": "rgba(52, 64, 43, 1.0)"}]}}, "evidenceRefs": evidence, "details": [], "fidelityTier": "structural-pass",
    }

spec["componentTree"].extend([
    add_component("smoke_launcher_pods", "Smoke launcher pods", "turret_shell", [1.35, 1.72, -0.1], ["front-three-quarter", "rear-three-quarter"]),
    add_component("rear_port_modules", "Rear port modules", "engine_deck", [0, 1.25, 2.9], ["rear-three-quarter", "top-view"]),
])
path.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("fixed strict spec gates")
