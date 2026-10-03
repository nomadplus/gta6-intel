# The Getaway: Black Monday — Native Web/iOS Reconstruction

This branch is the ground-up reconstruction path. It does **not** emulate the PS2 CPU/GPU.

## Goal

Rebuild the retail game faithfully from original Black Monday assets/data, then freeze a verified baseline before beginning remake/mod work.

## Runtime architecture

- WebGL2 renderer first, with a future WebGPU backend where supported.
- Fixed-timestep gameplay simulation decoupled from presentation.
- Native browser input layer with keyboard + touch/controller abstraction.
- Streaming world/chunk manager for London map sectors.
- Converted runtime assets rather than reading PS2 GPU formats directly while playing.
- Mission/event graph reconstructed from original mission scripts.
- Deterministic test scenes used before Mission 1 integration.

## Milestones

1. Runtime skeleton boots and renders independently of Play!/PS2 emulation.
2. Asset inventory + repeatable conversion pipeline.
3. Mission 1 opening-area geometry/materials loaded natively.
4. Player camera/movement/collision and touch controls.
5. Vehicle vertical slice.
6. Mission/event execution and Mission 1 playable start-to-finish.
7. Expand engine coverage across the retail campaign/free roam.
8. Freeze faithful retail baseline.
9. Branch the completed baseline for remake/mod improvements.

## Branch policy

`black-monday-native-web` is the faithful implementation branch.

PS2-emulation experiments remain separate and are retained only as behavioural/reference material. Remake-only features do not enter this branch until the faithful baseline is frozen.
