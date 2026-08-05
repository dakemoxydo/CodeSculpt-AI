from __future__ import annotations

import copy
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
spec_path = ROOT / "object-sculpt-spec.json"
spec = json.loads(spec_path.read_text(encoding="utf-8"))

evidence_ids = ["full-object", "front-three-quarter", "rear-three-quarter", "side-view", "top-view", "frontal-view"]
spec["sourceImage"] = ".img2threejs/reference.png"
spec["suitability"] = "conditional"
spec["assumptions"] = [
    "Stylized realtime approximation; the supplied contact sheet does not provide exact manufacturing dimensions.",
    "Hidden underside, internal suspension, and turret-ring geometry are inferred and intentionally simplified.",
    "The reference contains several views, so projection is not used; procedural materials preserve relightability.",
]
spec["coordinateFrame"] = {
    "front": "negative Z / cannon direction",
    "back": "positive Z / engine deck",
    "up": "positive Y",
    "right": "positive X",
    "scaleReference": "1 unit = 1 meter; hull length = 8.4 units",
}
spec["silhouette"] = {
    "boundingShape": "low elongated cuboid chassis with bilateral tracked loops, faceted turret, and a long coaxial cylindrical barrel",
    "aspectRatios": ["hull length:width:height = 8.4:4.8:1.8", "turret length:width:height = 4.0:3.4:1.15", "barrel length:hull length = 0.78"],
    "symmetry": "bilateral across the longitudinal centerline; turret and barrel are rotationally articulated",
    "dominantCurves": ["rounded rectangular track loops", "circular road-wheel hubs", "cylindrical barrel and side canisters"],
    "negativeSpaces": ["track run around road wheels", "suspension gaps between wheels", "clearance ring between turret and hull"],
    "landmarks": ["wedge glacis", "faceted turret roof", "six-wheel cadence per side", "paired turret canisters", "dark rear vent blocks"],
}
spec["viewEvidence"] = [
    {"id": "full-object", "view": "contact-sheet", "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1, "units": "normalized"}, "observations": ["five-view stylized armored vehicle reference"], "confidence": 0.9},
    {"id": "front-three-quarter", "view": "front-3/4", "imageRegion": {"x": 0, "y": 0, "width": 0.5, "height": 0.5, "units": "normalized"}, "observations": ["wedge glacis, turret, barrel, tracks"], "confidence": 0.92},
    {"id": "rear-three-quarter", "view": "rear-3/4", "imageRegion": {"x": 0.5, "y": 0, "width": 0.5, "height": 0.5, "units": "normalized"}, "observations": ["rear armor and engine deck"], "confidence": 0.82},
    {"id": "side-view", "view": "side", "imageRegion": {"x": 0, "y": 0.5, "width": 0.33, "height": 0.5, "units": "normalized"}, "observations": ["track loop, six wheels, turret profile"], "confidence": 0.9},
    {"id": "top-view", "view": "top", "imageRegion": {"x": 0.34, "y": 0.5, "width": 0.33, "height": 0.5, "units": "normalized"}, "observations": ["deck vents, hull footprint, turret footprint"], "confidence": 0.86},
    {"id": "frontal-view", "view": "front", "imageRegion": {"x": 0.67, "y": 0.5, "width": 0.33, "height": 0.5, "units": "normalized"}, "observations": ["bilateral track spacing and frontal armor"], "confidence": 0.88},
]

spec["preSpecAssessment"]["objectClass"] = {
    "primaryType": "futuristic main battle tank",
    "primaryDomain": "object",
    "formLanguage": ["hard-surface", "mechanical", "faceted-geometric"],
    "structureKind": ["compound object", "layered shell", "repeated modules", "articulated assembly"],
    "motionPotential": ["whole-object transform", "turret rotation", "barrel elevation", "detachable components", "destructible assembly"],
    "materialFamilies": ["painted metal/composite", "dark gunmetal", "rubber-like track pads", "smoked glass"],
    "notes": "Visible contact-sheet views support an assembled, action-ready hard-surface vehicle; hidden internals are conditional approximations.",
}
spec["preSpecAssessment"]["complexity"] = {
    "tier": "complex",
    "scores": {"silhouetteComplexity": 3, "componentCount": 3, "hierarchyDepth": 3, "repetitionDensity": 3, "materialLayerCount": 2, "localDetailDensity": 3, "occlusionRisk": 2, "actionReadinessNeed": 3},
    "estimatedCounts": {"macroComponents": 3, "mesoComponents": 8, "microFeatureGroups": 5, "materialLayers": 3, "repetitionSystems": 3},
    "reasoning": ["The reference shows multiple independently articulated assemblies, repeated track hardware, and dense panel/vent details across five views."],
}
spec["preSpecAssessment"]["specDepthDecision"] = {
    "requiredDepth": "complex",
    "minimumComponentLevels": ["macro", "meso", "micro"],
    "needsRepetitionSystems": True,
    "needsMaterialLocalOverrides": True,
    "needsMultipleReviewViews": True,
    "needsActionReadyHierarchy": True,
    "rationale": "Identity depends on the low hull silhouette, bilateral track cadence, faceted turret, cannon, and repeated armored details.",
}
spec["preSpecAssessment"]["unknownsToResolveBeforeImplementation"] = [
    "Exact underside suspension and internal turret-ring geometry are hidden in the reference.",
    "Rear engine module depth is inferred from the rear and top views.",
]

details = [
    ("turret-bevel", "bevel", "turret_shell", "faceted chamfered turret silhouette", "front-three-quarter", 0.92),
    ("front-panel-seam", "seam", "hull_glacis", "recessed angular glacis seams", "front-three-quarter", 0.9),
    ("wheel-cadence", "fastener", "road_wheels", "six road-wheel stations per side", "side-view", 0.95),
    ("track-tread-blocks", "ridge", "track_links", "repeating raised tread blocks around both loops", "side-view", 0.94),
    ("turret-canister-gloss", "gloss", "canister_override", "lower-roughness cylindrical side canisters", "front-three-quarter", 0.82),
    ("roof-vent-linework", "linework", "deck_vents", "dark parallel vent slots on deck and rear", "top-view", 0.88),
    ("rear-access-seam", "seam", "engine_deck", "rectangular rear access plate boundaries", "rear-three-quarter", 0.86),
    ("barrel-rings", "ridge", "main_barrel", "stepped barrel collars and widened muzzle", "front-three-quarter", 0.95),
    ("suspension-rods", "tube", "suspension_rods", "paired exposed actuator/suspension rods", "front-three-quarter", 0.88),
    ("sensor-housings", "ridge", "sensor_cluster", "raised roof sensor and hatch housings", "top-view", 0.84),
    ("track-metal-edge-wear", "scratch", "gunmetal_wear", "subtle lighter edge wear on track hardware", "side-view", 0.72),
    ("rear-port-darkness", "stain", "armor_dirt", "cavity-darkened rear ports and panel joints", "rear-three-quarter", 0.78),
]
spec["preSpecAssessment"]["detailInventory"] = {
    "scanMethod": "grid-3x3",
    "targetMinDetails": 10,
    "note": "Identity-defining details are mapped to component localFeatures or material localOverrides.",
    "details": [
        {"id": did, "region": {"x": 0, "y": 0, "width": 1, "height": 1, "units": "normalized"}, "kind": kind, "affects": affects, "scale": "meso", "evidenceRef": ev, "confidence": conf, "mapsTo": {"ref": maps}}
        for did, kind, maps, affects, ev, conf in details
    ],
}

spec["featureReviewTargets"] = [
    {"id": "hull-silhouette", "name": "Low wedge hull and track stance", "tier": "critical", "passIds": ["blockout", "form-refinement"], "minimumScore": 0.8, "mustPass": True, "componentRefs": ["hull_shell", "track_left", "track_right"], "evidenceRefs": ["front-three-quarter", "side-view", "frontal-view"]},
    {"id": "turret-cannon-system", "name": "Faceted rotating turret with long stepped cannon", "tier": "critical", "passIds": ["structural-pass", "form-refinement", "interaction-pass"], "minimumScore": 0.8, "mustPass": True, "componentRefs": ["turret_shell", "main_barrel"], "evidenceRefs": ["front-three-quarter", "side-view", "frontal-view"]},
    {"id": "track-repetition", "name": "Bilateral track loops and six-wheel cadence", "tier": "critical", "passIds": ["structural-pass", "form-refinement"], "minimumScore": 0.78, "mustPass": True, "componentRefs": ["track_left", "track_right", "road_wheels", "track_links"], "evidenceRefs": ["side-view", "frontal-view"]},
    {"id": "olive-painted-metal-look", "name": "Olive painted armor with dark gunmetal hardware", "tier": "important", "passIds": ["material-pass", "surface-pass", "lighting-pass"], "minimumScore": 0.74, "mustPass": True, "componentRefs": ["hull_shell", "turret_shell", "track_links"], "evidenceRefs": ["full-object", "front-three-quarter", "rear-three-quarter"]},
]

spec["qualityContract"]["definitionOfDone"] = [
    "The model reads as the supplied futuristic tank from front, rear, side, top, and orbit views.",
    "Hull, turret, barrel, tracks, wheels, vents, canisters, and suspension are independent named pivots.",
    "Explode mode separates the major assemblies while preserving readable parent-child spacing and attachment metadata.",
    "Olive satin painted armor, dark gunmetal track hardware, and cool glass accents remain readable under turntable lighting.",
]
spec["qualityContract"]["featureGroups"] = [
    {"id": "silhouette", "name": "Hull, track, and turret silhouette", "required": True, "qualityCriteria": ["Low elongated hull, wedge glacis, bilateral tracks, and turret proportions match the visible reference views."], "evidenceRefs": ["front-three-quarter", "side-view", "frontal-view"], "failureModes": ["generic box tank", "tracks merge into hull", "turret too tall or too small"]},
    {"id": "mechanical-hierarchy", "name": "Mechanical component hierarchy", "required": True, "qualityCriteria": ["Turret rotates around a central ring, barrel is rooted in the mantlet, and tracks/wheels form independent child assemblies."], "evidenceRefs": ["front-three-quarter", "top-view"], "failureModes": ["floating barrel", "missing track clearance", "merged articulated parts"]},
    {"id": "surface-material", "name": "Painted armor and gunmetal response", "required": True, "qualityCriteria": ["Olive armor has satin roughness variation, darker cavities, chamfer highlights, and independent gunmetal/glass accents."], "evidenceRefs": ["full-object", "rear-three-quarter"], "failureModes": ["flat plastic", "uniform green", "unreadable dark hardware"]},
]
spec["qualityContract"]["visualDeltaChecks"] = ["hull length/width/height and wedge glacis", "turret footprint and barrel projection", "track loop radius and six-wheel cadence", "vent/canister/suspension placement", "olive/gunmetal/glass material separation"]

def rgba(hex_color: str) -> str:
    value = hex_color.lstrip("#")
    r, g, b = int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
    return f"rgba({r}, {g}, {b}, 1.0)"


def action(role: str, axis=(0, 1, 0), detachable=False):
    return {
        "animationRole": role,
        "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": list(axis), "confidence": 0.86},
        "transformChannels": {"translate": True, "rotate": True, "scale": True, "bend": False, "twist": False, "detach": detachable, "visibility": True, "materialState": True},
        "sockets": [],
        "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": False},
        "constraints": [],
        "destruction": {"breakable": detachable, "fractureGroup": role, "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0 if detachable else 0.0, "debrisMaterial": "dark-metal"},
    }


