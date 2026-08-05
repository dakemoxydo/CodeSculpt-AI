from pathlib import Path


SOURCE = Path('src/generatedModel.ts')


def replace_function_body(source: str, function_name: str, replacement_body: str) -> str:
    marker = f'function {function_name}'
    start = source.index(marker)
    body_start = source.index('{', start)
    depth = 0
    body_end = None
    for index in range(body_start, len(source)):
        if source[index] == '{':
            depth += 1
        elif source[index] == '}':
            depth -= 1
            if depth == 0:
                body_end = index + 1
                break
    if body_end is None:
        raise RuntimeError(f'Could not find end of {function_name}')
    return source[:body_start] + replacement_body + source[body_end:]


text = SOURCE.read_text(encoding='utf-8')
replacement = """{
  // The current reference is a five-view contact sheet. Its extracted maps are
  // evidence artifacts, not a clean UV material crop; importing them directly
  // would tile miniature tanks across the model. Keep the evidence in the spec
  // and use the factory's procedural PBR fallback for runtime look-dev.
  return null;
}"""
patched = replace_function_body(text, 'makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null', replacement)
SOURCE.write_text(patched, encoding='utf-8')
print('Patched generated factory to use procedural runtime materials for contact-sheet evidence maps.')
