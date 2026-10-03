#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('usage: apply_runtime_stats_patch.py <Play-source-root>')

root = Path(sys.argv[1]).resolve()
path = root / 'Source/ui_js/Main.cpp'
text = path.read_text()


def replace_once(old, new):
    global text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'Main.cpp: expected exactly one match, got {count}: {old[:100]!r}')
    text = text.replace(old, new, 1)

# Accumulate the VM-side EE/IOP utilisation counters in the same StatsManager that
# already owns the browser frame and draw-call counters. The upstream JS frontend
# only subscribes to GS frames, so CPU utilisation otherwise remains empty.
replace_once(
    'CGSHandler::NewFrameEvent::Connection g_gsNewFrameConnection;\n',
    'CGSHandler::NewFrameEvent::Connection g_gsNewFrameConnection;\nCPS2VM::NewFrameEvent::Connection g_vmNewFrameConnection;\n',
)
replace_once(
    'g_gsNewFrameConnection = g_virtualMachine->GetGSHandler()->OnNewFrame.Connect(std::bind(&CStatsManager::OnGsNewFrame, &CStatsManager::GetInstance(), std::placeholders::_1));\n',
    'g_gsNewFrameConnection = g_virtualMachine->GetGSHandler()->OnNewFrame.Connect(std::bind(&CStatsManager::OnGsNewFrame, &CStatsManager::GetInstance(), std::placeholders::_1));\n\tg_vmNewFrameConnection = g_virtualMachine->OnNewFrame.Connect(std::bind(&CStatsManager::OnNewFrame, &CStatsManager::GetInstance(), g_virtualMachine));\n',
)

# Export lightweight EE/IOP utilisation counters. getDrawCalls() is already
# supplied by the existing Black Monday renderer patch, so deliberately reuse it
# rather than defining a second function with the same name.
replace_once(
    '\nEMSCRIPTEN_BINDINGS(Play)\n{',
    '''\nfloat getEeUsagePercent()\n{\n\tauto info = CStatsManager::GetInstance().GetCpuUtilisationInfo();\n\treturn CStatsManager::ComputeCpuUsageRatio(info.eeIdleTicks, info.eeTotalTicks);\n}\n\nfloat getIopUsagePercent()\n{\n\tauto info = CStatsManager::GetInstance().GetCpuUtilisationInfo();\n\treturn CStatsManager::ComputeCpuUsageRatio(info.iopIdleTicks, info.iopTotalTicks);\n}\n\nEMSCRIPTEN_BINDINGS(Play)\n{''',
)
replace_once(
    '\tfunction("clearStats", &clearStats);\n',
    '\tfunction("clearStats", &clearStats);\n\tfunction("getEeUsagePercent", &getEeUsagePercent);\n\tfunction("getIopUsagePercent", &getIopUsagePercent);\n',
)

# Guard that the earlier patch really did provide the draw-call export used by
# the browser HUD. Failing the build here is safer than silently shipping blanks.
if 'getDrawCalls' not in text:
    raise RuntimeError('Existing getDrawCalls hook is missing from transformed Main.cpp')

path.write_text(text)
print('Black Monday browser runtime stats patch applied successfully.')
