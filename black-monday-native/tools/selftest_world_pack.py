#!/usr/bin/env python3
"""Self-test the Mission 1 converted-world-pack contract without retail payloads."""
from __future__ import annotations
import hashlib, json, subprocess, sys, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent
VALIDATE=ROOT/"validate_world_pack.py"

def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run(*args):
    return subprocess.run([sys.executable,*map(str,args)],capture_output=True,text=True)

with tempfile.TemporaryDirectory() as td:
    d=Path(td)
    pack_root=d/"pack"; pack_root.mkdir()
    mesh=pack_root/"tile-12.mesh"
    mesh.write_bytes(b"BMNW-MESH-V1\0synthetic")
    world={
        "mission":315,
        "policy":"two-independent-signals",
        "unresolved":False,
        "tiles":[{"id":12,"signals":["groups-index","mission-coordinate"]}],
    }
    world_path=d/"world.json"; world_path.write_text(json.dumps(world))
    good={
        "schemaVersion":1,
        "mission":315,
        "tiles":[{
            "id":12,
            "sourceSha256":"0"*64,
            "sourceBytes":4096,
            "mesh":"tile-12.mesh",
            "meshSha256":digest(mesh),
            "vertexCount":3,
            "indexCount":3,
            "sections":[{"offset":64,"size":128}],
        }],
    }
    pack=d/"pack.json"; pack.write_text(json.dumps(good))
    r=run(VALIDATE,"--world-manifest",world_path,"--pack-manifest",pack,"--pack-root",pack_root)
    assert r.returncode==0,(r.stdout,r.stderr)

    # A tile not independently promoted by the world evidence gate is forbidden.
    bad=dict(good); bad["tiles"]=[dict(good["tiles"][0],id=315)]
    bad_path=d/"bad-tile.json"; bad_path.write_text(json.dumps(bad))
    assert run(VALIDATE,"--world-manifest",world_path,"--pack-manifest",bad_path,"--pack-root",pack_root).returncode!=0

    # Tampering with converted bytes must be caught by the deterministic hash.
    mesh.write_bytes(b"tampered")
    assert run(VALIDATE,"--world-manifest",world_path,"--pack-manifest",pack,"--pack-root",pack_root).returncode!=0

    # Section ranges may never escape the original retail source bounds.
    mesh.write_bytes(b"BMNW-MESH-V1\0synthetic")
    oob=dict(good); oob["tiles"]=[dict(good["tiles"][0],sections=[{"offset":4090,"size":32}])]
    oob_path=d/"oob.json"; oob_path.write_text(json.dumps(oob))
    assert run(VALIDATE,"--world-manifest",world_path,"--pack-manifest",oob_path,"--pack-root",pack_root).returncode!=0

print("world pack validator self-test: PASS")
