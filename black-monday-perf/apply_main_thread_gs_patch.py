#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('usage: apply_main_thread_gs_patch.py <Play-source-root>')

root = Path(sys.argv[1]).resolve()


def replace_once(rel, old, new):
    path = root / rel
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{rel}: expected exactly one match, got {count}: {old[:100]!r}')
    path.write_text(text.replace(old, new, 1))
    print(f'patched {rel}')


# The stock browser renderer creates the WebGL context on the browser runtime
# thread, but CGSH_OpenGL defaults to a dedicated GS pthread. On browsers that do
# not run that context as a true worker-owned OffscreenCanvas, WebGL work from the
# GS pthread is proxied back to the browser thread. Black Monday issues enough GS
# work for that cross-thread/proxy path to become a plausible dominant cost on
# iPhone Safari. r34 adds an iPhone-only mode where the GS mailbox is drained on
# the browser runtime thread itself, so all renderer GL calls execute next to the
# context that owns them. The existing threaded mode remains available as a
# fallback and for A/B testing.

replace_once(
    'Source/gs/GSHandler.h',
    '\tvoid ProcessSingleFrame();\n',
    '\tvoid ProcessSingleFrame();\n\tunsigned int ProcessPendingCalls(unsigned int maxCalls);\n',
)

replace_once(
    'Source/gs/GSHandler.cpp',
    '''void CGSHandler::ProcessSingleFrame()\n{\n''',
    '''unsigned int CGSHandler::ProcessPendingCalls(unsigned int maxCalls)\n{\n\tassert(!m_gsThreaded);\n\tunsigned int processed = 0;\n\twhile((processed < maxCalls) && m_mailBox.IsPending())\n\t{\n\t\tm_mailBox.ReceiveCall();\n\t\tprocessed++;\n\t}\n\treturn processed;\n}\n\nvoid CGSHandler::ProcessSingleFrame()\n{\n''',
)

replace_once(
    'Source/ui_js/GSH_OpenGLJs.h',
    '''\tCGSH_OpenGLJs(EMSCRIPTEN_WEBGL_CONTEXT_HANDLE);\n\tvirtual ~CGSH_OpenGLJs() = default;\n\n\tstatic FactoryFunction GetFactoryFunction(EMSCRIPTEN_WEBGL_CONTEXT_HANDLE);\n''',
    '''\tCGSH_OpenGLJs(EMSCRIPTEN_WEBGL_CONTEXT_HANDLE, bool gsThreaded);\n\tvirtual ~CGSH_OpenGLJs() = default;\n\n\tstatic FactoryFunction GetFactoryFunction(EMSCRIPTEN_WEBGL_CONTEXT_HANDLE, bool gsThreaded);\n''',
)

replace_once(
    'Source/ui_js/GSH_OpenGLJs.cpp',
    '''CGSH_OpenGLJs::CGSH_OpenGLJs(EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context)\n    : m_context(context)\n{\n}\n\nCGSH_OpenGL::FactoryFunction CGSH_OpenGLJs::GetFactoryFunction(EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context)\n{\n\treturn [context]() { return new CGSH_OpenGLJs(context); };\n}\n''',
    '''CGSH_OpenGLJs::CGSH_OpenGLJs(EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context, bool gsThreaded)\n    : CGSH_OpenGL(gsThreaded)\n    , m_context(context)\n{\n}\n\nCGSH_OpenGL::FactoryFunction CGSH_OpenGLJs::GetFactoryFunction(EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context, bool gsThreaded)\n{\n\treturn [context, gsThreaded]() { return new CGSH_OpenGLJs(context, gsThreaded); };\n}\n''',
)

replace_once(
    'Source/ui_js/Main.cpp',
    'CSH_OpenAL* g_soundHandler = nullptr;\n',
    'CSH_OpenAL* g_soundHandler = nullptr;\nbool g_blackMondayGsOnMainThread = false;\n',
)

replace_once(
    'Source/ui_js/Main.cpp',
    'g_virtualMachine->CreateGSHandler(CGSH_OpenGLJs::GetFactoryFunction(g_context));',
    'g_virtualMachine->CreateGSHandler(CGSH_OpenGLJs::GetFactoryFunction(g_context, !g_blackMondayGsOnMainThread));',
)

# The r33 dynarec patch runs immediately before this patch, so its final getter is
# a stable insertion point for the r34 bridge functions and bindings.
main = root / 'Source/ui_js/Main.cpp'
text = main.read_text()
function_anchor = '''double getWasmCodegenInstanceMs() { return static_cast<double>(BlackMonday_GetWasmInstanceMicros()) / 1000.0; }\n'''
if text.count(function_anchor) != 1:
    raise RuntimeError('Main.cpp: r33 codegen getter anchor missing')
function_insert = function_anchor + '''\nvoid setBlackMondayGsOnMainThread(bool enabled)\n{\n\t// This must be selected before initVm creates the GS handler.\n\tif(g_virtualMachine) return;\n\tg_blackMondayGsOnMainThread = enabled;\n}\n\nunsigned int pumpBlackMondayGs(unsigned int maxCalls)\n{\n\tif(!g_blackMondayGsOnMainThread || !g_virtualMachine || (maxCalls == 0)) return 0;\n\tauto gsHandler = g_virtualMachine->GetGSHandler();\n\tif(!gsHandler) return 0;\n\treturn gsHandler->ProcessPendingCalls(maxCalls);\n}\n'''
text = text.replace(function_anchor, function_insert, 1)

binding_anchor = '\tfunction("getWasmCodegenInstanceMs", &getWasmCodegenInstanceMs);\n'
if text.count(binding_anchor) != 1:
    raise RuntimeError('Main.cpp: r33 codegen binding anchor missing')
binding_insert = binding_anchor + '''\tfunction("setBlackMondayGsOnMainThread", &setBlackMondayGsOnMainThread);\n\tfunction("pumpBlackMondayGs", &pumpBlackMondayGs);\n'''
text = text.replace(binding_anchor, binding_insert, 1)
main.write_text(text)

print('Black Monday r34 main-thread GS bridge applied successfully.')
