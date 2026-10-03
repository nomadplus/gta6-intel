#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('usage: apply_vm_wall_profiler_patch.py <Play-source-root>')

root = Path(sys.argv[1]).resolve()


def replace_once(rel, old, new):
    path = root / rel
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{rel}: expected exactly one match, got {count}: {old[:120]!r}')
    path.write_text(text.replace(old, new, 1))
    print(f'patched {rel}')


# r35 keeps Play!'s known-booting threaded GS architecture. Instead of changing
# renderer topology again, sample real host wall time spent in the VM subsystems.
# EE/IOP are sampled 1/64 calls to keep profiler overhead small; the sampled time
# is scaled back to an estimated cumulative wall cost. SPU, GS sync and limiter
# occur at much lower frequency and can be measured directly.
replace_once(
    'Source/PS2VM.cpp',
    '#include <fenv.h>\n',
    '#include <fenv.h>\n#include <atomic>\n#include <chrono>\n',
)

replace_once(
    'Source/PS2VM.cpp',
    '#define LOG_NAME ("ps2vm")\n',
    '''#define LOG_NAME ("ps2vm")\n\nnamespace\n{\n\tusing BlackMondayClock = std::chrono::steady_clock;\n\tstatic std::atomic<unsigned long long> g_blackMondayEeEstimatedMicros(0);\n\tstatic std::atomic<unsigned long long> g_blackMondayIopEstimatedMicros(0);\n\tstatic std::atomic<unsigned long long> g_blackMondaySpuMicros(0);\n\tstatic std::atomic<unsigned long long> g_blackMondayGsSyncMicros(0);\n\tstatic std::atomic<unsigned long long> g_blackMondayLimiterMicros(0);\n\n\tstatic unsigned long long BlackMondayElapsedMicros(BlackMondayClock::time_point start)\n\t{\n\t\tauto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(BlackMondayClock::now() - start).count();\n\t\treturn elapsed > 0 ? static_cast<unsigned long long>(elapsed) : 0;\n\t}\n}\n\nextern "C" unsigned long long BlackMonday_GetEeEstimatedMicros()\n{\n\treturn g_blackMondayEeEstimatedMicros.load(std::memory_order_relaxed);\n}\n\nextern "C" unsigned long long BlackMonday_GetIopEstimatedMicros()\n{\n\treturn g_blackMondayIopEstimatedMicros.load(std::memory_order_relaxed);\n}\n\nextern "C" unsigned long long BlackMonday_GetSpuMicros()\n{\n\treturn g_blackMondaySpuMicros.load(std::memory_order_relaxed);\n}\n\nextern "C" unsigned long long BlackMonday_GetGsSyncMicros()\n{\n\treturn g_blackMondayGsSyncMicros.load(std::memory_order_relaxed);\n}\n\nextern "C" unsigned long long BlackMonday_GetLimiterMicros()\n{\n\treturn g_blackMondayLimiterMicros.load(std::memory_order_relaxed);\n}\n''',
)

replace_once(
    'Source/PS2VM.cpp',
    '''\t\t\tif(m_spuUpdateTicks <= 0)\n\t\t\t{\n\t\t\t\tUpdateSpu();\n\t\t\t\tm_spuUpdateTicks += m_spuUpdateTicksTotal;\n\t\t\t}\n''',
    '''\t\t\tif(m_spuUpdateTicks <= 0)\n\t\t\t{\n\t\t\t\tauto blackMondaySpuStart = BlackMondayClock::now();\n\t\t\t\tUpdateSpu();\n\t\t\t\tg_blackMondaySpuMicros.fetch_add(BlackMondayElapsedMicros(blackMondaySpuStart), std::memory_order_relaxed);\n\t\t\t\tm_spuUpdateTicks += m_spuUpdateTicksTotal;\n\t\t\t}\n''',
)

replace_once(
    'Source/PS2VM.cpp',
    '''\t\t\t\t\t\t\tm_ee->m_gs->SetVBlank();\n''',
    '''\t\t\t\t\t\t\tauto blackMondayGsSyncStart = BlackMondayClock::now();\n\t\t\t\t\t\t\tm_ee->m_gs->SetVBlank();\n\t\t\t\t\t\t\tg_blackMondayGsSyncMicros.fetch_add(BlackMondayElapsedMicros(blackMondayGsSyncStart), std::memory_order_relaxed);\n''',
)

