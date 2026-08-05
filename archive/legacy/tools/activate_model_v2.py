from pathlib import Path

path = Path('src/main.ts')
text = path.read_text(encoding='utf-8')
text = text.replace("from './createObjectModel'", "from './createObjectModelV2'")
text = text.replace('camera.position.set(10.8, 7.4, -12.6)', 'camera.position.set(-10.8, 7.4, -12.6)')
text = text.replace('position.x + 10.8', 'position.x - 10.8')
text = text.replace('position.z + 12.6', 'position.z + 12.6')
path.write_text(text, encoding='utf-8')
