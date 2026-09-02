# render-correctness: adversarial review of the shipped HEARTROT client

## Findings

Six defects, ranked. All are client-only; none needs a program change.

**1 (highest). The gate transition destroys and rebuilds the entire arena.**
`App.tsx:299-303` `useStageHost` resolves `document.getElementById('stage')` in a *passive* effect keyed on `screen`, and `screenOf` (`store.ts:450`) flips `lobby → arena` the instant the authoritative `zone` becomes `ZONE_ARENA`. React reconciles a portal on container identity — `react-dom-client.development.js:6278-6289`, `current.stateNode.containerInfo !== portal.containerInfo` → `createFiberFromPortal`, i.e. delete + remount, never a move. So walking through the gate:
- commits one frame with the portal still pointed at the **detached** Lobby `#stage` (the effect that finds the new node runs after paint) → the stage paints empty;
- then unmounts and rebuilds `SCENE` (16 `<path>`, 332,218 bytes of `d`, 22,195 subpaths), `KNIGHT_POSE_DEFS` (67 KB `innerHTML`, 15 groups, 4,307 subpaths) and `Boss`'s `art` (13 `dangerouslySetInnerHTML` writes over 121,820 bytes) — the spec's own measurement for the temple alone is 46.3 ms to build;
- resets `Boss.prev`, every `Knight` walk odometer, `Spawn.prev`, `cameraFrom`, `usePixelFit`'s ResizeObserver and both rAF loops.
Every "built once at module load, React never walks it again" guarantee in `Scene.tsx`, `Knight.tsx` and `Boss.tsx` is真 for updates and false for exactly this transition.
Fix (smallest): hoist the single `<div id="stage">` out of `Lobby.tsx:42` / `App.tsx:204` into `App`'s `<main>` so the container never changes, and let the two screens style the cell around it. One node, one portal target, no remount.

**2. Every remote knight paints one frame at world (0,0).**
`predict.ts:505-522` `ref(seat)` attaches the node and calls `place(seat, el, now)`, which returns without writing a transform when `tracks.current` has no entry (`seatXY`, line 447-448). Tracks are built in `predict.ts:469-490`, a **passive** `useEffect`. React attaches host refs during the layout phase bottom-up, so the seat `<g>` refs land before `Arena`'s own effects, but the passive effect runs after paint — so on any seat's first mount the `<g>` has no transform and renders at the SVG origin, the top-left corner. Its own comment (`predict.ts:487-488`) claims this is the case it prevents. Reachable whenever a seat becomes occupied, and — compounded with finding 1 — all twenty knights pile into the corner for a frame at the gate.
Fix: `useEffect` → `useLayoutEffect` at `predict.ts:469`. One word.

**3. The idle breathe animation fires once per knight, ever, and then never again.**
`Knight.tsx:285` `const moving = w.d !== 0 && !dead`. `w.d` is a cumulative Manhattan **odometer** (`Knight.tsx:195`: `st.d = step > SNAP ? 0 : st.d + step`) whose only reset is a teleport. So `moving` latches `true` on the first accepted move and stays true for the life of the seat; the `iterations: Infinity` breathe at `Knight.tsx:338` is cancelled at `Knight.tsx:333` and the guard at line 337 (`if (breathe.current !== null) return`) never lets it restart. Net effect: a knight breathes only between mount and its first step, and then only again after a death/respawn (which resets `d` to 0). Nineteen standing raiders during a muster are statues.
Fix: derive "moving" from the *change* in `d` rather than its value — stamp `st.movedAtTick = tick` inside `advance` when `step > 0` and test `tick - w.movedAtTick <= 1`, or keep a `st.stepped` boolean set per fold and cleared when a fold moves nothing.

**4. The gate glow off `predictor.self` does not exist.**
`Arena.tsx:411-421` draws the gate as a static dashed `<rect>` inside `overlay = useMemo(..., [])`. Nothing in `render/` reads `predictor.self` except `selfRef` (`Arena.tsx:299`) and the chase (`:326,:331`) — grep confirms. Spec §6.3 requires the glow to key off prediction precisely because 127 ms on this one interaction reads as input lag, and `Gate.tsx:83-85` states as fact that "the gate lighting under your feet off `predictor.self` — is the renderer's node and the frame loop's alone". It is not written anywhere. Stepping onto the gate currently produces no feedback at all until the authoritative flip: 127 ms write-to-visible plus up to `GATE_RETRY_MS` = 500 ms of poll before `enter_gate` is even sent.
Fix: one `<rect>` sibling of the gate marker, owned by the existing rAF loop (it already holds `predictor.self` and `at`), opacity set from `onGate(at.x, at.y)`. No React state, no second writer.

