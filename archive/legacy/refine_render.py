from pathlib import Path

model = Path("src/createObjectModel.ts")
text = model.read_text(encoding="utf-8")
replacements = {
    "color('#657b4f')": "color('#536544')",
    "color('#7f9563')": "color('#71835b')",
    "color('#3b4a30')": "color('#2d3927')",
    "color('#252b2d')": "color('#1e2527')",
    "color('#515a59')": "color('#46504e')",
    "[-2.52, 0.61, 0]": "[-2.68, 0.48, 0]",
    "[2.52, 0.61, 0]": "[2.68, 0.48, 0]",
    "roundedBox(7.7, 0.66, 0.32, 0.08)": "roundedBox(7.7, 0.5, 0.32, 0.08)",
}
for before, after in replacements.items():
    text = text.replace(before, after)
model.write_text(text, encoding="utf-8")

main = Path("src/main.ts")
text = main.read_text(encoding="utf-8")
replacements = {
    "camera.position.set(10.8, 7.4, 12.6)": "camera.position.set(10.8, 7.4, -12.6)",
    "camera.position.set(10.8, 7.4, 12.6)": "camera.position.set(10.8, 7.4, -12.6)",
    "new THREE.HemisphereLight('#c7d2bb', '#162019', 1.7)": "new THREE.HemisphereLight('#c7d2bb', '#162019', 1.25)",
    "new THREE.DirectionalLight('#e4f0d5', 3.8)": "new THREE.DirectionalLight('#e4f0d5', 2.7)",
    "new THREE.DirectionalLight('#83a8a2', 2.2)": "new THREE.DirectionalLight('#83a8a2', 1.5)",
    "new THREE.PointLight('#d19c64', 5, 18, 2)": "new THREE.PointLight('#d19c64', 2.8, 18, 2)",
    "renderer.toneMappingExposure = 1.05": "renderer.toneMappingExposure = 0.86",
}
for before, after in replacements.items():
    text = text.replace(before, after)
main.write_text(text, encoding="utf-8")
print("refined camera, palette, and track stance")
