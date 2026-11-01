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

**The tree now ships `work-v12.json`, and every row below was measured on `work-v1.json`.** A
prompt is versioned rather than edited in place, so v1 stays in the tree exactly as it was
measured. v2 adds two parts — what the bot does in its organization, and how it talks and
works — and both are skipped when a bot's card says nothing; v3 adds one part, the note the
bot wrote about the room before the messages it reads, skipped while the room has no note.
v12 adds the room each line came from — the box is the bot's and not a room's, so what it
reads may come from several — and leaves the rest of v11 as it stood.
So a bot with an empty card, in a room nothing has been compacted in, was asked the v1 text
byte for byte for as long as v2 and v3 shipped (`src/prompts.test.ts` compared the two
assemblies, and says why it no longer can).

**v4 is the first version this record does not cover, and it says so instead of looking
measured.** It rewrites the system line, the opening and the ask; it adds the two parts that
make a bot speak as one person in a meeting rather than as an assistant — the stake it pays
and collects, and the single move it makes this turn; and it gives `say` a `mentions`
argument, so a bot can address the others by name and a room of bots can answer itself.
Nothing below was measured on v2, v3 or v4: the driver hands over a description, no card and
no note, so it still assembles the v1 text, and a run on any later version would be a new row
set.

**v5 is the same kind of change and the last one this record does not cover: the entry line
now says when the entry arrived.** It renders `[{at}] {sender}: {text}`, which is the shape
`watch-v3` already used for the same fact, and the value is the observation's own
`delivered_at` — not "a week ago", which would need a clock reading at assembly time. Two
messages a week apart used to arrive as two lines of one shape, so the half that answers could
not tell a reply from an answer to something said seven days earlier, and the parts `work-v5`
inherits from v4 ask it to say when it will know a thing works and when it looks again. The
driver's rows hand over no time at all, so they still assemble the v1 text; this record
measures nothing about v5.

**v6 is the same kind of gap closed on the other side of a picture.** The judgement is handed a message's picture and refuses it
(`box.ts`, `docs/host-rulings.md`: the model that ships declares `modalities.vision: false`),
and the turn that answers was handed nothing at all — measured on the request body, a message
whose whole content was a picture reached the prompt as `me:`, one line indistinguishable from
an empty message, and searching that body for `picture`, `image`, `media` or the blob's own key
found nothing. v6 carries `pictureLine`, the file's own words for the fact, and the entry line
says `{picture}` where they go: an entry with a picture says so, an entry without one is the v5
line byte for byte, and a picture with no caption is no longer a blank entry. The driver's rows
hand over no picture, so they still assemble the v1 text; this record measures nothing about v6.

**v7 changes one sentence and no part, and it is the last version this record does not cover.**
The fact under v6's sentence changed: the turn that answers is now handed the pictures its box
holds (`TurnBox.media`, and a byte loader the client supplies), so a line saying "a picture came
and you cannot see it" would be a lie about a request that carries the picture. v7's
`pictureLine` says the picture is attached and names the case where it is not — one line with no
image to match it is a picture this turn cannot see — and every other part, every other word and
the `say` tool are v6's, byte for byte. The driver's rows hand over no picture, so they still
assemble the v1 text; this record measures nothing about v7.

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
under the kernel's own rule (nothing reaches a room except
through `say`), but it is not the behaviour of a turn that says nothing. So today's model
fails one direction outright and does not achieve the other; the candidates fail the other
direction outright. **Silence is the column no model reached even once.**

**4. A turn is never silent by accident, and never settled by one draw.** Three repeats per
case, at temperature 0, changed no outcome in any of the three models (0/9 unstable each).
What that establishes is determinism, not quality: it says these are not coin flips, and it
says nothing about what a different sampling would do.

## What the gate does with them

The work model is stage 2. A message arrives there when stage 0's rules fast-pass it or when
stage 1 reads `act` at the shipped cut, and is consumed with nothing spent otherwise — so the
table above is a cost only where these nine cases get that far. `measure-gate.mjs`, beside
this file, is the driver. There are two records, because the judgement changed underneath
them:

- `gate.json` — the reading this directory first held, taken with the watch model that shipped
  then (`LFM2.5-VL-3B`, which read a token probability and summed every spelling of an
  option). It is kept as what it was, and its own `superseded_by` names the record below.
