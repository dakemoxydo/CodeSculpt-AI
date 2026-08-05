from __future__ import annotations

import copy
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC_PATH = ROOT / "object-sculpt-spec.json"
ASSESSMENT_PATH = ROOT / ".img2threejs" / "assessment.json"
PARTS_PATH = ROOT / "parts.json"


def relative_project_path(value: str) -> str:
    normalized = value.replace("\\", "/")
    root = ROOT.as_posix().rstrip("/")
    if normalized.lower().startswith(root.lower() + "/"):
        return normalized[len(root) + 1 :]
    return normalized


def normalize_paths(value):
    if isinstance(value, str):
        return relative_project_path(value)
    if isinstance(value, list):
        return [normalize_paths(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize_paths(item) for key, item in value.items()}
    return value


def component_from_template(template: dict, component_id: str, name: str, role: str, position: list[float], evidence: list[str]) -> dict:
    component = copy.deepcopy(template)
    component.update(
        {
            "id": component_id,
            "name": name,
            "level": "meso",
            "role": role,
            "importance": 0.68,
            "confidence": 0.74,
            "primitive": "box",
            "topologyClass": "assembled-solid",
            "topologyRationale": f"The visible {name.lower()} is a separate shallow rigid armor module attached to the hull.",
            "parent": "hull_shell",
            "dimensions": {"width": 1.1, "height": 0.62, "depth": 1.1, "units": "meters", "confidence": 0.74},
            "transform": {"position": position, "rotation": [0, 0, 0], "scale": [1, 1, 1]},
            "localFeatures": [f"{component_id}-seam", f"{component_id}-chamfer"],
            "evidenceRefs": evidence,
            "fidelityTier": "structural-pass",
        }
    )
    component["attachment"] = {
        "parentId": "hull_shell",
        "parentSocket": "hull_shell-socket",
        "localStart": [0, 0, 0],
        "localEnd": [0, 0, 0.22],
        "contactType": "overlap",
        "embedDepth": 0.04,
        "gapTolerance": 0.012,
        "evidenceRefs": evidence,
    }
    component["actionProfile"] = {
        "animationRole": role,
        "pivot": {"mode": "semantic-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.74},
        "transformChannels": {"translate": True, "rotate": True, "scale": True, "bend": False, "twist": False, "detach": True, "visibility": True, "materialState": True},
        "sockets": [],
        "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": False},
        "constraints": [],
        "destruction": {"breakable": True, "fractureGroup": component_id, "seamRefs": [], "detachableFragments": [], "breakImpulse": 4.0, "debrisMaterial": "dark-metal"},
    }
    return component


def main() -> None:
    spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    components = spec.setdefault("componentTree", [])
    by_id = {component.get("id"): component for component in components}
    template = by_id.get("hull_shell") or components[0]
    additions = [
        ("front_track_fenders", "Front track fender blocks", "fender", [-3.35, 0.18, -1.95], ["front-three-quarter", "frontal-view"]),
        ("rear_engine_armor", "Rear engine armor blocks", "armor-block", [3.15, 0.24, 1.95], ["rear-three-quarter", "top-view"]),
    ]
    for component_id, name, role, position, evidence in additions:
        if component_id not in by_id:
            component = component_from_template(template, component_id, name, role, position, evidence)
            components.append(component)
            by_id[component_id] = component

    details = spec.setdefault("preSpecAssessment", {}).setdefault("detailInventory", {}).setdefault("details", [])
    for detail in details:
        if detail.get("id") == "turret-canister-gloss":
            detail["mapsTo"] = {"ref": "turret_canisters"}
            canisters = by_id.get("turret_canisters")
            if canisters is not None and "canister-gloss" not in canisters.setdefault("localFeatures", []):
                canisters["localFeatures"].append("canister-gloss")

    spec["sourceImage"] = ".img2threejs/reference.png"
    spec["reviewHistory"] = []
    spec["visualEvidence"] = []
    spec["tier1Results"] = []
    spec["currentPass"] = "blockout"
    spec["assumptions"] = [
        "Stylized realtime approximation based on a five-view contact sheet.",
        "Hidden underside, internal suspension, and turret-ring geometry are inferred and remain explicitly approximate.",
        "Projection is intentionally skipped because the contact sheet is not a clean single-surface material crop; procedural relightable PBR maps are used instead.",
    ]
    spec = normalize_paths(spec)
    SPEC_PATH.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    assessment = {
        "targetName": spec["targetName"],
        "sourceImage": spec["sourceImage"],
        "preSpecAssessment": spec["preSpecAssessment"],
        "qualityContract": spec["qualityContract"],
        "localSpecSearch": spec.get("localSpecSearch", {}),
        "authoringInstruction": spec.get("authoringInstruction", ""),
    }
    ASSESSMENT_PATH.write_text(json.dumps(assessment, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    parts = json.loads(PARTS_PATH.read_text(encoding="utf-8"))
    existing = {part.get("name"): part for part in parts.get("parts", [])}
    defaults = {
        "front_track_fenders": ("armor", 450),
        "rear_engine_armor": ("armor", 340),
    }
    for component_id, (module, triangles) in defaults.items():
        if component_id not in existing:
            parts.setdefault("parts", []).append({"name": component_id, "kind": "part", "module": module, "triangles": triangles})
    parts["specifiedComponents"] = len(components)
    PARTS_PATH.write_text(json.dumps(parts, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"synced {len(components)} components, {len(details)} details, and relative asset paths")


if __name__ == "__main__":
    main()
