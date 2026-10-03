#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('usage: apply_gs_breakdown_profiler.py <Play-source-root>')

root = Path(sys.argv[1]).resolve()


def replace_once(rel, old, new):
    path = root / rel
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{rel}: expected exactly one match, got {count}: {old[:120]!r}')
    path.write_text(text.replace(old, new, 1))
    print(f'patched {rel}')

# Shared low-overhead wall-time buckets. These deliberately measure overlapping
# renderer layers: draw/flush, texture preparation, transfers, flip/present and
# shader-cache misses. r35 has already proven the GS worker/sync path dominates;
# r36 identifies which renderer operation is responsible without changing
# rendering behaviour.
header = root / 'Source/gs/GSH_OpenGL/BlackMondayGsBreakdown.h'
header.write_text(r'''#pragma once
#include <atomic>
#include <chrono>

namespace BlackMondayGsBreakdown
{
	struct Bucket
	{
		std::atomic<unsigned long long> micros{0};
		std::atomic<unsigned long long> calls{0};
	};

	extern Bucket g_draw;
	extern Bucket g_texture;
	extern Bucket g_transfer;
	extern Bucket g_flip;
	extern Bucket g_shader;

	class Scope
	{
	public:
		explicit Scope(Bucket& bucket)
		    : m_bucket(bucket)
		    , m_start(std::chrono::steady_clock::now())
		{
		}

		~Scope()
		{
			auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - m_start).count();
			if(elapsed > 0) m_bucket.micros.fetch_add(static_cast<unsigned long long>(elapsed), std::memory_order_relaxed);
			m_bucket.calls.fetch_add(1, std::memory_order_relaxed);
		}

	private:
		Bucket& m_bucket;
		std::chrono::steady_clock::time_point m_start;
	};
}
''')
print('created Source/gs/GSH_OpenGL/BlackMondayGsBreakdown.h')

replace_once(
    'Source/gs/GSH_OpenGL/GSH_OpenGL.cpp',
    '#include "GSH_OpenGL.h"\n',
    '#include "GSH_OpenGL.h"\n#include "BlackMondayGsBreakdown.h"\n',
)

replace_once(
    'Source/gs/GSH_OpenGL/GSH_OpenGL.cpp',
    '#define FRAMEBUFFER_HEIGHT 1024\n',
    '''#define FRAMEBUFFER_HEIGHT 1024\n\nnamespace BlackMondayGsBreakdown\n{\n\tBucket g_draw;\n\tBucket g_texture;\n\tBucket g_transfer;\n\tBucket g_flip;\n\tBucket g_shader;\n}\n\nextern "C" unsigned long long BlackMonday_GetGsDrawMicros() { return BlackMondayGsBreakdown::g_draw.micros.load(std::memory_order_relaxed); }\nextern "C" unsigned long long BlackMonday_GetGsTextureMicros() { return BlackMondayGsBreakdown::g_texture.micros.load(std::memory_order_relaxed); }\nextern "C" unsigned long long BlackMonday_GetGsTransferMicros() { return BlackMondayGsBreakdown::g_transfer.micros.load(std::memory_order_relaxed); }\nextern "C" unsigned long long BlackMonday_GetGsFlipMicros() { return BlackMondayGsBreakdown::g_flip.micros.load(std::memory_order_relaxed); }\nextern "C" unsigned long long BlackMonday_GetGsShaderMicros() { return BlackMondayGsBreakdown::g_shader.micros.load(std::memory_order_relaxed); }\n''',
)

replace_once(
    'Source/gs/GSH_OpenGL/GSH_OpenGL.cpp',
    'void CGSH_OpenGL::FlushVertexBuffer()\n{\n',
    'void CGSH_OpenGL::FlushVertexBuffer()\n{\n\tBlackMondayGsBreakdown::Scope blackMondayGsDrawScope(BlackMondayGsBreakdown::g_draw);\n',
)

replace_once(
    'Source/gs/GSH_OpenGL/GSH_OpenGL.cpp',
    'void CGSH_OpenGL::ProcessHostToLocalTransfer()\n{\n',
    'void CGSH_OpenGL::ProcessHostToLocalTransfer()\n{\n\tBlackMondayGsBreakdown::Scope blackMondayGsTransferScope(BlackMondayGsBreakdown::g_transfer);\n',
)

replace_once(
    'Source/gs/GSH_OpenGL/GSH_OpenGL.cpp',
    'void CGSH_OpenGL::ProcessLocalToLocalTransfer()\n{\n',
    'void CGSH_OpenGL::ProcessLocalToLocalTransfer()\n{\n\tBlackMondayGsBreakdown::Scope blackMondayGsTransferScope(BlackMondayGsBreakdown::g_transfer);\n',
)