- `gate-d1.json` — the same nine cases through the judgement that ships now: one call to
  `/v1/systemone` on `d1-2B`, which answers with one calibrated probability per declared
  answer and generates no token. Taken the same way as the rest of this directory: the
  kernel's own `classify` and `watchAs`, the shipped `0.600`, one message per judgement.

| case | wants | stage 0 | stage 1 (`act`) | reaches stage 2 |
|---|---|---|---|---|
| the nightly batch failed again — can you look at it? | speak | judge | **0.9638 → act** | **yes** |
| @Echo what is the retry queue doing right now? | speak | **act (named)** | not asked | **yes** |
| did you finish the reconciliation you mentioned yesterday? | speak | judge | **0.9585 → act** | **yes** |
| 今天的对账跑完了吗？ | speak | judge | **0.9385 → act** | **yes** |
| @Echo 那条重试队列现在什么情况？ | speak | **act (named)** | not asked | **yes** |
| 批处理又挂了，你能看一眼吗？ | speak | judge | **0.9359 → act** | **yes** |
| ok | quiet | judge | 0.4371 → ignore | no |
| thanks! | quiet | judge | **0.7418 → act** | **yes** |
| 好的收到 | quiet | judge | 0.5875 → ignore | no |

**All six that should speak reach a work model. One of the three that should stay quiet does
too.**

Two readings follow, and they are the opposite of the ones this section carried while the
other judgement was shipping.

**1. The quiet column has a price now, and it is one case.** `thanks!` reads 0.7418 — above the
cut, so it reaches stage 2. The other two read 0.4371 and 0.5875, below it. So the Qwen
candidates' `3/3` in that column would cost one answer in a room rather than nothing: a work
model handed `thanks!` gets to decide whether to answer it. That is a defect a user can meet,
not one a gate hides.

**2. The ceiling the table had is gone.** In the earlier reading three of the six should-speak
cases were consumed at stage 1, so a work model that delivers 6/6 delivered at most three of
them in a room. With `d1-2B` all six arrive: the delivery column is the work model's to lose,
and the 4B's 6/6 is six answers in a room rather than three.

That restores what the table is for. It asks "which model says something **about the messages
that reach it**" — and of this set, now, six.

**One condition, and it is not the room's.** Every case was judged alone with `window` 10. The
runtime judges a delta — a summary plus several entries — and a different box is a different
prompt, so these are a controlled reading of the cases rather than a replay of a live room. The
earlier note that two of the refused should-speak cases were Chinese no longer applies: both
Chinese cases act here at 0.9385 and 0.9359, and the one case that now passes the cut when it
should not is English.

## What this does not decide

**Which model ships.** That is a cost and a horizon, and both are the owner's word, not a
measurement's:

- the 4B that delivers all six is **2,497,281,664 B** against the judgement model's
  1,846,240,576 B (`d1-2B-Q8_0`), so first-run weights grow from ≈1.72 GiB to ≈2.3 GiB;
- the judgement half reads **one calibrated probability** from a decision endpoint, and its
  `0.600` cut is calibrated against `d1-2B` on the twenty-four cases in `../set4-d1.json`
  (23 of 24 at that cut under the shipped `watch-v4`). A different model is a different distribution, so a work model that also served
  stage 1 would need that cut recalibrated — which is a second measurement, not a line to
  change;
- the two halves are wired to separate servers (`SEEK_SERVER` / `SEEK_WORK_SERVER`), so
  keeping the shipped model on the judgement half and a Qwen on the writing half is
  possible today and costs **two** weight downloads (≈1.72 GiB + ≈2.3 GiB) instead of one.

## What was not measured

- **Stage 1 on several of these cases at once.** `gate-d1.json` reads each case alone, and the
  section above is what it says about them one at a time. A box holding several entries, or a
  summary, or a different `window`, is a different prompt — and the runtime judges deltas.
  That reading is not here.
- **Any cut but 0.600, and any watch model but the shipped one.** The one should-quiet case
  that gets through reads 0.7418 and the two that do not read 0.4371 and 0.5875, so a cut
  inside that band changes which of them arrive; moving it is the host's word, not this
  file's.
- **Images.** Every case is text and neither Qwen row was loaded with a projector. Nothing
  here says they see. `src/README.md` line 25's multimodal requirement is stated of the
  watch model; whether the work model must see too is a question this set does not answer.
- **A box holding more than one message.** Every case is one entry, the same limit
  `../provenance.md` records for the judgement.
- **Anything above temperature 0**, and any sampling.
- **Whether silence is reachable at all with this ask.** It is the one column with no
  positive reading in any row.
