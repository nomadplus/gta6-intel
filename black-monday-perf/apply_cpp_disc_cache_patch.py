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

old_h = '''#pragma once\n\n#include "Stream.h"\n\nclass CJsDiscImageDeviceStream : public Framework::CStream\n{\npublic:\n\tvirtual ~CJsDiscImageDeviceStream() = default;\n\n\tvoid Seek(int64, Framework::STREAM_SEEK_DIRECTION) override;\n\tuint64 Tell() override;\n\tuint64 Read(void*, uint64) override;\n\tuint64 Write(const void*, uint64) override;\n\tbool IsEOF() override;\n\tvoid Flush() override;\n\nprivate:\n\tuint64 m_position = 0;\n};\n'''
new_h = '''#pragma once\n\n#include <cstdint>\n#include <vector>\n#include "Stream.h"\n\nclass CJsDiscImageDeviceStream : public Framework::CStream\n{\npublic:\n\tvirtual ~CJsDiscImageDeviceStream() = default;\n\n\tvoid Seek(int64, Framework::STREAM_SEEK_DIRECTION) override;\n\tuint64 Tell() override;\n\tuint64 Read(void*, uint64) override;\n\tuint64 Write(const void*, uint64) override;\n\tbool IsEOF() override;\n\tvoid Flush() override;\n\nprivate:\n\tuint64 GetFileSize();\n\tvoid ReadDevice(void*, uint64, uint64);\n\n\tstatic constexpr uint64 CACHE_BYTES = 4 * 1024 * 1024;\n\tstatic constexpr uint64 INVALID_FILE_SIZE = ~static_cast<uint64>(0);\n\n\tuint64 m_position = 0;\n\tuint64 m_fileSize = INVALID_FILE_SIZE;\n\tuint64 m_cacheStart = 0;\n\tuint64 m_cacheSize = 0;\n\tstd::vector<uint8_t> m_cache;\n};\n'''
if htext != old_h:
    raise RuntimeError('Js_DiscImageDeviceStream.h did not match pinned upstream source')
h.write_text(new_h)

old_cpp = ctext
new_cpp = r'''#include "Js_DiscImageDeviceStream.h"
#include <algorithm>
#include <cassert>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <emscripten.h>
#include <unistd.h>

uint64 CJsDiscImageDeviceStream::GetFileSize()
{
	if(m_fileSize != INVALID_FILE_SIZE) return m_fileSize;
	uint32 positionLo = MAIN_THREAD_EM_ASM_INT({return Module.discImageDevice.getFileSize()});
	uint32 positionHi = MAIN_THREAD_EM_ASM_INT({return Module.discImageDevice.getFileSize() / 4294967296});
	m_fileSize = static_cast<uint64>(positionLo) | (static_cast<uint64>(positionHi) << 32);
	return m_fileSize;
}

void CJsDiscImageDeviceStream::ReadDevice(void* buffer, uint64 position, uint64 size)
{
	assert(size <= std::numeric_limits<uint32>::max());
	uint32 positionLow = static_cast<uint32>(position);
	uint32 positionHigh = static_cast<uint32>(position >> 32);

	MAIN_THREAD_EM_ASM({
		let posLow = $1 >>> 0;
		let posHigh = $2 >>> 0;
		let position = posLow + (posHigh * 4294967296);
		Module.discImageDevice.read($0, position, $3);
	},
	                   buffer, positionLow, positionHigh, static_cast<uint32>(size));
	while(!MAIN_THREAD_EM_ASM_INT({return Module.discImageDevice.isDone()}))
	{
		usleep(100);
	}
}

void CJsDiscImageDeviceStream::Seek(int64 position, Framework::STREAM_SEEK_DIRECTION whence)
{
	switch(whence)
	{
	case Framework::STREAM_SEEK_SET:
		m_position = position;
		break;
	case Framework::STREAM_SEEK_CUR:
		m_position += position;
		break;
	case Framework::STREAM_SEEK_END:
		m_position = GetFileSize();
		m_position += position;
		break;
	}
}

uint64 CJsDiscImageDeviceStream::Tell()
{
	return m_position;
}

uint64 CJsDiscImageDeviceStream::Read(void* buffer, uint64 size)
{
	if(size == 0) return 0;

	const uint64 fileSize = GetFileSize();
	if(m_position >= fileSize) return 0;
	const uint64 requestedSize = std::min<uint64>(size, fileSize - m_position);
	uint64 remaining = requestedSize;
	auto output = reinterpret_cast<uint8_t*>(buffer);

	while(remaining != 0)
	{
		const bool cacheHit = (m_cacheSize != 0) && (m_position >= m_cacheStart) && (m_position < (m_cacheStart + m_cacheSize));
		if(!cacheHit)
		{
			// Align to a large optical window. One Safari/main-thread transfer now
			// services thousands of subsequent 2KB PS2 sector reads entirely in WASM.
			m_cacheStart = (m_position / CACHE_BYTES) * CACHE_BYTES;
			m_cacheSize = std::min<uint64>(CACHE_BYTES, fileSize - m_cacheStart);
			m_cache.resize(static_cast<size_t>(m_cacheSize));
			ReadDevice(m_cache.data(), m_cacheStart, m_cacheSize);
		}

		const uint64 offsetInCache = m_position - m_cacheStart;
		const uint64 available = m_cacheSize - offsetInCache;
		const uint64 copySize = std::min<uint64>(remaining, available);
		memcpy(output, m_cache.data() + offsetInCache, static_cast<size_t>(copySize));
		output += copySize;
		m_position += copySize;
		remaining -= copySize;
	}

	return requestedSize;
}

uint64 CJsDiscImageDeviceStream::Write(const void*, uint64)
{
	throw std::runtime_error("Not supported.");
}

bool CJsDiscImageDeviceStream::IsEOF()
{
	return m_position >= GetFileSize();
}

void CJsDiscImageDeviceStream::Flush()
{
}
'''

# Guard against accidentally patching a different upstream implementation.
required = [
    'Module.discImageDevice.read($0, position, $3);',
    'while(!MAIN_THREAD_EM_ASM_INT({return Module.discImageDevice.isDone()}))',
    'uint64 CJsDiscImageDeviceStream::Read(void* buffer, uint64 size)',
]
for marker in required:
    if marker not in old_cpp:
        raise RuntimeError(f'Pinned Js_DiscImageDeviceStream.cpp marker missing: {marker}')
cpp.write_text(new_cpp)

print('Black Monday C++/WASM optical read-ahead patch applied successfully.')
