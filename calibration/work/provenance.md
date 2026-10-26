# A work model, chosen by measurement

`calibration/work/` exists because **the work half of the kernel had never been held to the
rule the watch half is held to**. `src/README.md` line 25 says the watch model is chosen by
measurement rather than by size alone; nothing said the same of the work model, and the
model that shipped was never asked the only question that matters for it: *does it call
`say`?*

Issue #89 measured that it does not. On the released `v0.1.3`, against a real
`llama-server`, the shipped artifact asked with `tool_choice: 'auto'` produced prose and no
call in **30 of 30** requests, and prose with `finish_reason: length` under `required`. Three
readings then ruled out the two explanations that would have been about the request rather
than the model: rewording the artifact's parts changed nothing, and the same server on the
same body answers correctly when a plain turn is asked with no tools at all.

So the question stopped being *how the model is asked* and became *which model*. This
directory is that answer, measured.

## What the cases are

**Nine hand-written cases**, written for this measurement in this project's own session
(`seek-opensource-task`) on 2026-10-26 in the frame the rest of the corpus uses: a
payment-operations team's room, with one bot called Echo watching a nightly batch. They are
not captured from a real chat and not taken from a third party.

| label | meaning |
|---|---|
| `speak` | this turn should end with a `say()` call carrying words |
| `quiet` | this turn should end having said nothing |

Six want an answer (three English, three Chinese, two of them addressed to the bot by name)
and three want silence (`ok`, `thanks!`, `好的收到`).

**Both directions are in the set because the two failures are opposite and both are
defects.** A turn that should speak and posts nothing leaves the room empty, which is #89.
A turn that should stay silent and speaks instead has the bot answering a room nobody asked
it anything — the failure the whole gate exists to prevent, arriving one stage later. A set
that contained only the first would score a model that always talks at full marks.

## The rig

`measure.mjs`, beside this file, is the exact driver. It takes `MODEL=<gguf>` and runs the
kernel's **own** assembly — `assembleWorkPrompt(loadWorkArtifact(), …)` over the shipped
`src/prompts/work-v1.json` — not a paraphrase of it, so a row can only differ from another
row by the model. It imports that assembly from the checkout it sits in, so a re-run
measures the prompt the reader has; `LLAMA=<path>` names another `llama-server` build.

| | |
|---|---|
| server | `llama-server` 0.7.0-dev (build 1, commit `701fd25`), AppleClang 17, Darwin arm64 |
| flags | `-c 4096 -np 1 -ngl 99`, plus `--mmproj` only for a model loaded with its projector |
| tools | the artifact's `tools` (`say`), sent as given |
| `tool_choice` | **`auto`** — the shipped value in `src/llama.ts` |
| temperature | 0 |
| endpoint | `POST /v1/chat/completions` |
| repeats | **3 per case** — 27 requests per model |

**The artifact was not touched for any row.** Not one character of
`src/prompts/work-v1.json` changed, which is what makes the rows comparable: the only
variable left is the model.

**Tools reached the model in every row.** This build enables the Jinja engine by default
(`--help` reports `--jinja, --no-jinja … (default: enabled)`), so each GGUF's own chat
template renders the tool list; the shipped model's template appends
`List of tools: […]` to the system message. No row here was measured with the tools withheld
and then read as a model that would not call them.

## The table

Nine cases · six that should speak, three that should stay quiet · three repeats each, no
outcome changed across repeats.

| model | delivered | prose instead | silent instead | stayed quiet | spoke when it should not | prose when it should be quiet | median |
|---|---|---|---|---|---|---|---|
| `LFM2.5-VL-3B-Q4_0` — **what ships** | **0/6** | **6/6** | 0/6 | 0/3 | 0/3 | 3/3 | 441 ms |
| `Qwen3-VL-2B-Instruct-Q4_K_M` | 5/6 | 1/6 | 0/6 | 0/3 | **3/3** | 0/3 | 729 ms |
| `Qwen3-VL-4B-Instruct-Q4_K_M` | **6/6** | 0/6 | 0/6 | 0/3 | **3/3** | 0/3 | 994 ms |

Byte counts of the files measured, for anyone rebuilding the set:
`LFM2.5-VL-3B-Q4_0.gguf` 1,593,894,944 · `Qwen3VL-2B-Instruct-Q4_K_M.gguf` 1,107,409,952 ·
`Qwen3VL-4B-Instruct-Q4_K_M.gguf` 2,497,281,664. Checksums are in `measured.json`.

## What the three rows say

**1. Calling `say` is a property of the model, not of the request.** Two models call it on
the identical prompt, body and `tool_choice` that the shipped one answers with prose. That
settles the question #89 was opened on: nothing in the runtime, the schema or the artifact is
keeping the room empty. The model is.

**2. Delivery tracks capacity, and prose disappears as it does.** 0/6 → 5/6 → 6/6, and the
one remaining prose case at 2B is a Chinese one — it answers `I am in the room oc_… . The
agents behind this bot are: …`, reading its own system prompt back instead of speaking. At
4B every case that should speak does, in the language it was asked in.

**3. No model tested stays quiet, and the shipped one is not quiet either.** This is the
reading the set exists to make visible, and it is the opposite of the single column one
would have measured. The shipped model's `stayed quiet` is **0/3** — it writes
`I'm sorry, but I can't help with that.` to every one of the three, which is *no message*
under the kernel's own rule (`docs/decisions.md` row 28: nothing reaches a room except
through `say`), but it is not the behaviour of a turn that says nothing. So today's model
fails one direction outright and does not achieve the other; the candidates fail the other
direction outright. **Silence is the column no model reached even once.**

**4. A turn is never silent by accident, and never settled by one draw.** Three repeats per
case, at temperature 0, changed no outcome in any of the three models (0/9 unstable each).
What that establishes is determinism, not quality: it says these are not coin flips, and it
says nothing about what a different sampling would do.

## What this does not decide

**Which model ships.** That is a cost and a horizon, and both are the owner's word, not a
measurement's:

- the 4B that delivers all six is **2,497,281,664 B** against the shipped model's
  1,593,894,944 B, so first-run weights grow from ≈1.5 GiB to ≈2.3 GiB before any projector;
- the judgement half reads **token probabilities** and its `0.600` cut is calibrated against
  `LFM2.5-VL-3B` on 56 cases (`../provenance.md`, `docs/decisions.md` row 12). A different
  model is a different distribution, so a work model that also served stage 1 would need
  that cut recalibrated — which is a second measurement, not a line to change;
- the two halves are wired to separate servers (`SEEK_SERVER` / `SEEK_WORK_SERVER`), so
  keeping the shipped model on the judgement half and a Qwen on the writing half is
  possible today and costs **two** weight downloads (≈1.5 GiB + ≈2.3 GiB) instead of one.

## What was not measured

- **Stage 1 on these nine cases.** In production a work turn exists only after the judgement
  said `act`, so how many of the three quiet cases would ever reach a work model is not
  measured here. The gate's own reading of them is a separate measurement and this file does
  not supply it — which is why the quiet column is reported rather than interpreted.
- **Images.** Every case is text and neither Qwen row was loaded with a projector. Nothing
  here says they see. `src/README.md` line 25's multimodal requirement is stated of the
  watch model; whether the work model must see too is a question this set does not answer.
- **A box holding more than one message.** Every case is one entry, the same limit
  `../provenance.md` records for the judgement.
- **Anything above temperature 0**, and any sampling.
- **Whether silence is reachable at all with this ask.** It is the one column with no
  positive reading in any row.
