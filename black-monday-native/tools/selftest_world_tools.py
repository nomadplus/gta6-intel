#!/usr/bin/env python3
"""Self-test Black Monday native world-index tooling without retail payloads."""
from __future__ import annotations
import json, subprocess, sys, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent
PROBE=ROOT/"groups_probe.py"
BUILD=ROOT/"build_world_manifest.py"

def run(*args):
    return subprocess.run([sys.executable,*map(str,args)],capture_output=True,text=True)

with tempfile.TemporaryDirectory() as td:
    d=Path(td)
    groups=d/"groups.dat"; groups.write_bytes(bytes(122770))
    probe=d/"probe.json"
    r=run(PROBE,groups,"--out",probe); assert r.returncode==0,r.stderr
    p=json.loads(probe.read_text()); assert p["sizeMatches"] and p["bytes"]==122770

    a=d/"a.json"; b=d/"b.json"; c=d/"c.json"
    a.write_text(json.dumps({"kind":"groups-index","tiles":[12,40]}))
    b.write_text(json.dumps({"kind":"mission-coordinate","tiles":[12,41]}))
    c.write_text(json.dumps({"kind":"loader-trace","tiles":[12]}))
    out=d/"manifest.json"
    r=run(BUILD,"--probe",probe,"--evidence",a,"--evidence",b,"--evidence",c,"--out",out)
    assert r.returncode==0,r.stderr
    m=json.loads(out.read_text())
    assert [x["id"] for x in m["tiles"]]==[12],m
    assert m["tiles"][0]["signals"]==["groups-index","loader-trace","mission-coordinate"]
    assert m["unresolved"] is False and len(m["manifestSha256"])==64

    # One evidence kind repeated must not satisfy the independent-signal gate.
    same=d/"same.json"; same.write_text(json.dumps({"kind":"groups-index","tiles":[40]}))
    out2=d/"manifest2.json"
    r=run(BUILD,"--probe",probe,"--evidence",a,"--evidence",same,"--out",out2)
    assert r.returncode==0,r.stderr
    assert json.loads(out2.read_text())["unresolved"] is True

    bad=d/"bad.json"; bad.write_text(json.dumps({"kind":"mission-coordinate","tiles":[529]}))
    r=run(BUILD,"--probe",probe,"--evidence",bad,"--out",d/"bad-out.json")
    assert r.returncode!=0

print("world tooling self-test: PASS")
