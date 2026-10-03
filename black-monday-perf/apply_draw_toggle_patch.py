#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('usage: apply_draw_toggle_patch.py <Play-source-root>')

root = Path(sys.argv[1]).resolve()
main = root / 'Source/ui_js/Main.cpp'
text = main.read_text()

# r38 deliberately avoids touching the OpenGL renderer implementation. Play!
# already has CGSHandler::SetDrawEnabled(), which suppresses primitive drawing
# kicks while leaving transfers, flip/presentation, mailbox work and GS sync
# intact. Expose only that existing switch to the browser for one controlled A/B
# benchmark.
function_anchor = 'double getBlackMondayGsWorkerCalls() { return static_cast<double>(BlackMonday_GetGsWorkerCalls()); }\n'
if text.count(function_anchor) != 1:
    raise RuntimeError('Main.cpp: r35 GS worker getter anchor missing')
function_insert = function_anchor + '''\nvoid setBlackMondayGsDrawEnabled(bool enabled)\n{\n\tif(!g_virtualMachine) return;\n\tauto gs = g_virtualMachine->GetGSHandler();\n\tif(gs) gs->SetDrawEnabled(enabled);\n}\n\nbool getBlackMondayGsDrawEnabled()\n{\n\tif(!g_virtualMachine) return true;\n\tauto gs = g_virtualMachine->GetGSHandler();\n\treturn gs ? gs->GetDrawEnabled() : true;\n}\n'''
text = text.replace(function_anchor, function_insert, 1)

binding_anchor = '\tfunction("getBlackMondayGsWorkerCalls", &getBlackMondayGsWorkerCalls);\n'
if text.count(binding_anchor) != 1:
    raise RuntimeError('Main.cpp: r35 GS worker binding anchor missing')
binding_insert = binding_anchor + '''\tfunction("setBlackMondayGsDrawEnabled", &setBlackMondayGsDrawEnabled);\n\tfunction("getBlackMondayGsDrawEnabled", &getBlackMondayGsDrawEnabled);\n'''
text = text.replace(binding_anchor, binding_insert, 1)
main.write_text(text)

print('Black Monday r38 existing GS draw toggle exposed successfully.')
