# Mission 1 native world conversion gate

This stage converts only world chunks that have already passed the evidence gate in `build_world_manifest.py`.

## Input contract

The converter must consume a generated manifest whose `mission` is 315, `policy` is `two-independent-signals`, and `unresolved` is false. It must never infer a chunk from the mission number or filename similarity.

For each promoted tile `N`, the retail input is `bigfiles/N.big`. Retail bytes remain outside Git. Converted runtime output is written under a generated build directory and is identified by source SHA-256 plus converter version.

## First geometry milestone

For the Mission 1 opening area, conversion is accepted only when all of these are recorded:

- verified promoted tile IDs and their independent evidence kinds;
- source SHA-256 for each consumed `.big`;
- decoded section table/offsets with bounds checks;
- vertex/index counts and primitive topology;
- coordinate-system transform documented explicitly;
- deterministic converted-mesh hash;
- native WebGL loader can reject malformed/out-of-contract data.

Textures remain a separate mapping problem: `tegfiles/1..2537.teg` are not assumed to share world tile IDs.

## Non-negotiable regression rule

`missions/315.bin` is the Mission 1 script container. `bigfiles/315.big` is merely world tile 315. The converter may consume tile 315 only if the evidence manifest independently promotes tile 315.