def recipe(material_class: str, primary: str, secondary: str):
    return {"dominantAlbedo": rgba(primary), "secondaryAlbedo": rgba(secondary), "materialClass": material_class, "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": rgba(primary)}, {"position": 1, "color": rgba(secondary)}]}}


def comp(cid, name, level, primitive, material, dims, parent=None, role="panel", features=None, topology="assembled-solid", position=(0, 0, 0), detachable=False, evidence=None):
    evidence = evidence or ["full-object"]
    node = {
        "id": cid, "name": name, "level": level, "role": role, "importance": 0.9 if level == "macro" else 0.72, "confidence": 0.86,
        "primitive": primitive, "topologyClass": topology,
        "topologyRationale": f"Visible {name.lower()} has discrete hard faces and a bounded rigid volume in the reference views.",
        "geometryDescriptor": {"topologyIntent": "low-poly hard-surface assembly with chamfered edges", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.06 if level == "macro" else 0.025, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "weighted vertex normals"},
        "parent": parent, "attachment": None, "dimensions": {"width": dims[0], "height": dims[1], "depth": dims[2], "units": "meters", "confidence": 0.84}, "transform": {"position": list(position), "rotation": [0, 0, 0], "scale": [1, 1, 1]},
        "actionProfile": action(role, detachable=detachable), "material": material, "materialLayers": [material], "deformations": [], "joints": [], "seams": [], "localFeatures": features or [],
        "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.18, "bumpAmplitude": 0.08, "normalPattern": "procedural panel and edge breakup", "displacementPattern": "none", "occlusionPattern": "cavity-darkened seams", "edgeWearPattern": "sparse exposed-edge lift", "notes": "Geometry carries silhouette-critical relief; material carries micro variation."},
        "colorMaterialRecipe": recipe("metal" if material != "glass" else "glass", "#667952" if material == "armor" else ("#24272A" if material == "dark-metal" else "#5F737A"), "#34402B" if material == "armor" else ("#101214" if material == "dark-metal" else "#1A2429")),
        "evidenceRefs": evidence, "details": [], "fidelityTier": "form-refinement",
    }
    if parent:
        node["attachment"] = {"parentId": parent, "parentSocket": f"{parent}-socket", "localStart": [0, 0, 0], "localEnd": [0, 0, dims[2] * 0.45], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.012, "evidenceRefs": evidence}
    return node


