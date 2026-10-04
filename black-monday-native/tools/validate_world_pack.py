#!/usr/bin/env python3
"""Validate a converted Mission 1 world pack before the native runtime consumes it.

This validator operates only on generated metadata and converted artifacts. It
never infers world tiles from mission numbers and never needs retail bytes in
Git.
"""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path

POLICY = "two-independent-signals"

def sha256(path: Path) -> str:
    h=hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda:f.read(1024*1024), b""): h.update(block)
    return h.hexdigest()

def fail(msg: str):
    raise SystemExit(msg)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--world-manifest", type=Path, required=True)
    ap.add_argument("--pack-manifest", type=Path, required=True)
    ap.add_argument("--pack-root", type=Path, required=True)
    args=ap.parse_args()

    world=json.loads(args.world_manifest.read_text())
    pack=json.loads(args.pack_manifest.read_text())
    if world.get("mission") != 315 or world.get("policy") != POLICY or world.get("unresolved") is not False:
        fail("world manifest has not passed the Mission 315 evidence gate")
    promoted={int(x["id"]) for x in world.get("tiles",[])}
    if not promoted: fail("world manifest promotes no tiles")
    if pack.get("schemaVersion") != 1 or pack.get("mission") != 315:
        fail("invalid converted pack contract")
    tiles=pack.get("tiles")
    if not isinstance(tiles,list) or not tiles: fail("converted pack has no tiles")
    seen=set()
    for item in tiles:
        tile=int(item.get("id",-1))
        if tile not in promoted: fail(f"tile {tile} was not promoted by world evidence")
        if tile in seen: fail(f"duplicate tile {tile}")
        seen.add(tile)
        src=item.get("sourceSha256","")
        if len(src)!=64 or any(c not in "0123456789abcdef" for c in src):
            fail(f"tile {tile}: invalid source SHA-256")
        rel=item.get("mesh")
        if not isinstance(rel,str) or rel.startswith("/") or ".." in Path(rel).parts:
            fail(f"tile {tile}: unsafe mesh path")
        mesh=args.pack_root/rel
        if not mesh.is_file(): fail(f"tile {tile}: missing converted mesh")
        expected=item.get("meshSha256","")
        actual=sha256(mesh)
        if actual != expected: fail(f"tile {tile}: converted mesh hash mismatch")
        vertices=int(item.get("vertexCount",0)); indices=int(item.get("indexCount",0))
        if vertices<=0 or indices<=0 or indices%3: fail(f"tile {tile}: invalid triangle geometry counts")
        sections=item.get("sections",[])
        if not isinstance(sections,list) or not sections: fail(f"tile {tile}: missing decoded sections")
        for s in sections:
            off=int(s.get("offset",-1)); size=int(s.get("size",-1)); source_size=int(item.get("sourceBytes",-1))
            if off<0 or size<=0 or source_size<=0 or off+size>source_size:
                fail(f"tile {tile}: section outside source bounds")
    missing=promoted-seen
    if missing: fail(f"converted pack missing promoted tiles: {sorted(missing)}")
    print(f"Mission 1 converted world pack OK: {len(seen)} tile(s)")

if __name__=="__main__": main()
