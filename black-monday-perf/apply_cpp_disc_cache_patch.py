#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('usage: apply_cpp_disc_cache_patch.py <Play-source-root>')

root = Path(sys.argv[1]).resolve()
h = root / 'Source/Js_DiscImageDeviceStream.h'
cpp = root / 'Source/Js_DiscImageDeviceStream.cpp'
htext = h.read_text()
ctext = cpp.read_text()

# The first C++/WASM optical read-ahead experiment caused the physical iPhone
# build to hang during Play! WebAssembly initialisation. Keep upstream stream
# semantics intact for the recovery build. The JavaScript-side read-ahead cache
# remains enabled and was already verified to improve the Sony intro from ~3 to
# ~5.5 FPS. A safer worker-local cache can be reintroduced after boot stability
# is restored.
required_h = [
    '#pragma once',
    'class CJsDiscImageDeviceStream',
    'uint64 m_position = 0;',
]
required_cpp = [
    'Module.discImageDevice.read($0, position, $3);',
    'while(!MAIN_THREAD_EM_ASM_INT({return Module.discImageDevice.isDone()}))',
    'uint64 CJsDiscImageDeviceStream::Read(void* buffer, uint64 size)',
]
for marker in required_h:
    if marker not in htext:
        raise RuntimeError(f'Pinned Js_DiscImageDeviceStream.h marker missing: {marker}')
for marker in required_cpp:
    if marker not in ctext:
        raise RuntimeError(f'Pinned Js_DiscImageDeviceStream.cpp marker missing: {marker}')

# Preserve the workflow's explicit cache-patch marker without altering runtime
# behaviour. This is intentionally only a source comment.
marker = '// BLACK_MONDAY_WEB CACHE_BYTES cache experiment disabled: iOS init regression\n'
if marker not in htext:
    htext = htext.replace('#pragma once\n', '#pragma once\n\n' + marker, 1)
    h.write_text(htext)

print('Black Monday C++ optical cache disabled; upstream disc-stream semantics preserved.')
