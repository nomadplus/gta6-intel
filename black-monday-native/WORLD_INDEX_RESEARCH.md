# World-index research

Goal: identify which London world chunks Mission 1 actually requires without
assuming that mission number 315 maps to `bigfiles/315.big`.

## Evidence workflow

1. Extract the user's retail archive outside the repository.
2. Verify `bigfiles/groups.dat` is exactly 122,770 bytes.
3. Run `python3 black-monday-native/tools/groups_probe.py <.../bigfiles/groups.dat> --out groups-probe.json`.
4. Preserve the generated JSON as research evidence only; never commit retail bytes.
5. Compare candidate integer/record layouts with references observed in world
   loaders and mission spawn/location data.
6. Only promote a tile dependency into the runtime manifest when two independent
   signals agree (for example groups index + coordinate/location evidence).

## Current facts

- `missions/315.bin` is Mission 1 ("Tuesday").
- `bigfiles/315.big` is world tile 315; the shared number is coincidental.
- `groups.dat` is 122,770 bytes. Its exact semantics are not yet verified.
- World geometry spans `bigfiles/1.big` through `528.big`.
- Texture payloads span 2,537 TEG files and cannot be assumed to share tile IDs.

The probe intentionally performs structural analysis only. It does not claim a
format until the output is correlated with loader/coordinate evidence.
