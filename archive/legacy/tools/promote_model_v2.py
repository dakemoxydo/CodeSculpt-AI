from pathlib import Path

source = Path('src/createObjectModelV2.ts')
target = Path('src/createObjectModel.ts')
target.write_text(source.read_text(encoding='utf-8'), encoding='utf-8')
main = Path('src/main.ts')
text = main.read_text(encoding='utf-8').replace("from './createObjectModelV2'", "from './createObjectModel'")
main.write_text(text, encoding='utf-8')
