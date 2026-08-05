from pathlib import Path
from PIL import Image

for source in Path("output/playwright").glob("mbt-*.jpg"):
    target = source.with_suffix(".png")
    Image.open(source).convert("RGB").save(target, format="PNG")
    print(target)