replace_once(
    'Source/PS2VM.cpp',
    '''\t\t\t\t\t\tm_frameLimiter.EndFrame();\n\t\t\t\t\t\tm_frameLimiter.BeginFrame();\n''',
    '''\t\t\t\t\t\tauto blackMondayLimiterStart = BlackMondayClock::now();\n\t\t\t\t\t\tm_frameLimiter.EndFrame();\n\t\t\t\t\t\tm_frameLimiter.BeginFrame();\n\t\t\t\t\t\tg_blackMondayLimiterMicros.fetch_add(BlackMondayElapsedMicros(blackMondayLimiterStart), std::memory_order_relaxed);\n''',
)

replace_once(
    'Source/PS2VM.cpp',
    '''\t\t\t\tm_eeExecutionTicks += m_eeTickStep;\n\t\t\t\tm_iopExecutionTicks += m_iopTickStep;\n\n\t\t\t\tUpdateEe();\n\t\t\t\tUpdateIop();\n''',
    '''\t\t\t\tm_eeExecutionTicks += m_eeTickStep;\n\t\t\t\tm_iopExecutionTicks += m_iopTickStep;\n\n\t\t\t\t// Sample every 64th VM update. Scaling the measured sample keeps the\n\t\t\t\t// hot path almost unchanged while still showing which guest CPU is\n\t\t\t\t// consuming host wall time on Safari.\n\t\t\t\tstatic unsigned int blackMondayEeSamplePhase = 0;\n\t\t\t\tif((blackMondayEeSamplePhase++ & 0x3F) == 0)\n\t\t\t\t{\n\t\t\t\t\tauto start = BlackMondayClock::now();\n\t\t\t\t\tUpdateEe();\n\t\t\t\t\tg_blackMondayEeEstimatedMicros.fetch_add(BlackMondayElapsedMicros(start) * 64ULL, std::memory_order_relaxed);\n\t\t\t\t}\n\t\t\t\telse\n\t\t\t\t{\n\t\t\t\t\tUpdateEe();\n\t\t\t\t}\n\n\t\t\t\tstatic unsigned int blackMondayIopSamplePhase = 0;\n\t\t\t\tif((blackMondayIopSamplePhase++ & 0x3F) == 0)\n\t\t\t\t{\n\t\t\t\t\tauto start = BlackMondayClock::now();\n\t\t\t\t\tUpdateIop();\n\t\t\t\t\tg_blackMondayIopEstimatedMicros.fetch_add(BlackMondayElapsedMicros(start) * 64ULL, std::memory_order_relaxed);\n\t\t\t\t}\n\t\t\t\telse\n\t\t\t\t{\n\t\t\t\t\tUpdateIop();\n\t\t\t\t}\n''',
)

# Measure actual active time of the dedicated GS worker without touching each GL
# command. One timing point per mailbox burst is much cheaper than instrumenting
# every draw/transfer operation.
replace_once(
    'Source/gs/GSHandler.cpp',
    '#include <functional>\n',
    '#include <functional>\n#include <atomic>\n#include <chrono>\n',
)

replace_once(
    'Source/gs/GSHandler.cpp',
    '#define LOG_NAME ("gs")\n',
    '''#define LOG_NAME ("gs")\n\nnamespace\n{\n\tusing BlackMondayGsClock = std::chrono::steady_clock;\n\tstatic std::atomic<unsigned long long> g_blackMondayGsWorkerMicros(0);\n\tstatic std::atomic<unsigned long long> g_blackMondayGsWorkerBursts(0);\n\tstatic std::atomic<unsigned long long> g_blackMondayGsWorkerCalls(0);\n}\n\nextern "C" unsigned long long BlackMonday_GetGsWorkerMicros()\n{\n\treturn g_blackMondayGsWorkerMicros.load(std::memory_order_relaxed);\n}\n\nextern "C" unsigned long long BlackMonday_GetGsWorkerBursts()\n{\n\treturn g_blackMondayGsWorkerBursts.load(std::memory_order_relaxed);\n}\n\nextern "C" unsigned long long BlackMonday_GetGsWorkerCalls()\n{\n\treturn g_blackMondayGsWorkerCalls.load(std::memory_order_relaxed);\n}\n''',
)