components = [
    comp("hull_shell", "Hull shell", "macro", "box", "armor", (8.4, 1.8, 4.8), role="body", features=["hull-bevel", "front-panel-seam", "engine-deck"], evidence=["front-three-quarter", "side-view", "top-view"]),
    comp("track_left", "Left track assembly", "macro", "instanced-cluster", "dark-metal", (8.8, 1.45, 0.82), parent="hull_shell", role="track", features=["track-loop-left"], topology="assembled-solid", position=(-2.65, -0.62, 0), detachable=True, evidence=["side-view", "frontal-view"]),
    comp("track_right", "Right track assembly", "macro", "instanced-cluster", "dark-metal", (8.8, 1.45, 0.82), parent="hull_shell", role="track", features=["track-loop-right"], topology="assembled-solid", position=(2.65, -0.62, 0), detachable=True, evidence=["side-view", "frontal-view"]),
    comp("turret_shell", "Rotating turret shell", "meso", "extrude", "armor", (4.2, 1.25, 3.5), parent="hull_shell", role="turret", features=["turret-bevel", "turret-ring", "sensor-cluster"], position=(0, 1.48, -0.18), detachable=True, evidence=["front-three-quarter", "top-view", "frontal-view"]),
    comp("main_barrel", "Main stepped barrel", "meso", "cylinder", "dark-metal", (0.36, 0.36, 6.6), parent="turret_shell", role="barrel", features=["barrel-rings", "muzzle-bore"], position=(0, 1.43, -4.2), detachable=True, evidence=["front-three-quarter", "side-view", "frontal-view"]),
    comp("hull_glacis", "Wedge glacis armor", "meso", "extrude", "armor", (4.6, 0.78, 3.8), parent="hull_shell", role="panel", features=["front-panel-seam", "glacis-ridge"], position=(0, 0.38, -2.6), evidence=["front-three-quarter", "frontal-view"]),
    comp("engine_deck", "Rear engine deck", "meso", "box", "armor", (4.5, 0.58, 2.1), parent="hull_shell", role="panel", features=["rear-access-seam", "deck-vents"], position=(0, 1.12, 2.25), evidence=["rear-three-quarter", "top-view"]),
    comp("side_skirts", "Side skirt armor", "meso", "box", "armor", (7.6, 0.72, 0.38), parent="hull_shell", role="panel", features=["skirt-seams", "skirt-fasteners"], position=(0, 0.1, -2.37), evidence=["side-view"]),
    comp("mantlet", "Gun mantlet", "meso", "box", "armor", (1.2, 0.85, 0.8), parent="turret_shell", role="socket", features=["mantlet-seam"], position=(0, 1.28, -1.75), detachable=True, evidence=["front-three-quarter", "frontal-view"]),
    comp("road_wheels", "Road wheel row", "micro", "instanced-cluster", "dark-metal", (7.4, 0.74, 0.66), parent="track_left", role="wheel", features=["wheel-cadence", "wheel-hubs"], position=(-2.65, -0.68, 0), evidence=["side-view"]),
    comp("track_links", "Track link belt", "micro", "instanced-cluster", "dark-metal", (8.6, 0.5, 0.78), parent="track_left", role="link", features=["track-tread-blocks"], position=(-2.65, -1.04, 0), detachable=True, evidence=["side-view"]),
    comp("suspension_rods", "Exposed suspension rods", "micro", "tube", "dark-metal", (4.2, 0.18, 0.18), parent="hull_shell", role="tube", features=["suspension-rods"], position=(0, 0.58, -1.65), evidence=["front-three-quarter", "side-view"]),
    comp("sensor_cluster", "Roof sensor cluster", "micro", "box", "dark-metal", (1.0, 0.45, 0.78), parent="turret_shell", role="sensor", features=["sensor-housings"], position=(0.65, 2.14, 0.1), detachable=True, evidence=["top-view", "front-three-quarter"]),
    comp("deck_vents", "Deck vent fields", "micro", "surface-relief", "dark-metal", (1.6, 0.12, 0.8), parent="engine_deck", role="panel", features=["roof-vent-linework"], position=(0, 1.47, 2.05), evidence=["top-view", "rear-three-quarter"]),
    comp("turret_canisters", "Turret side canister pair", "micro", "cylinder", "dark-metal", (0.32, 0.62, 1.15), parent="turret_shell", role="connector", features=["canister-ports", "canister-gloss"], position=(1.84, 1.68, 0.05), detachable=True, evidence=["front-three-quarter", "rear-three-quarter"]),
]
spec["componentTree"] = components

