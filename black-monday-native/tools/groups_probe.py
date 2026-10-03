#!/usr/bin/env python3
"""Structural probe for Black Monday bigfiles/groups.dat.

No retail bytes are committed. Run against an extracted, user-owned game tree.
Produces JSON evidence for candidate record widths/endian interpretations so
world-tile indexing can be decoded reproducibly rather than guessed.
"""
from __future__ import annotations
import argparse, json, math, struct
from collections import Counter
from pathlib import Path

EXPECTED_SIZE = 122770
TILE_MIN, TILE_MAX = 1, 528

def ints(data: bytes, width: int, endian: str):
    usable = len(data) - (len(data) % width)
    fmt = {2:"H",4:"I"}[width]
    return struct.unpack(endian + fmt * (usable // width), data[:usable])

def score(vals):
    c=Counter(vals)
    in_tiles=sum(TILE_MIN <= v <= TILE_MAX for v in vals)
    zeros=c.get(0,0)
    return {
      "count":len(vals),"tileRangeHits":in_tiles,
      "tileRangeRatio":round(in_tiles/max(1,len(vals)),6),
      "zeros":zeros,"unique":len(c),
      "top":[{"value":v,"count":n} for v,n in c.most_common(12)]
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("groups_dat", type=Path)
    ap.add_argument("--out", type=Path)
    args=ap.parse_args()
    data=args.groups_dat.read_bytes()
    report={
      "file":args.groups_dat.name,"bytes":len(data),
      "expectedBytes":EXPECTED_SIZE,"sizeMatches":len(data)==EXPECTED_SIZE,
      "headHex":data[:64].hex(),"tailHex":data[-64:].hex(),
      "interpretations":{}
    }
    for width in (2,4):
      for endian,name in (("<","le"),(">","be")):
        report["interpretations"][f"u{width*8}{name}"]=score(ints(data,width,endian))
    # Candidate fixed record widths: report exact remainder and count.
    report["recordWidths"]=[
      {"width":w,"records":len(data)//w,"remainder":len(data)%w}
      for w in range(2,257)
      if len(data)%w in (0,2,4,6,8)
    ]
    text=json.dumps(report,indent=2)
    if args.out:
      args.out.parent.mkdir(parents=True,exist_ok=True); args.out.write_text(text+"\n")
    else: print(text)

if __name__=="__main__": main()
