from pathlib import Path

path = Path('src/createObjectModelV2.ts')
text = path.read_text(encoding='utf-8')
text = text.replace("const profile = [[-3.42, -0.12], [-2.88, -0.42], [-1.55, -0.46], [1.74, -0.42], [3.42, -0.1], [3.42, 0.28], [-3.42, 0.28]] as Array<[number, number]>;", "const profile = [[-3.42, 0.02], [-2.88, -0.02], [-1.55, -0.04], [1.74, -0.02], [3.42, 0.05], [3.42, 0.28], [-3.42, 0.28]] as Array<[number, number]>;")
text = text.replace("    panel(trackLinks, 0, 0.02, 0, 0.35, 1.52, 7.08, materials.rubber, 'rubber-track-sidewall');\n", "")
path.write_text(text, encoding='utf-8')
