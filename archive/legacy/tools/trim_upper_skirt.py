from pathlib import Path

path = Path('src/createObjectModelV2.ts')
text = path.read_text(encoding='utf-8')
old = "const profile = [[-3.42, 0.02], [-2.88, -0.02], [-1.55, -0.04], [1.74, -0.02], [3.42, 0.05], [3.42, 0.28], [-3.42, 0.28]] as Array<[number, number]>;"
new = "const profile = [[-3.42, 0.2], [-2.88, 0.18], [-1.55, 0.16], [1.74, 0.18], [3.42, 0.22], [3.42, 0.56], [-3.42, 0.56]] as Array<[number, number]>;"
if old not in text:
    raise SystemExit('upper skirt profile not found')
path.write_text(text.replace(old, new), encoding='utf-8')
