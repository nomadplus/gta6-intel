#!/usr/bin/env python3
"""Build a deterministic, non-retail Mission 1 world dependency manifest.

Consumes groups-probe JSON plus optional independent evidence records. It never
reads or copies retail payload bytes. A tile is promoted only when at least two
distinct evidence kinds agree, matching WORLD_INDEX_RESEARCH.md.
"""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path

TILE_MIN, TILE_MAX = 1, 528

def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--probe", type=Path, required=True)
    ap.add_argument("--evidence", type=Path, action="append", default=[])
    ap.add_argument("--out", type=Path, required=True)
    args=ap.parse_args()
    probe=json.loads(args.probe.read_text())
    if probe.get("bytes") != 122770 or not probe.get("sizeMatches"):
        raise SystemExit("groups.dat probe does not match verified 122,770-byte source")
    signals={}
    sources=[]
    for p in args.evidence:
        doc=json.loads(p.read_text())
        kind=doc.get("kind")
        if not kind: raise SystemExit(f"{p}: missing evidence kind")
        sources.append({"kind":kind,"sha256":hashlib.sha256(p.read_bytes()).hexdigest()})
        for tile in doc.get("tiles",[]):
            tile=int(tile)
            if not TILE_MIN <= tile <= TILE_MAX:
                raise SystemExit(f"{p}: invalid tile {tile}")
            signals.setdefault(tile,set()).add(kind)
    promoted=sorted(tile for tile,kinds in signals.items() if len(kinds)>=2)
    report={
      "schemaVersion":1,
      "mission":315,
      "missionName":"Tuesday",
      "policy":"two-independent-signals",
      "probeSha256":hashlib.sha256(args.probe.read_bytes()).hexdigest(),
      "evidenceSources":sources,
      "tiles":[{"id":t,"signals":sorted(signals[t])} for t in promoted],
      "unresolved": len(promoted)==0
    }
    report["manifestSha256"]=hashlib.sha256(canonical(report)).hexdigest()
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(report,indent=2)+"\n")

if __name__=="__main__": main()
