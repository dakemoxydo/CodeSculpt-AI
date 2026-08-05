from pathlib import Path

path = Path('src/createObjectModelV2.ts')
text = path.read_text(encoding='utf-8')
text = text.replace("    const profile = [[-3.42, 0.2], [-2.88, 0.18], [-1.55, 0.16], [1.74, 0.18], [3.42, 0.22], [3.42, 0.56], [-3.42, 0.56]] as Array<[number, number]>;\n", "")
path.write_text(text, encoding='utf-8')
