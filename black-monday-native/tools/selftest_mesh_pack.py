#!/usr/bin/env python3
"""Self-test the native mesh-pack transport contract."""
from __future__ import annotations
import struct, tempfile
from pathlib import Path
from mesh_pack import HEADER, MAGIC, VERSION, FLOATS_PER_VERTEX, inspect

verts=[
    (0.,0.,0., 0.,1.,0., 0.,0.),
    (1.,0.,0., 0.,1.,0., 1.,0.),
    (0.,0.,1., 0.,1.,0., 0.,1.),
]

with tempfile.TemporaryDirectory() as td:
    d=Path(td); good=d/"good.mesh"
    payload=bytearray(HEADER.pack(MAGIC,VERSION,3,3,FLOATS_PER_VERTEX*4,0.,0.,0.,1.,0.,1.))
    for v in verts: payload.extend(struct.pack("<8f",*v))
    payload.extend(struct.pack("<3I",0,1,2))
    good.write_bytes(payload)
    a=inspect(good); b=inspect(good)
    assert a==b and a["vertexCount"]==3 and a["indexCount"]==3 and len(a["sha256"])==64

    truncated=d/"truncated.mesh"; truncated.write_bytes(payload[:-1])
    try: inspect(truncated); raise AssertionError("truncation accepted")
    except SystemExit: pass

    bad_index=bytearray(payload)
    struct.pack_into("<I",bad_index,HEADER.size+3*FLOATS_PER_VERTEX*4+8,3)
    p=d/"bad-index.mesh"; p.write_bytes(bad_index)
    try: inspect(p); raise AssertionError("out-of-range index accepted")
    except SystemExit: pass

print("mesh pack self-test: PASS")
