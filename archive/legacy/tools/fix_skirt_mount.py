from pathlib import Path

path = Path('src/createObjectModelV2.ts')
text = path.read_text(encoding='utf-8')
text = text.replace("const sideSkirts = part('side_skirts', 'Faceted side armor skirts', root, [0, 0, 0], [0, -0.06, 0]);", "const sideSkirts = part('side_skirts', 'Faceted side armor skirts', root, [0, 1.08, 0], [0, 0.08, 0]);")
path.write_text(text, encoding='utf-8')
