from PIL import Image

reference = Image.open(".img2threejs/reference.png").convert("RGB")
full = Image.open("output/playwright/mbt-default.jpg").convert("RGB")
canvas = full.crop((0, 64, 935, 806))
canvas.save("output/playwright/mbt-canvas.png")
reference.save("output/playwright/reference-front34-full.png")
print("prepared full front-3/4 reference and canvas-only render")
