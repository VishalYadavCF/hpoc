# Voice: telephony-first vertical slice (§12.2/§12.3)

## Context

Workload class 6 (voice) is the last entirely-unbuilt class. Today it is **schema and
documentation only** — 2 tables (`speech_providers` db/schema.sql:308, `agent_version_speech`
:535), the `speech_kind` / `transport.voice_*` / `enforcement_level.speech_provider` enums,
`usage_ledger.kind` permitting `'speech_seconds'`, `memory_records.delivered` +
`.played_offset_ms` (:1279), and a fully designed API surface in `ai-docs/api-spec.md` §14.

**Zero application code.** No port, no adapter, no service, no controller. Neither speech
table is in `src/platform/persistence/schema.types.ts`, so `db.selectFrom('speech_providers')`
does not currently type-check.

Two things make this unlike the gaps closed recently:

1. **No consumer exists.** All three `ai-docs/client-interactions/` docs are text. The sandbox
   work had consumer 03 defining "done"; voice has nobody. So step one writes
   `04-voice-agent.md` to make the latency budget, barge-in expectations and capacity ceilings
   into acceptance criteria instead of a vibe.
2. **Voice forces two pieces of unfinished platform work** the docs do not admit are missing:
   model token streaming, and a real `relaxed` durability tier.

### Decisions taken with the user

| | |
|---|---|
| Scope | Vertical slice, **telephony-first**, deterministic fake STT/TTS. Browser WebRTC deferred behind the same port. |
| Token streaming | **Included** — clause-boundary chunking is impossible without it. |
| `relaxed` durability | **Implemented properly**, including the crash/reconciliation semantics §4.3 demands and nobody has written. |
| Barge-in + §6.3 fidelity | **Both**, as one mechanism. |
| Process topology | **New dedicated `voice` process** (4th deployable). |
| Definition of done | Write the missing consumer profile first. |

---

## Pre-existing defects that voice exposes

Verified in this repo. Each is a latent bug today and a blocker for voice. Fix in Phase 0.

1. **`relaxed` runs cannot resume at all — they dead-letter.** `relaxed` is one `if`
   (`run-loop.service.ts:1444`) that writes *no* checkpoint. On crash, resume finds
   `restored === null` → `stepSeq = 0` → `openStep` inserts `seq = 1` → violates
   `UNIQUE (run_id, seq)` (db/schema.sql:909) → abort → `fail()` → dead-letter. The tier is
   broken on its only interesting path.
2. **§4.5's indeterminate-side-effect guard is dead code.**
   `assertNoIndeterminateInvocations` looks for `tool_invocations.status='running'`, but that
   marker is written *inside the step transaction* that also makes the sandbox call
   (`tool-runtime.service.ts:191`). A crash rolls the marker back, so the row it searches for
   can never exist. The marker must be written in its own committed transaction before the
   call. **Voice makes this load-bearing** — barge-in turns "interrupted mid-tool-call" from
   exceptional into routine.
3. **`EventLog.append` holds the `runs` row lock for the whole step.** It does
   `UPDATE runs SET last_event_seq = last_event_seq + 1` (`event-log.service.ts:50`) inside the
   step transaction, which spans `gateway.complete()`. So `POST /runs/:id/cancel` blocks for
   the remaining duration of an in-flight model call. **Consequence: a barge-in signal can
   never travel through the event log synchronously** — it must be in-process.
4. **`remember()` is never called from `fail()`** — only from `complete()`
   (`run-loop.service.ts:1589`). A run that ends by cancellation or lease loss writes no
   conversational memory, even though the user received output.
5. **`delivered` is never filtered on anywhere.** `MemoryFilter` has no such field and
   `recall()` has no such predicate. §6.3 is enforced today only by the accident that
   `remember()` runs on completion.

---

## Architecture

### 1. A voice turn runs *beside* the queue-based run loop, not through it

The deciding argument is topology, not latency. TTS audio must reach one specific TCP socket,
terminated by one process. `run_queue` hands a run to *whichever* worker claims it, and that
worker has no path to the media plane — you would need a second fan-out carrying audio, which
`ai-docs/decisions/0001-event-storage.md:93` and the 8 KB NOTIFY cap both forbid. Once the
socket-holding process must drive the turn, a lease is answering a question already answered
outside the database.

