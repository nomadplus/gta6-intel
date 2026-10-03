#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('usage: apply_wasm_codegen_stats_patch.py <Play-source-root>')

root = Path(sys.argv[1]).resolve()
memory = root / 'deps/CodeGen/src/MemoryFunction.cpp'
main = root / 'Source/ui_js/Main.cpp'

memory_text = memory.read_text()

# The Emscripten dynarec creates a WebAssembly.Module and WebAssembly.Instance for
# newly translated guest blocks. Measure wall-clock cost in shared C++ atomics so
# measurements produced on pthreads remain visible to the main browser module.
old_include = '#include <cstdint>\n'
new_include = '#include <cstdint>\n#include <atomic>\n'
if memory_text.count(old_include) != 1:
    raise RuntimeError('MemoryFunction.cpp: cstdint include anchor changed')
memory_text = memory_text.replace(old_include, new_include, 1)

counter_anchor = '''EM_JS(void, WasmDeleteFunction, (int fctId),
{
\tremoveFunction(fctId);
});
EM_JS(emscripten::EM_VAL, WasmCreateModule, (uintptr_t code, uintptr_t size),
'''
if memory_text.count(counter_anchor) != 1:
    raise RuntimeError('MemoryFunction.cpp: WasmDeleteFunction anchor changed')
# Counters are placed before the module helper and are part of the Emscripten-only
# branch. Times are stored in microseconds to keep accumulation atomic/integer.
counter_insert = '''EM_JS(void, WasmDeleteFunction, (int fctId),
{
\tremoveFunction(fctId);
});

static std::atomic<unsigned long long> g_blackMondayWasmModuleCount(0);
static std::atomic<unsigned long long> g_blackMondayWasmModuleBytes(0);
static std::atomic<unsigned long long> g_blackMondayWasmModuleMicros(0);
static std::atomic<unsigned long long> g_blackMondayWasmInstanceCount(0);
static std::atomic<unsigned long long> g_blackMondayWasmInstanceMicros(0);

extern "C" unsigned long long BlackMonday_GetWasmModuleCount()
{
\treturn g_blackMondayWasmModuleCount.load(std::memory_order_relaxed);
}

extern "C" unsigned long long BlackMonday_GetWasmModuleBytes()
{
\treturn g_blackMondayWasmModuleBytes.load(std::memory_order_relaxed);
}

extern "C" unsigned long long BlackMonday_GetWasmModuleMicros()
{
\treturn g_blackMondayWasmModuleMicros.load(std::memory_order_relaxed);
}

extern "C" unsigned long long BlackMonday_GetWasmInstanceCount()
{
\treturn g_blackMondayWasmInstanceCount.load(std::memory_order_relaxed);
}

extern "C" unsigned long long BlackMonday_GetWasmInstanceMicros()
{
\treturn g_blackMondayWasmInstanceMicros.load(std::memory_order_relaxed);
}

EM_JS(emscripten::EM_VAL, WasmCreateModule, (uintptr_t code, uintptr_t size),
'''
memory_text = memory_text.replace(counter_anchor, counter_insert, 1)

constructor_old = '''#elif defined(MEMFUNC_USE_WASM)
\tm_wasmModule = emscripten::val::take_ownership(WasmCreateModule(reinterpret_cast<uintptr_t>(code), size));
\tm_size = size;
\tm_code = reinterpret_cast<void*>(WasmCreateFunction(m_wasmModule.as_handle()));
#endif
'''
constructor_new = '''#elif defined(MEMFUNC_USE_WASM)
\tconst double blackMondayModuleStart = emscripten_get_now();
\tm_wasmModule = emscripten::val::take_ownership(WasmCreateModule(reinterpret_cast<uintptr_t>(code), size));
\tconst double blackMondayModuleEnd = emscripten_get_now();
\tm_size = size;
\tconst double blackMondayInstanceStart = emscripten_get_now();
\tm_code = reinterpret_cast<void*>(WasmCreateFunction(m_wasmModule.as_handle()));
\tconst double blackMondayInstanceEnd = emscripten_get_now();
\tg_blackMondayWasmModuleCount.fetch_add(1, std::memory_order_relaxed);
\tg_blackMondayWasmModuleBytes.fetch_add(static_cast<unsigned long long>(size), std::memory_order_relaxed);
\tg_blackMondayWasmModuleMicros.fetch_add(static_cast<unsigned long long>((blackMondayModuleEnd - blackMondayModuleStart) * 1000.0), std::memory_order_relaxed);
\tg_blackMondayWasmInstanceCount.fetch_add(1, std::memory_order_relaxed);
\tg_blackMondayWasmInstanceMicros.fetch_add(static_cast<unsigned long long>((blackMondayInstanceEnd - blackMondayInstanceStart) * 1000.0), std::memory_order_relaxed);
#endif
'''
if memory_text.count(constructor_old) != 1:
    raise RuntimeError('MemoryFunction.cpp: WASM constructor anchor changed')
