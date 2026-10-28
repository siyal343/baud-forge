import pathlib

B = chr(92)
p = pathlib.Path("crates/bforge-core/tests/serve.rs")
text = p.read_text(encoding="utf-8")
target = "        .replace(/" + B * 4 + '/g, "/");'
replacement = "        .replace('" + B * 2 + "', \"/\");"
assert target in text, repr(target)
p.write_text(text.replace(target, replacement), encoding="utf-8")
print(repr(replacement))
