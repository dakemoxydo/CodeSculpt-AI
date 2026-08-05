from pathlib import Path

path = Path('src/createObjectModelV2.ts')
text = path.read_text(encoding='utf-8')
old = "addMesh(hull, roundedBox(7.35, 1.28, 4.15, 0.18), materials.armor, 'lower-hull-shell', meshes);"
new = "addMesh(hull, roundedBox(4.15, 1.28, 7.35, 0.18), materials.armor, 'lower-hull-shell', meshes);"
if old not in text:
    raise SystemExit('hull geometry line not found')
path.write_text(text.replace(old, new), encoding='utf-8')