map_paths = {
    "albedo": ".img2threejs/pbr-evidence/painted-metal_albedo.png",
    "roughness": ".img2threejs/pbr-evidence/painted-metal_roughness.png",
    "height": ".img2threejs/pbr-evidence/painted-metal_height.png",
    "normal": ".img2threejs/pbr-evidence/painted-metal_normal.png",
    "ao": ".img2threejs/pbr-evidence/painted-metal_ao.png",
}


def material(mid, name, color, rough, metalness, overrides, notes):
    return {
        "id": mid, "name": name, "type": "physical", "shaderModel": "MeshPhysicalMaterial / PBR approximation", "qualityTier": "reference-fidelity", "baseColor": color, "color": color,
        "albedo": {"dominant": color, "secondary": ["#4B5B39", "#7C8F64"] if mid == "armor" else ["#15191B", "#596166"]}, "colorVariation": {"palette": [color, "#4B5B39", "#7C8F64"] if mid == "armor" else [color, "#596166"], "pattern": "low-frequency mottled edge variation", "amplitude": 0.12, "heightCorrelation": 0.24},
        "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "stable world/object scale detail"},
        "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.3, "role": "broad panel value breakup"}, {"id": "meso", "frequency": 14, "amplitude": 0.16, "role": "seams, vents, and edge relief"}, {"id": "micro", "frequency": 58, "amplitude": 0.06, "role": "grazing-angle roughness breakup"}],
        "roughness": {"base": rough, "variation": 0.16, "map": f"independent-{mid}-roughness"}, "metalness": {"base": metalness, "variation": 0.05}, "normal": {"pattern": "independent reference-derived height field", "strength": 0.32, "scale": 22, "space": "tangent"}, "bump": {"pattern": "panel-edge micro relief", "amplitude": 0.06, "scale": 18}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": False}, "ambientOcclusion": {"cavityStrength": 0.46, "contactShadowBias": 0.32, "notes": "Darken panel seams, track gaps, and attachment sockets."},
        "wear": {"edgeWear": 0.18, "scratches": ["sparse directional track-edge scratches"], "chips": ["small corner chips on front armor"]}, "dirt": {"amount": 0.22, "cavityBias": 0.7, "color": "#20251C"}, "localOverrides": overrides, "referencePbr": {"version": "1.0", "sourceImage": ".img2threejs/reference.png", "extractor": "extract_pbr_evidence.py", "method": "reference crop evidence plus procedural relightable approximation", "verdict": "usable for stylized realtime material response", "hardLimit": "contact-sheet lighting is not inverse-rendered albedo", "usable": True, "confidence": 0.82, "estimatedFidelity": 0.78, "targetThreshold": 0.7, "maps": map_paths}, "notes": notes,
    }