**5. The local knight's legs and facing lag its own body by a round trip.**
`Arena.tsx:616` passes the **authoritative** `slot` to `<Knight>` while the seat `<g>`'s transform comes from `predictor.self` (`:331`). `advance` accumulates stride from `slot.x/slot.y` and flips from `slot.facing`. The body starts moving ~32 ms after the keypress; the gait and the flip start ~127-160 ms after it, and keep running that long after the player stops. At `MOVE_STEP` 16 u per 50 ms slot that is ~2 tiles of visible desync between where the knight is and what its legs are doing — the split the file is built on, applied to position but not to the pose that describes it.
Fix: for the predicted seat only, feed `advance` a slot whose `x`/`y`/`facing` come from `predictor.self` (`self.facing` is already maintained on push and reconcile, `predict.ts:221,248`). Everything else on the slot stays authoritative.

**6. The bullet layer re-attaches 32 refs on every render.**
`Arena.tsx:515-518` is an inline arrow ref, so React detaches (`ref(null)` → `Map.delete`) and re-attaches (`Map.set`) all 32 `<line>` nodes on every render of `Arena` — roughly 370 renders/s post-dedupe at 20 seats, ~12k Map operations/s, for nodes that did not move in the tree. The seat layer deliberately avoids exactly this with the cached per-seat callback at `predict.ts:505-522`.
Fix: the same cached-callback pattern, keyed on slot.

Minor, listed for completeness, each a one-liner:
- `Arena.tsx:269` calls `useSeatInterpolation(players, reduced)` and never passes the `tickMs` prop it already has, so the interpolation **ceiling** is the hard-coded `TICK_MS` default rather than `match.tickMs`. Same class: `useSeeked` computes `elapsed` from the `tickMs` prop (`Arena.tsx:378,383`) but its duration from the `TICK_MS` constant (`:198`); the two disagree if the worker ever reports anything but 100.
- `Boss.tsx:165` `.hr-boss-eye:nth-of-type(2)` — `nth-of-type` counts `<circle>` siblings, and the vent circle (`Boss.tsx:379`) is `circle:nth-of-type(1)`. The −0.35 s offset lands on the first eye, not the second. Both still animate; the intent is just aimed one element off.
- `subscribe.ts` never resets `previousPlayers` on socket `open`, so the spec's §7.4 `synced` gate is absent. Harmless today because `App.tsx:592` ignores the second argument entirely — but every `Knight`/`Boss` diff after a reconnect is taken against a snapshot up to 1,681 ms stale, which fires one flash/recoil/flinch per changed field. One-shot, not a storm; note it before anything starts consuming that argument.

## Evidence

Decoders, checked byte for byte against the Rust — CLEAN, a negative result worth recording so nobody re-derives it:
- `layout.ts:149-262` vs the `const _: () =` assertion blocks in `state.rs:313-321` (Bullet), `:436-459` (Arena), `:787-802` (Boss), `:865-883` (PlayerSlot), `:932-939` (Players), `:968-975`/`:1012-1021` (Leaderboard). All 60+ offsets, all four sizes (8 / 1200 / 50 / 96 / 1924 / 48 / 6176) and every signedness (`getInt16` for x/y and bullet dx/dy, `getUint16` for hp/parts, `getUint32` for ticks, `getBigUint64` for `arena_id`) agree exactly. `fight_at_tick` at 1164 and `roll_requested_tick` at 1160 are both right, and `layout.ts:113` `ROLL_TIMEOUT_TICKS = ticksFor(10_000)` — the stale `25` the spec flags is already fixed.
- `decodePlayers` (`layout.ts:486-508`) synthesises `seat` from the loop index and `occupied` from `isZero(sessionPubkey)`, which is the Rust sentinel (`state.rs:857-858`). Correct.

