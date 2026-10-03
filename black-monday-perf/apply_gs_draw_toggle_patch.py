#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('usage: apply_gs_draw_toggle_patch.py <Play-source-root>')

root = Path(sys.argv[1]).resolve()
main = root / 'Source/ui_js/Main.cpp'
text = main.read_text()

# r39 deliberately adds only two tiny embind bridge functions. It does not
# modify the OpenGL renderer, GS worker, mailbox, transfer, shader or draw hot
# paths. The switch calls Play!'s existing CGSHandler::SetDrawEnabled API.
function_anchor = '''void clearStats()\n{\n\tCStatsManager::GetInstance().ClearStats();\n}\n'''
if text.count(function_anchor) != 1:
    raise RuntimeError('Main.cpp: clearStats anchor missing')

function_insert = function_anchor + '''\nvoid setBlackMondayGsDrawEnabled(bool enabled)\n{\n\tif(g_virtualMachine == nullptr) return;\n\tauto gs = g_virtualMachine->GetGSHandler();\n\tif(gs == nullptr) return;\n\tgs->SetDrawEnabled(enabled);\n}\n\nbool getBlackMondayGsDrawEnabled()\n{\n\tif(g_virtualMachine == nullptr) return false;\n\tauto gs = g_virtualMachine->GetGSHandler();\n\tif(gs == nullptr) return false;\n\treturn gs->GetDrawEnabled();\n}\n'''
text = text.replace(function_anchor, function_insert, 1)

binding_anchor = '''\tfunction("clearStats", &clearStats);\n'''
if text.count(binding_anchor) != 1:
    raise RuntimeError('Main.cpp: clearStats binding anchor missing')

binding_insert = binding_anchor + '''\tfunction("setBlackMondayGsDrawEnabled", &setBlackMondayGsDrawEnabled);\n\tfunction("getBlackMondayGsDrawEnabled", &getBlackMondayGsDrawEnabled);\n'''
text = text.replace(binding_anchor, binding_insert, 1)
main.write_text(text)
print('Black Monday r39 minimal GS draw toggle bridge applied successfully.')
