from pathlib import Path

path = Path("src/main.ts")
text = path.read_text(encoding="utf-8").replace("10.8, 7.4, -12.6", "-10.8, 7.4, -12.6")
path.write_text(text, encoding="utf-8")
print("flipped default camera to reference-facing side")