memory_text = memory_text.replace(constructor_old, constructor_new, 1)

instance_old = '''#if defined(MEMFUNC_USE_WASM)
\tCMemoryFunction result;
\tresult.m_wasmModule = m_wasmModule;
\tresult.m_size = m_size;
\tresult.m_code = reinterpret_cast<void*>(WasmCreateFunction(m_wasmModule.as_handle()));
\treturn result;
'''
instance_new = '''#if defined(MEMFUNC_USE_WASM)
\tCMemoryFunction result;
\tresult.m_wasmModule = m_wasmModule;
\tresult.m_size = m_size;
\tconst double blackMondayInstanceStart = emscripten_get_now();
\tresult.m_code = reinterpret_cast<void*>(WasmCreateFunction(m_wasmModule.as_handle()));
\tconst double blackMondayInstanceEnd = emscripten_get_now();
\tg_blackMondayWasmInstanceCount.fetch_add(1, std::memory_order_relaxed);
\tg_blackMondayWasmInstanceMicros.fetch_add(static_cast<unsigned long long>((blackMondayInstanceEnd - blackMondayInstanceStart) * 1000.0), std::memory_order_relaxed);
\treturn result;
'''
if memory_text.count(instance_old) != 1:
    raise RuntimeError('MemoryFunction.cpp: CreateInstance WASM anchor changed')
memory_text = memory_text.replace(instance_old, instance_new, 1)
memory.write_text(memory_text)

main_text = main.read_text()
get_draw_anchor = '''unsigned int getDrawCalls()
{
\treturn CStatsManager::GetInstance().GetDrawCalls();
}
'''
if main_text.count(get_draw_anchor) != 1:
    raise RuntimeError('Main.cpp: getDrawCalls anchor changed')
getters = get_draw_anchor + '''
extern "C" unsigned long long BlackMonday_GetWasmModuleCount();
extern "C" unsigned long long BlackMonday_GetWasmModuleBytes();
extern "C" unsigned long long BlackMonday_GetWasmModuleMicros();
extern "C" unsigned long long BlackMonday_GetWasmInstanceCount();
extern "C" unsigned long long BlackMonday_GetWasmInstanceMicros();

double getWasmCodegenModuleCount() { return static_cast<double>(BlackMonday_GetWasmModuleCount()); }
double getWasmCodegenModuleBytes() { return static_cast<double>(BlackMonday_GetWasmModuleBytes()); }
double getWasmCodegenModuleMs() { return static_cast<double>(BlackMonday_GetWasmModuleMicros()) / 1000.0; }
double getWasmCodegenInstanceCount() { return static_cast<double>(BlackMonday_GetWasmInstanceCount()); }
double getWasmCodegenInstanceMs() { return static_cast<double>(BlackMonday_GetWasmInstanceMicros()) / 1000.0; }
'''
main_text = main_text.replace(get_draw_anchor, getters, 1)

binding_anchor = '\tfunction("getDrawCalls", &getDrawCalls);\n'
if main_text.count(binding_anchor) != 1:
    raise RuntimeError('Main.cpp: getDrawCalls binding anchor changed')
bindings = binding_anchor + '''\tfunction("getWasmCodegenModuleCount", &getWasmCodegenModuleCount);
\tfunction("getWasmCodegenModuleBytes", &getWasmCodegenModuleBytes);
\tfunction("getWasmCodegenModuleMs", &getWasmCodegenModuleMs);
\tfunction("getWasmCodegenInstanceCount", &getWasmCodegenInstanceCount);
\tfunction("getWasmCodegenInstanceMs", &getWasmCodegenInstanceMs);
'''
main_text = main_text.replace(binding_anchor, bindings, 1)
main.write_text(main_text)

print('Black Monday WASM dynarec wall-clock instrumentation applied.')
