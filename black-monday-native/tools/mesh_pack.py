#!/usr/bin/env python3
"""Emit/validate the deterministic native mesh-pack header used by WebGL loaders.

This module defines the transport container only. It does not guess PS2 .big
geometry fields. Retail decoders must first prove vertex/index semantics, then
write their decoded payload through this contract.
"""
from __future__ import annotations
import argparse, hashlib, json, struct
from pathlib import Path

MAGIC=b"BMNWMSH1"
HEADER=struct.Struct("<8sIIII6f")
VERSION=1
TRIANGLES=4
FLOATS_PER_VERTEX=8  # position xyz, normal xyz, uv

def fail(msg: str):
    raise SystemExit(msg)

def inspect(path: Path) -> dict:
    data=path.read_bytes()
    if len(data)<HEADER.size: fail("mesh pack shorter than header")
    magic,version,vertex_count,index_count,stride,*bounds=HEADER.unpack_from(data)
    if magic!=MAGIC or version!=VERSION: fail("unsupported mesh pack")
    if stride!=FLOATS_PER_VERTEX*4: fail("unexpected vertex stride")
    if vertex_count<=0 or index_count<=0 or index_count%3: fail("invalid geometry counts")
    vertex_bytes=vertex_count*stride
    index_bytes=index_count*4
    expected=HEADER.size+vertex_bytes+index_bytes
    if len(data)!=expected: fail(f"mesh pack length mismatch: expected {expected}, got {len(data)}")
    if any(not (-3.4028235e38 <= x <= 3.4028235e38) for x in bounds): fail("non-finite bounds")
    mins=bounds[:3]; maxs=bounds[3:]
    if any(a>b for a,b in zip(mins,maxs)): fail("inverted bounds")
    indices=struct.unpack_from(f"<{index_count}I",data,HEADER.size+vertex_bytes)
    if max(indices)>=vertex_count: fail("index references missing vertex")
    return {
        "schemaVersion":VERSION,"topology":"triangles","vertexCount":vertex_count,
        "indexCount":index_count,"vertexStrideBytes":stride,
        "bounds":{"min":list(mins),"max":list(maxs)},
        "bytes":len(data),"sha256":hashlib.sha256(data).hexdigest(),
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("mesh",type=Path)
    ap.add_argument("--json",type=Path)
    args=ap.parse_args()
    info=inspect(args.mesh)
    rendered=json.dumps(info,indent=2,sort_keys=True)
    if args.json: args.json.write_text(rendered+"\n")
    else: print(rendered)

if __name__=="__main__": main()
