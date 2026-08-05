from pathlib import Path

path = Path("src/main.ts")
text = path.read_text(encoding="utf-8")
text = text.replace("new RoomEnvironment(renderer)", "new RoomEnvironment()")
path.write_text(text, encoding="utf-8")
print("fixed RoomEnvironment typing")
