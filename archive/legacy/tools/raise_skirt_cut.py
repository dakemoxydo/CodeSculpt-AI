from pathlib import Path

path = Path('src/createObjectModelV2.ts')
text = path.read_text(encoding='utf-8')
old = "const profile = [[-3.42, -0.36], [-2.88, -0.76], [-1.55, -0.82], [1.74, -0.74], [3.42, -0.28], [3.42, 0.26], [-3.42, 0.26]] as Array<[number, number]>;"
new = "const profile = [[-3.42, -0.12], [-2.88, -0.42], [-1.55, -0.46], [1.74, -0.42], [3.42, -0.1], [3.42, 0.28], [-3.42, 0.28]] as Array<[number, number]>;"
if old not in text:
    raise SystemExit('skirt profile not found')
path.write_text(text.replace(old, new), encoding='utf-8')