replace_once(
    'Source/gs/GSHandler.cpp',
    '''void CGSHandler::ThreadProc()\n{\n\twhile(!m_threadDone)\n\t{\n\t\tm_mailBox.WaitForCall();\n\t\twhile(m_mailBox.IsPending())\n\t\t{\n\t\t\tm_mailBox.ReceiveCall();\n\t\t}\n\t}\n}\n''',
    '''void CGSHandler::ThreadProc()\n{\n\twhile(!m_threadDone)\n\t{\n\t\tm_mailBox.WaitForCall();\n\t\tauto blackMondayGsStart = BlackMondayGsClock::now();\n\t\tunsigned long long blackMondayGsCalls = 0;\n\t\twhile(m_mailBox.IsPending())\n\t\t{\n\t\t\tm_mailBox.ReceiveCall();\n\t\t\tblackMondayGsCalls++;\n\t\t}\n\t\tif(blackMondayGsCalls != 0)\n\t\t{\n\t\t\tauto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(BlackMondayGsClock::now() - blackMondayGsStart).count();\n\t\t\tif(elapsed > 0) g_blackMondayGsWorkerMicros.fetch_add(static_cast<unsigned long long>(elapsed), std::memory_order_relaxed);\n\t\t\tg_blackMondayGsWorkerBursts.fetch_add(1, std::memory_order_relaxed);\n\t\t\tg_blackMondayGsWorkerCalls.fetch_add(blackMondayGsCalls, std::memory_order_relaxed);\n\t\t}\n\t}\n}\n''',
)

# Browser getters. The r33 codegen patch is applied immediately before r35 and
# provides a stable insertion point in Main.cpp.
main = root / 'Source/ui_js/Main.cpp'
text = main.read_text()
function_anchor = 'double getWasmCodegenInstanceMs() { return static_cast<double>(BlackMonday_GetWasmInstanceMicros()) / 1000.0; }\n'
if text.count(function_anchor) != 1:
    raise RuntimeError('Main.cpp: r33 codegen getter anchor missing')
function_insert = function_anchor + '''\nextern "C" unsigned long long BlackMonday_GetEeEstimatedMicros();\nextern "C" unsigned long long BlackMonday_GetIopEstimatedMicros();\nextern "C" unsigned long long BlackMonday_GetSpuMicros();\nextern "C" unsigned long long BlackMonday_GetGsSyncMicros();\nextern "C" unsigned long long BlackMonday_GetLimiterMicros();\nextern "C" unsigned long long BlackMonday_GetGsWorkerMicros();\nextern "C" unsigned long long BlackMonday_GetGsWorkerBursts();\nextern "C" unsigned long long BlackMonday_GetGsWorkerCalls();\n\ndouble getBlackMondayEeHostMs() { return static_cast<double>(BlackMonday_GetEeEstimatedMicros()) / 1000.0; }\ndouble getBlackMondayIopHostMs() { return static_cast<double>(BlackMonday_GetIopEstimatedMicros()) / 1000.0; }\ndouble getBlackMondaySpuHostMs() { return static_cast<double>(BlackMonday_GetSpuMicros()) / 1000.0; }\ndouble getBlackMondayGsSyncMs() { return static_cast<double>(BlackMonday_GetGsSyncMicros()) / 1000.0; }\ndouble getBlackMondayLimiterMs() { return static_cast<double>(BlackMonday_GetLimiterMicros()) / 1000.0; }\ndouble getBlackMondayGsWorkerMs() { return static_cast<double>(BlackMonday_GetGsWorkerMicros()) / 1000.0; }\ndouble getBlackMondayGsWorkerBursts() { return static_cast<double>(BlackMonday_GetGsWorkerBursts()); }\ndouble getBlackMondayGsWorkerCalls() { return static_cast<double>(BlackMonday_GetGsWorkerCalls()); }\n'''
text = text.replace(function_anchor, function_insert, 1)

binding_anchor = '\tfunction("getWasmCodegenInstanceMs", &getWasmCodegenInstanceMs);\n'
if text.count(binding_anchor) != 1:
    raise RuntimeError('Main.cpp: r33 codegen binding anchor missing')
binding_insert = binding_anchor + '''\tfunction("getBlackMondayEeHostMs", &getBlackMondayEeHostMs);\n\tfunction("getBlackMondayIopHostMs", &getBlackMondayIopHostMs);\n\tfunction("getBlackMondaySpuHostMs", &getBlackMondaySpuHostMs);\n\tfunction("getBlackMondayGsSyncMs", &getBlackMondayGsSyncMs);\n\tfunction("getBlackMondayLimiterMs", &getBlackMondayLimiterMs);\n\tfunction("getBlackMondayGsWorkerMs", &getBlackMondayGsWorkerMs);\n\tfunction("getBlackMondayGsWorkerBursts", &getBlackMondayGsWorkerBursts);\n\tfunction("getBlackMondayGsWorkerCalls", &getBlackMondayGsWorkerCalls);\n'''
text = text.replace(binding_anchor, binding_insert, 1)
main.write_text(text)

print('Black Monday r35 subsystem wall profiler applied successfully.')