spec["materials"] = [
    material("armor", "Olive painted armor", "#667952", 0.68, 0.28, [{"id": "armor_dirt", "region": "panel cavities and underside", "dirtAmount": 0.28, "cavityBias": 0.8, "streak": True, "patinaColor": "#34402B", "evidenceRefs": ["rear-three-quarter"]}, {"id": "armor_bevel_wear", "region": "front and turret chamfers", "roughness": 0.46, "colorShift": "#8A9A70", "evidenceRefs": ["front-three-quarter"]}], "Primary painted composite/metal armor."),
    material("dark-metal", "Gunmetal track hardware", "#24272A", 0.46, 0.82, [{"id": "gunmetal_wear", "region": "track crowns and wheel rims", "roughness": 0.31, "colorShift": "#596166", "evidenceRefs": ["side-view"]}], "Dark metallic tracks, hubs, rods, and barrel rings."),
    material("glass", "Smoked sensor glass", "#5F737A", 0.22, 0.18, [{"id": "sensor_gloss", "region": "vision blocks and sensor faces", "roughness": 0.12, "clearcoat": 0.42, "evidenceRefs": ["front-three-quarter", "top-view"]}], "Cool smoked glass/optical surfaces."),
]

spec["repetitionSystems"] = [
    {"id": "track-links", "name": "Bilateral track link belts", "parentRefs": ["track_left", "track_right"], "realization": "instanced-geometry", "buildsGeometry": True, "geometry": {"primitive": "box", "countPerSide": 42, "spacing": 0.2, "loopPath": "rounded-rectangle around six-wheel road row", "variation": "small yaw/roughness jitter"}, "material": "dark-metal", "distribution": "mirrored bilateral loops", "evidenceRefs": ["side-view"]},
    {"id": "road-wheels", "name": "Six road wheels per side", "parentRefs": ["track_left", "track_right"], "realization": "instanced-geometry", "buildsGeometry": True, "geometry": {"primitive": "cylinder", "countPerSide": 6, "spacing": 1.18, "radius": 0.48, "axis": "X"}, "material": "dark-metal", "distribution": "longitudinal axle row", "evidenceRefs": ["side-view"]},
    {"id": "panel-fasteners", "name": "Armor fastener clusters", "parentRefs": ["hull_shell", "side_skirts", "engine_deck"], "realization": "instanced-geometry", "buildsGeometry": True, "geometry": {"primitive": "cylinder", "count": 28, "spacing": 0.44, "radius": 0.045, "axis": "Y"}, "material": "dark-metal", "distribution": "edge and seam rows", "evidenceRefs": ["rear-three-quarter", "side-view"]},
]

