import json
from pathlib import Path

path = Path("object-sculpt-spec.json")
spec = json.loads(path.read_text(encoding="utf-8"))
for component in spec.get("componentTree", []):
    if component.get("id") == "deck_vents":
        component["primitive"] = "box"
        component["topologyClass"] = "surface-relief"
        component["topologyRationale"] = "The vent field is a shallow raised/recessed panel relief on the engine deck, not a free-standing volume."
path.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("fixed deck vent topology")
