from pathlib import Path

path = Path('src/createObjectModelV2.ts')
text = path.read_text(encoding='utf-8')
old = "    const shell = addMesh(skirt, prism(profile, 0.28, 0.045), materials.armorDark, 'faceted-skirt-panel', meshes);\n    shell.rotation.y = Math.PI / 2;\n    shell.position.x = side * 2.25;\n    shell.position.y = 0.0;\n"
new = "    for (let segment = 0; segment < 5; segment += 1) {\n      const z = -2.7 + segment * 1.35;\n      panel(skirt, side * 2.28, 0.4, z, 0.3, 0.34, 1.04, materials.armorDark, 'segmented-side-skirt');\n    }\n"
if old not in text:
    raise SystemExit('side shell block not found')
text = text.replace(old, new)
text = text.replace("panel(skirt, side * 2.39, -0.23, z, 0.07, 0.42, 0.46, materials.armor, 'skirt-brace');", "panel(skirt, side * 2.39, 0.34, z, 0.07, 0.42, 0.46, materials.armor, 'skirt-brace');")
path.write_text(text, encoding='utf-8')
