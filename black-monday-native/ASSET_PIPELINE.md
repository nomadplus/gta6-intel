# Retail asset provenance and conversion contract

This file records only facts already established from the retail file inventory. It deliberately separates **verified structure** from hypotheses so the native port does not hard-code the earlier 315.big = Mission 315 mistake.

## Verified source set
- Google Drive folder `BlackMondayParts` contains 12 split 7z parts.
- Parts 001–011 are 209,715,200 bytes each; part 012 is 204,195,600 bytes.
- Combined split-archive size: 2,511,062,800 bytes.
- The native repository does not commit copyrighted retail payloads. Conversion output is expected to be produced from the user's own source files.

## Corrected retail layout
- `bigfiles/1.big … 528.big`: London world/map tiles. **315.big is not Mission 315.**
- `bigfiles/groups.dat`: 122,770-byte file; current working hypothesis is a world/tile grouping index. That role must be proven by parsing/cross-reference before runtime use.
- `tegfiles/1 … 2537.teg`: texture corpus (~1.18 GB), not a one-texture-pack-per-world-tile mapping.
- `missions/315.bin`: Mission 1, “Tuesday”; mission reverse engineering has 183 script/logic pairs in scope.

## Pipeline rule
Every converter must be deterministic and emit provenance: source relative path, source hash, converter version, output hash, coordinate transform, and warnings. Unknown fields are preserved or logged, never silently guessed.

## Next decoder target
Resolve `groups.dat` enough to map Mission 1 references/coordinates to the actual London tile set, then feed only those tiles into the first native vertical slice. Geometry/texture decoding follows that dependency graph rather than guessing from numeric filenames.