Generated-table mirrors, checked mechanically — CLEAN:
- I expanded `map.rs::WALLS` (64 × u64 bitboard) against `map.ts::MAP_GRID` (64 strings) tile by tile: **0 mismatches over 4,096 tiles**. `BOSS_SPAWN (512,400)`, `PIT_TOP 384`, `PIT_BOT 607`, `GATE_MIN_X/MAX_X/MIN_Y/MAX_Y 480/543/608/639` identical on both sides. `P` rows 24..37, `B` at tile (32,25), `G` rows 38..39 — exactly the §1.1 grid. (The grid holds 721 `P` tiles against the spec's stated 718; a doc drift, not a render bug.)
- `layout.ts::slamLane` (`:666-676`) vs `tick.rs::slam_lane` (`:470-495`): same `mix64` constants, same `le64(seed[..8]) ^ mix64(tick / SLAM_PERIOD_TICKS)`, same `r & 1` limb pick, same `MACE_LANE_FIRST 1 / COUNT 3`, `CLAWS_LANE_FIRST 5 / COUNT 2`, `SLAM_VENT_LANE 4`, same dead-limb → `None`. Bit for bit.
- `hitboxes.ts` and `hitboxes.rs` come out of one `gen_hitboxes.py` pass; `Boss.tsx:409-425`'s import-time check re-proves the art↔table binding (13 groups, 9 indexed names, unit `OUTWARD` headings) and would throw on drift.

Duplicate-proofing, checked against the 68.4%-no-change / delivered-twice feed — CLEAN:
- `subscribe.ts:251-254` drops byte-identical base64 per account kind before the decoder, and clears the cache on every `open` (`:379`) while still counting a duplicate as liveness (`:335-340`). All three constraints the spec names are met.
- `Knight.tsx::advance` (`:186-222`) is pure value-diff: `hp <`, `deaths >`, `lastShotTick >`. `Boss.tsx:265` `if (after === before) continue`. `Spawn.tsx:98-100` `prev !== null && prev !== next`. `useSeeked` (`Arena.tsx:690`) dedupes on the countdown value, not on arrival. I could not construct a duplicate payload that fires anything.

Node-ownership audit — one writer per animated property everywhere I could reach:
`#camera` (WAAPI only, `Arena.tsx:352-367`), seat `<g>` (rAF or `useSeatInterpolation`, never React), `Knight`'s body `<g>` (WAAPI one-shots + breathe, both WAAPI so they compose rather than one being discarded), `.hr-boss` (React attr) → `.hr-boss-breathe` (CSS keyframes) → `.hr-boss-shell` (WAAPI death) → part groups (WAAPI one-shots, with `transform-box: fill-box` + `transform-origin: center` present at `Boss.tsx:228`). The bullet `<line>` carries both a React inline `style.transform` and a rAF `style.transform`, but both are plain inline writes, not the WAAPI-vs-inline case that silently discards — that one is not present anywhere.

Listener and loop lifecycle — CLEAN: `controls.ts:374-391` pairs every add with a remove plus `clearInterval`; `Spawn.tsx:173-190` removes both skip listeners and cancels the animations; both rAF loops (`Arena.tsx:340`, `predict.ts:502`) cancel; `usePixelFit` disconnects its ResizeObserver (`:740`); `useGateEntry` clears its interval (`App.tsx:494`). `nodes`/`tracks`/`callbacks` maps are bounded by 128 bullets and 20 seats. No leak found.

Render-storm audit — CLEAN: all 52 `useSelect` call sites return primitives or references that already live in the state object; none builds a fresh object or array, so none can loop `useSyncExternalStore`. `setWorld` (`store.ts:408`) replaces only the account that changed, so the per-account selectors stay `Object.is`-equal.

React version confirmed 19.2.8 (`app/package.json:18`), and the portal-remount claim in finding 1 was read out of the installed `react-dom-client.development.js`, not recalled.

Asset volumes for finding 1, measured on disk: `assets/sprites/temple.svg` 332,218 B / 16 paths / 22,195 subpaths; `assets/sprites/parts/boss.svg` 121,820 B / 13 `part-*` groups; `app/src/render/knights.gen.ts` 67,451 B carrying 15 `<g id="kN-pose">` (ids verified to match `knightPoseId`'s `k{skin}-{pose}` exactly, all 15 present).

Not run: no browser, so nothing here is a frame-time measurement. Findings 1, 2 and 5 are traced mechanisms with byte counts and a source-verified reconciler path, not profiled costs — the same honesty limit `docs/perf` puts on the `subscribe.ts` dedupe.

## On-chain

Nothing in this report is on chain, and none of the six fixes touches the program, an account layout, `LAYOUT_VERSION` or the wire ABI. That is the point of the boundary the spec draws, and every finding sits on the cosmetic side of it:

- Findings 1 and 2 are *when React builds DOM nodes* — a portal container identity and an effect's priority. Twenty clients rendering this differently still agree on every fact; a client that renders none of it is playing the same game on the same tick.
- Finding 3 is a breathing loop. §7.5 forbids an animation clock, phase or is-playing flag outright, and the fix keeps it that way: "is this seat moving" stays derived from a position delta the client already holds on both paths. It must NOT become an `is_moving` byte on `PlayerSlot` — that is the second prohibition in §7.5 by name, and a chain flag would arrive one round trip after the movement it describes.
- Finding 4's glow is client-local by construction. The *transaction* it hints at (`enter_gate`, tag 5) already exists and already stays on the 500 ms authoritative poll (`App.tsx:461-495`); the fix adds a drawn rectangle, not a send. These two must stay separate — the version that fired `enter_gate` from the input callback stranded players permanently, and `useGateEntry`'s own comment records that.
- Finding 5 is which *copy* of a seat the pose reads from. `predictor.self.facing` is already maintained client-side from the same `dir` the `move` instruction carries; no new field, no new byte, and the authoritative `facing` stays what every remote client draws.
- Finding 6 is a ref callback.

The one thing here that is chain-adjacent and was checked rather than changed: the decoders, the `MAP_GRID`/`WALLS` mirror and `slamLane` are the three places where a client copy disagreeing with the program is a silent desync rather than a cosmetic bug. All three are exact — I diffed the offsets against `state.rs`'s `offset_of!` assertions, expanded the wall bitboard tile by tile, and read `slam_lane` against its TS mirror line for line. The `VISIBLE_BULLETS = 32` cap (`Arena.tsx:125`) caps drawing only; `MAX_BULLETS` stays 128 in `layout.ts:28` and `bullets_per_volley = 3 + alive_count` is untouched, which is the correct side of "cap drawing, never simulation".

## Risks

- Finding 1's fix moves `#stage` out of `Lobby.tsx` and `App.tsx`'s `ArenaScreen`. Both screens style the stage cell through their own grid, so the layout has to be re-checked on both — and `usePixelFit` measures the portal's parent box, so a stage that ends up sized differently changes the crisp/geometricPrecision switch at `Arena.tsx:464`.
- Finding 2's `useEffect` → `useLayoutEffect` at `predict.ts:469` makes a 20-seat loop plus 20 transform writes run synchronously before paint at up to ~370 notifications/s. It is the same work, moved earlier, but it now blocks paint instead of following it. If the frame budget is tight this is the first thing to re-measure — the cheaper alternative is to build the track inside the `ref` callback itself from the slot the caller already has.
- Finding 3's fix changes what `moving` means, and `moving` is a dependency of the breathe effect. Getting it wrong the other way — a `moving` that never becomes true — starts twenty infinite composited animations that the walk was supposed to cancel, which is worse than no breathing. Leave `Knight.tsx`'s existing self-check in place and add one case: fold two moves, then fold a no-op, and assert the seat reads as not moving.
- Finding 5 gives the predicted seat a synthesised slot. If that object is allocated per render it defeats `Knight`'s `seen.current !== slot` identity guard (`Knight.tsx:259`) and `advance` would run on every render instead of every payload — double-counting `shots` and `hurts` at the render rate. It has to be a mutated stable object, or the guard has to move off object identity.
- Findings 1 and 2 both hide behind React's commit ordering, which I read out of the installed 19.2.8 development build rather than observed in a browser. The portal path is unambiguous source (`containerInfo !== portal.containerInfo` → new fiber); the 'one painted frame' half of both is an inference from passive-effect scheduling and should be confirmed with a screenshot at the gate before anyone claims a visual fix landed.
- No browser was run for any of this. Every frame-time number quoted is from `docs/perf`, and the asset byte counts are from disk. Findings 1, 2 and 5 name a mechanism and a volume, not a measured cost.
- Six of these fixes touch four files that the animation contract deliberately keeps apart (`Arena.tsx`, `Knight.tsx`, `predict.ts`, `App.tsx`). Landing them as one commit makes the diff unreviewable and re-opens the two-writers question; 1+2 are one commit (mount correctness), 3+5 another (the gait), 4 and 6 stand alone.