spec["lightingFromPhoto"] = [
    "Key: large soft neutral source from upper front-left, 3.2 intensity, grazing across armor chamfers.",
    "Fill: cool low-level environment from camera-right, 0.7 intensity, preserves dark track cavities.",
    "Rim: narrow cool back light from upper rear, 2.0 intensity, separates turret and engine deck silhouette.",
    "Exposure 1.05 with ACES filmic tone mapping and restrained contrast.",
    "Contact shadow: soft ground shadow and ambient occlusion inside track loops, under skirts, and at turret ring.",
]
spec["lookDevTargets"] = {
    "qualityPriority": "reference-fidelity",
    "materialPass": {"minimumTextureResolution": 1024, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "referencePbrExtraction": {"requiredWhenSourceImagePresent": True, "targetThreshold": 0.7}},
    "neutralLight": "readable under neutral turntable light",
    "grazingLight": "bevels and panel relief must break highlights",
    "referenceLight": "olive armor and dark hardware separation preserved",
}

spec["qualityTargets"] = {"targetFidelity": 0.78, "mustMatch": ["hull silhouette", "track cadence", "turret/barrel placement", "olive/gunmetal palette", "explode hierarchy"], "niceToHave": ["rear vent density", "small sensor housing asymmetry"], "reviewViewpoints": ["front-three-quarter", "rear-three-quarter", "side-view", "top-view", "frontal-view"]}
spec["proceduralStrategy"] = ["Block out hull, turret, barrel, and tracks as independent pivots.", "Use instanced rounded track links and six-wheel road rows for repeated hardware.", "Use extruded wedge profiles and chamfers for armor silhouette; use tubes/cylinders for suspension and barrel.", "Use independent albedo, roughness, height, normal, and AO evidence maps plus procedural local overrides.", "Keep all macro and meso groups explodable and clickable through stable semantic names."]
spec["risks"] = ["Single contact sheet leaves underside and internal turret-ring geometry approximate.", "Image lighting is baked into reference views; material maps are evidence-guided, not inverse-rendered albedo."]

spec_path.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"enriched {spec_path}")

