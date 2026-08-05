from pathlib import Path
from PIL import Image

reference = Image.open(".img2threejs/reference.png").convert("RGB")
reference.crop((0, 0, 512, 512)).save("output/playwright/reference-front34.png")
Image.open("output/playwright/mbt-canvas.jpg").convert("RGB").save("output/playwright/mbt-canvas.png")
print("prepared aligned reference/render pair")