Latency confirms it: `drive()` costs 10–14 round trips before the first token, in a budget
whose metric is time-to-first-syllable.

A `VoiceSessionRunner` owns the socket and drives turns directly, **reusing** `AdmissionService`
+ `AgentVersionService` (session open goes through the identical admission path),
`RunStreamService.attach()` for the control-plane SSE (no new streaming code),
`BackpressureService.admit()`, `ModelGateway`, `MemoryEngine`, `FrameworkAdapter.advance()`,
and `withTenantConnection`. It does **not** use `run_queue` or `RunLoop.drive()`.

**What that costs, stated plainly:** two drive loops that can drift (mitigated structurally in
Phase 0 by extracting shared pieces *before* the second loop exists, not by promising
discipline); no `assertHeld` fencing (replaced by `voice_sessions.media_epoch` — every durable
write is `UPDATE ... WHERE media_epoch = $n`, zero rows → `LeaseLost`); no retry or
dead-lettering for voice runs (correct, but ops views assuming "every failed run has a dead
letter" must special-case `transport LIKE 'voice_%'`); and no delegation, peer calls or HITL
approval inside a turn in this slice — those return a typed refusal observation.

### 2. One run per call, not per turn

`api-spec.md` §14 says `POST /v1/voice/sessions` "opens a session and starts a `relaxed`-tier
run" — singular. And decisively: **if one run were one turn, the `relaxed` tier would have
nothing to batch**; §4.3 exists precisely because a run spans many turns. Turns therefore live
in their own table, and `thread.messages()` gains a voice projection.

### 3. Never store the untruncated assistant turn

`MemoryEngine.amend()` deliberately excludes `content` (`memory.engine.ts:257-265`) because the
embedding was computed from it. Three options were considered; the other two are traps:
relaxing `amend()` contradicts that reasoning, and *superseding* keeps both records — putting
text the caller never heard into `memory_records.content`, which is the exact §6.3 violation
and a compliance failure for regulated voice.

Instead, the memory write happens at **turn commit**, by which time truncation is already a
known fact. `content` is the delivered text at birth. **Zero change to `amend()`.** If nothing
was played, write no memory row at all — only a `voice_turns` row with `delivered = false`.

The invariant, enforced: **the event log holds what was generated; memory holds what was
delivered.** The truncated tail is already retained in `ModelCompleted` (`run-loop.service.ts:1229`),
so nothing extra is needed for debugging.

### 4. `played_offset_ms` must be honest

Bytes-written-to-socket is **not** a proxy for bytes-heard — TCP accepts seconds of μ-law in
milliseconds, and the carrier buffers. So writes are **paced**: never more than
`PLAYOUT_LEAD_MS` (default 200) ahead of the media clock, making that constant the documented
error bar, stored on the session row so a forensic read knows it. μ-law 8 kHz is exactly
8000 bytes/s, so frame duration is arithmetic — **this is why telephony-first is the right
slice**, unlike Opus.

ms→character mapping cannot be recovered after the fact; the synthesizer emits
`{charStart, charEnd}` per frame. **Truncate at the last fully-played clause boundary** — never
interpolate inside a clause, because TTS is not uniform in time ("£42.50" is 6 chars and ~1.5s).
Under-reporting is the safe direction under §6.3.

### 5. Barge-in cancels *speech*, never *effects*

`AbortSignal` is plumbed to `ModelGateway.stream` → `provider.stream` → `fetch`, **and to the
TTS stream — explicitly not to `ToolRuntime.execute`, the sandbox, or MCP.** Aborting a
non-idempotent request in flight leaves the outcome genuinely unknown, and §4.5's stated
position is that the platform does not pretend about that. A user interrupting while a payment
link is sent gets: the tool completes, the invocation is recorded, only the *spoken* result is
discarded. Stopping a side effect is `humanApprovalRequired` (§14), not barge-in.

Barge-in is **not** a new run status (the run is still `running`; it is the utterance that
ended). It reuses `step_status = 'cancelled'` and adds a `voice.turn.truncated` event.

### 6. `relaxed` = checkpoint at *turn* boundaries, not on a timer

Bound the loss window by the conversational turn, because that is the unit of meaning and it
coincides with the instant delivered content becomes known — so §4.3 and §6.3 collapse into one
write point, at zero perceived latency (the user is already speaking). Time and step caps exist
only as safety valves. **A turn is buffered as `open` and only becomes flushable on reaching a
terminal state, so a partially-recorded turn cannot exist by construction.**

**The sharpest risk in the whole plan:** the flush must keep an epoch assertion in its
transaction. Dropping it looks like an optimisation ("it's only a checkpoint") and converts a
bounded-loss tier into a **silent-divergence** tier — a stalled worker's late flush overwrites
a reclaimed run's newer state, and `CheckpointService.latest()` (`checkpoint.service.ts:109`)
orders by `step_seq DESC` with no epoch column to notice. Batched checkpoints therefore need
`lease_epoch` on the `checkpoints` table.

**A dropped call must not resume.** The socket died with the worker; there is nothing to resume
into, and generic recovery would re-execute effects with nobody on the line. Terminal state is
**`cancelled`, not `failed`** — `state-machine.ts:17` makes `failed` retryable by design, which
is exactly the semantics to avoid. A reconciler writes an explicit **gap marker**
(`delivered = false`, no memory row) rather than a fabricated turn or silent absence.

---

## Phases

Each is independently shippable and reviewable.

**Phase 0 — seams and pre-existing fixes (no voice code).**
`src/platform/clock.ts` injected everywhere voice will touch (retrofitting a clock later is what
makes voice suites permanently flaky). Add the four tables to `schema.types.ts` + `Database`;
narrow `agent_versions.transport` from `string` to the enum union. Migration
`0024_voice_sessions.sql` → mirror into `db/schema.sql` → `db:prisma:sync` → `db:drift`. Plumb
`playedOffsetMs` through `memory.port.ts` → `memory.engine.ts` → `postgres.memory-store.ts`
(first ever read/write of that column). De-hardcode `delivered` in `remember()`. Extract
`resolveTarget()` from `ModelGateway.complete()` so the residency gate is one statement shared
by both paths. Fix `BackpressureService.concurrency()` for `speech_provider`, and add a
`backpressure_unenforced_level_total{level}` counter — a policy row that silently does nothing
is worse than none. **Fix defects 1, 2 and 4 above.**
*Verifies:* `npm run verify` green, zero behaviour change.

**Phase 1 — model token streaming.** `stream?()` and `signal?` added to `ModelProvider` as
**optional**, so all four providers keep compiling untouched and `runModelStep` is not modified.
`ModelGateway.stream()` returning `{ chunks, settled }`, plus a shim driving non-streaming
providers. Two rules that need deciding once: **fall back only before the first chunk** (after
it, audio is already on the wire and restarting makes the caller hear the sentence twice — the
stream instead ends `partial` and truncates); and **never cache a truncated stream** (make abort
throw so the cache write at `model-gateway.service.ts:105` is unreachable, rather than guarding
it). Real `stream()` for `EchoProvider` (word-by-word, for deterministic tests) and
`OpenAiCompatibleProvider` (SSE, as proof the port fits a wire protocol).

**Phase 2 — ports, registry, control plane.** `transcriber.port.ts`,
`speech-synthesizer.port.ts`, `media-transport.port.ts` (the last keeps `ws` out of the domain
and makes "WebRTC later" one adapter class). `SpeechRegistry` — explicit
`agent_version_speech` binding wins outright, then language/residency filter, region, cost tier,
deterministic tiebreak. **The residency gate lives here and only here**, mirroring
`ModelGateway.complete():61-67`. Fake STT/TTS adapters. `AgentSpec.speech` + `transport` fields.
`/v1/speech/providers` routes.

**Phase 3 — the voice domain.** `ClauseChunker`, `PlayoutTracker` (pure, clock injected),
`VoiceSessionRunner`, `LoopbackMediaTransport`, `/v1/voice/sessions` routes with `GET /events`
delegating to `RunStreamService.attach()`. Barge-in end-to-end on loopback.

**Phase 4 — relaxed durability + transcript fidelity.** `RelaxedCheckpointer` (turn-boundary,
epoch-fenced), `VoiceTranscriptWriter`, `VoiceRecoveryService` on the **scheduler** (singleton
by nature, alongside `reclaimExpired`), `thread.messages()` voice projection using
`delivered_text` and emitting gap markers, ADR `0002-relaxed-durability.md`.

**Phase 5 — real WebSocket.** `ws` + `@types/ws` (first such deps; 17 today). `ws` in
`noServer` mode, **not** `@nestjs/websockets` — the upgrade must be authorised *before* the
handshake completes, and Express's middleware stack is wrong for it. New `voice` process role +
`src/main.voice.ts`. **The RLS trap:** a long-lived socket must never hold a pinned pool
connection — 500 concurrent calls would exhaust the pool. Socket lifetime and pin lifetime are
decoupled; each flush/heartbeat takes its own short `withTenantConnection`; tenancy and the
resolved version are cached in memory at attach so the hot path issues no reads. Enforced by a
test that fails if `acquireTenantConnection` is imported under `src/*/voice/`.

**Phase 6 — capacity, metering, ops.** Vendor ceiling via conditional insert →
`Saturated('shed','speech_provider')`, with the READ COMMITTED overshoot window documented
rather than pretended away. `/capacity` route. `speech_seconds` ledger rows (TTS bills
*synthesized* ms, not played — the disagreement with §6.3 is real and gets a comment so nobody
"fixes" it). `voice` in `/v1/ops/subsystems`.

---

## Verification

Every clock injected; no wall-clock waits anywhere in the suite.

- **Unit, no I/O:** `ClauseChunker` fed one character at a time emits the first clause *before
  input is exhausted*; abbreviations (`Rs. 500`, `Dr. Rao`, `3.5%`) don't split. `PlayoutTracker`
  truncation at and inside frame boundaries.
- **Deterministic fakes:** `FakeSynthesizer` uses **1 char = 10 ms = 80 μ-law bytes**, frames of
  20 ms/160 bytes, each frame's bytes being the source `charCode` repeated — so a test can
  **decode the wire audio back to text** and assert exactly which characters were spoken.
  `FakeTranscriber` takes control bytes (`0xFF` = `speech_start`) so barge-in is an explicit
  instruction with no timing race.
- **The core §6.3 test** (`test/voice-bargein.spec.ts`, loopback + virtual clock):
  speak → `advanceMs(120)` → barge in → assert `playedText() === 'Your bal'`,
  `turn.played_offset_ms === 120`, `memory.content === 'Your bal'`, and
  **`memory.content !== fullGeneration`**.
- **ADR-0001 regression:** `SELECT count(*) FROM events WHERE run_id = $1` stays small — proof
  per-frame media never entered the log.
- **Durability:** drive N turns, drop the committer, assert `last_committed_turn_seq` lags by ≤
  the declared bound, run the reconciler, assert the gap marker exists and **no memory row was
  fabricated**.
- **Routing:** language/region/cost selection; `regulated` + external → `CapabilityDenied`.
- **Streaming:** a provider *without* `stream()` driven through the shim yields a
  `GatewayResult` byte-identical to `complete()`.
- **Manual smoke:** `scripts/telephony-sim.mjs` opens a real WS, plays a μ-law WAV, prints
  returned audio. Not a test.
- Full gate: `npm run verify` (lint, build, core build, typecheck, layers, db:drift,
  replay corpus — needs a voice fixture added — and the suite).

---

## Deferred, explicitly

Browser WebRTC (`/offer`, `/ice`) — one adapter behind `MediaTransport`. Real STT/TTS vendors.
Delegation, peer calls and HITL approval *inside* a voice turn. Native Anthropic/Google
streaming (shim covers them). DTMF, call recording. `fork`/`replay` must **refuse** voice runs.
Multi-region speech routing beyond the residency gate.

## Riskiest parts

1. **`played_offset_ms` is an estimate and the whole §6.3 guarantee rests on it.** Raising
   `PLAYOUT_LEAD_MS` for smoothness silently degrades the guarantee — hence storing it per
   session and surfacing it in ops.
2. **Dropping the epoch assertion from the batched flush** — silent divergence, no error.
3. **Two drive loops diverging** — mitigated structurally in Phase 0.
4. **A provider that ignores `AbortSignal`** keeps burning tokens *and* leaves `settled`
   unresolved, hanging the flush. Every `stream()` gets a gateway-level timeout-and-abandon.
5. **Event-loop starvation** — one shared 20 ms pacer tick for all sessions, a hard per-process
   session cap, `voice_pacer_lag_ms` as the shed signal.