replace_once(
    'Source/gs/GSH_OpenGL/GSH_OpenGL.cpp',
    'void CGSH_OpenGL::FlipImpl(const DISPLAY_INFO& dispInfo)\n{\n',
    'void CGSH_OpenGL::FlipImpl(const DISPLAY_INFO& dispInfo)\n{\n\tBlackMondayGsBreakdown::Scope blackMondayGsFlipScope(BlackMondayGsBreakdown::g_flip);\n',
)

replace_once(
    'Source/gs/GSH_OpenGL/GSH_OpenGL.cpp',
    '''\tif(shaderIterator == m_shaders.end())\n\t{\n\t\tauto shader = GenerateShader(shaderCaps);\n''',
    '''\tif(shaderIterator == m_shaders.end())\n\t{\n\t\tBlackMondayGsBreakdown::Scope blackMondayGsShaderScope(BlackMondayGsBreakdown::g_shader);\n\t\tauto shader = GenerateShader(shaderCaps);\n''',
)

replace_once(
    'Source/gs/GSH_OpenGL/GSH_OpenGL_Texture.cpp',
    '#include "GSH_OpenGL.h"\n',
    '#include "GSH_OpenGL.h"\n#include "BlackMondayGsBreakdown.h"\n',
)
replace_once(
    'Source/gs/GSH_OpenGL/GSH_OpenGL_Texture.cpp',
    'CGSH_OpenGL::TEXTURE_INFO CGSH_OpenGL::PrepareTexture(const TEX0& tex0)\n{\n',
    'CGSH_OpenGL::TEXTURE_INFO CGSH_OpenGL::PrepareTexture(const TEX0& tex0)\n{\n\tBlackMondayGsBreakdown::Scope blackMondayGsTextureScope(BlackMondayGsBreakdown::g_texture);\n',
)

# Bind cumulative bucket times to JavaScript. r35 is applied immediately before
# this patch, so its GS-worker getter is a stable anchor.
main = root / 'Source/ui_js/Main.cpp'
text = main.read_text()
function_anchor = 'double getBlackMondayGsWorkerCalls() { return static_cast<double>(BlackMonday_GetGsWorkerCalls()); }\n'
if text.count(function_anchor) != 1:
    raise RuntimeError('Main.cpp: r35 GS worker getter anchor missing')
function_insert = function_anchor + '''\nextern "C" unsigned long long BlackMonday_GetGsDrawMicros();\nextern "C" unsigned long long BlackMonday_GetGsTextureMicros();\nextern "C" unsigned long long BlackMonday_GetGsTransferMicros();\nextern "C" unsigned long long BlackMonday_GetGsFlipMicros();\nextern "C" unsigned long long BlackMonday_GetGsShaderMicros();\n\ndouble getBlackMondayGsDrawMs() { return static_cast<double>(BlackMonday_GetGsDrawMicros()) / 1000.0; }\ndouble getBlackMondayGsTextureMs() { return static_cast<double>(BlackMonday_GetGsTextureMicros()) / 1000.0; }\ndouble getBlackMondayGsTransferMs() { return static_cast<double>(BlackMonday_GetGsTransferMicros()) / 1000.0; }\ndouble getBlackMondayGsFlipMs() { return static_cast<double>(BlackMonday_GetGsFlipMicros()) / 1000.0; }\ndouble getBlackMondayGsShaderMs() { return static_cast<double>(BlackMonday_GetGsShaderMicros()) / 1000.0; }\n'''
text = text.replace(function_anchor, function_insert, 1)

binding_anchor = '\tfunction("getBlackMondayGsWorkerCalls", &getBlackMondayGsWorkerCalls);\n'
if text.count(binding_anchor) != 1:
    raise RuntimeError('Main.cpp: r35 GS worker binding anchor missing')
binding_insert = binding_anchor + '''\tfunction("getBlackMondayGsDrawMs", &getBlackMondayGsDrawMs);\n\tfunction("getBlackMondayGsTextureMs", &getBlackMondayGsTextureMs);\n\tfunction("getBlackMondayGsTransferMs", &getBlackMondayGsTransferMs);\n\tfunction("getBlackMondayGsFlipMs", &getBlackMondayGsFlipMs);\n\tfunction("getBlackMondayGsShaderMs", &getBlackMondayGsShaderMs);\n'''
text = text.replace(binding_anchor, binding_insert, 1)
main.write_text(text)

print('Black Monday r36 GS breakdown profiler applied successfully.')
