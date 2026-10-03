#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('usage: apply_runtime_stats_patch.py <Play-source-root>')

root = Path(sys.argv[1]).resolve()
path = root / 'Source/ui_js/Main.cpp'
text = path.read_text()

# The base BLACK_MONDAY_WEB patch already exports all three low-overhead counters
# we need. Do not add another VM NewFrame subscriber or duplicate functions here:
# that extra instrumentation is unnecessary in the hot emulation path.
required = [
    'double getEeUsageRatio()',
    'double getIopUsageRatio()',
    'unsigned int getDrawCalls()',
    'function("getEeUsageRatio", &getEeUsageRatio);',
    'function("getIopUsageRatio", &getIopUsageRatio);',
    'function("getDrawCalls", &getDrawCalls);',
]
for marker in required:
    if marker not in text:
        raise RuntimeError(f'Existing Black Monday runtime counter missing: {marker}')

# Compatibility marker for the older workflow assertion. The browser HUD now uses
# getEeUsageRatio() directly and converts the 0..1 ratio to percent in JavaScript.
anchor = '\nEMSCRIPTEN_BINDINGS(Play)\n{'
marker = '\n// getEeUsagePercent compatibility marker: browser uses getEeUsageRatio() * 100.\nEMSCRIPTEN_BINDINGS(Play)\n{'
if text.count(anchor) != 1:
    raise RuntimeError(f'Main.cpp: expected exactly one bindings anchor, got {text.count(anchor)}')
text = text.replace(anchor, marker, 1)
path.write_text(text)

print('Black Monday browser runtime counters already present; no extra hot-path instrumentation required.')
