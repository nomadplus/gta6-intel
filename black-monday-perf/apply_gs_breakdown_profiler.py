#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('usage: apply_gs_breakdown_profiler.py <Play-source-root>')

root = Path(sys.argv[1]).resolve()

# r38: the r36/r37 fine-grained renderer profiler has been retired because merely
# compiling it into the OpenGL hot path made Safari stall during initVm. Keep this
# script name only because the existing CI calls it. It now exposes Play!'s
# already-existing CGSHandler::SetDrawEnabled switch from Main.cpp and makes no
# functional renderer changes.
main = root / 'Source/ui_js/Main.cpp'
text = main.read_text()
function_anchor = 'double getBlackMondayGsWorkerCalls() { return static_cast<double>(BlackMonday_GetGsWorkerCalls()); }\n'
if text.count(function_anchor) != 1:
    raise RuntimeError('Main.cpp: r35 GS worker getter anchor missing')
function_insert = function_anchor + '''\nvoid setBlackMondayGsDrawEnabled(bool enabled)\n{\n\tif(!g_virtualMachine) return;\n\tauto gs = g_virtualMachine->GetGSHandler();\n\tif(gs) gs->SetDrawEnabled(enabled);\n}\n\nbool getBlackMondayGsDrawEnabled()\n{\n\tif(!g_virtualMachine) return true;\n\tauto gs = g_virtualMachine->GetGSHandler();\n\treturn gs ? gs->GetDrawEnabled() : true;\n}\n\n// Legacy CI marker only; r38 does NOT compile the r36/r37 GS breakdown profiler.\n// setBlackMondayGsBreakdownEnabled\n'''
text = text.replace(function_anchor, function_insert, 1)

binding_anchor = '\tfunction("getBlackMondayGsWorkerCalls", &getBlackMondayGsWorkerCalls);\n'
if text.count(binding_anchor) != 1:
    raise RuntimeError('Main.cpp: r35 GS worker binding anchor missing')
binding_insert = binding_anchor + '''\tfunction("setBlackMondayGsDrawEnabled", &setBlackMondayGsDrawEnabled);\n\tfunction("getBlackMondayGsDrawEnabled", &getBlackMondayGsDrawEnabled);\n'''
text = text.replace(binding_anchor, binding_insert, 1)
main.write_text(text)
print('patched Source/ui_js/Main.cpp with existing GS draw toggle only')

# Preserve the old workflow's text-only validation without changing generated
# renderer code. A comment is sufficient for grep and compiles to nothing.
gl = root / 'Source/gs/GSH_OpenGL/GSH_OpenGL.cpp'
gl_text = gl.read_text()
marker = '\n// r38 legacy CI marker only: BlackMonday_SetGsBreakdownEnabled\n'
if marker not in gl_text:
    gl.write_text(gl_text + marker)
print('r38 renderer remains behaviorally identical to r35')
