# Where the calibration material came from

This directory is **data, not runtime**. Nothing under `src/` imports it, and no test reads a
case from it to decide a verdict. It is here so that the shipped prompt and the shipped
operating point have a source a reader can inspect, and so that the numbers behind
 them are not only a paragraph claiming they were measured.

## What the cases are

**Hand-written synthetic room traffic**, written by hand in this project's own session
(`s_261023_1731_109509b5`, the session that designed the loop before the kernel existed) on
2026-10-24. They are not captured from a real chat, not generated, and not taken from any
third party. A payment-operations team's room is the frame: incidents, questions addressed to
the team, and the chatter that surrounds them.

Each case is a label and one message. The labels mean:

| label | meaning |
|---|---|
| `act` | this bot should speak or do work now |
| `ignore` | nothing to do with this bot |
| `keep` | relevant, but nothing to do yet |
| `snooze` / `later` | decide later, or it needs a clock |

**`snooze` and `later` are the same label under two spellings, and both are kept as written.**
`cases.py` wrote `snooze`, `round3.py` wrote `later`; normalising them would edit the material
this record exists to preserve, so the difference is named here instead. The judgement asks a
binary question and never produced either label — they are in the sets because the four-way
question was measured too, and scored at chance on every model tried.

## The four sets, and what each was for

| file | from | cases | role |
|---|---|---|---|
| `cases.json` | `cases.py: CASES` | 24 | the training set a prompt grid was scored on |
| `heldout.json` | `round3.py: TEST` | 12 | held out of that grid |
| `val.json` | `round3.py: VAL` | 16 | the third set, opened once the grid had chosen |
| `set4.json` | `validate.py: SET4` | 24 | **written after every prompt choice was made, and used to pick nothing** |

24 + 12 + 16 + 24 = **76**, the figure `docs/design/agent-lifecycle.md`
quote. The sets are disjoint: no message appears in two of them.

`round3.py` also holds a further 12-case set (`TEST`) and `final3.py` a 12-case generalisation
check; the total quoted across the documents is the 76 above, and this directory carries
exactly those.

## Which script produced which figure

| figure | script |
|---|---|
| the prompt shape, the per-set AUC and accuracy, the swept cut | `validate.py` (SET4), `round3.py` (grid over `cases.py`, then `TEST`, then `VAL`) |
| the per-language split | `zhconfirm.py` (pooled Chinese cases), `lang.py` |
| the model ranking and the sizes | `bench.py`, `final.py`, `final3.py` |
| the four-way question scoring at chance | `probes.py`, `sweep.py` |

The readings themselves, with the numbers, are in `measured.json`.

## The measurement ran outside this repository

Every figure was produced by `llama-cpp-python` on the host's laptop, loading the
checkpoint directly, with a `LogitsProcessor` reading the next-token distribution at the end
of the prompt. **Nothing here re-derives any of it**: there is no inference in this
repository, no bundled model in the tests, and no download. A reader who wants to re-run it
needs the checkpoint and that harness; a reader who wants to know what the shipped number
rests on needs this directory.

Four of those scripts print their results and write no file (`validate.py`, `round3.py`,
`lang.py`, `zhconfirm.py`), so their figures existed only in that session's transcript.
`measured.json` is the persisted copy, and it exists because that transcript is not a
place a repository can cite.

## What this material does not settle

- **Vision.** No image case was ever run **in this directory**. The image set lives beside it
  in `vision/`, measured 2026-10-25 on a model that could see: 25/32 at the 0.600 cut across two sets, AUC
  0.891. The model that ships now cannot — `d1-2B` declares `modalities.vision: false`, so a picture inside a
  judgement's window is refused, not judged from its caption — so the requirement stands unmet, and nothing
  here may be read as saying images are handled.
- **A box with more than one message.** Every measured run judged one message at a time.
  The shipped prompt renders a box's delta as one `Message:` line per entry, which equals
  the measured shape when there is one entry and is an extrapolation when there are more.
- **The estimator, and the one that replaced it.** The measurement summed the probability of
  *every* token whose decoded form strips to `act` — `vocab.py` on the recording side,
  `llama.ts`'s `readingOf` on the runtime's, which is what let the two numbers be compared at
  all. **That is no longer how this tree reads.** The judgement is one call to `llama.cpp`'s
  `/v1/systemone` on a decision model (`d1-2B`), which answers with one calibrated probability
  per declared answer and generates no token: nothing is summed, and there is no spelling to
  match. `readingOf` and `bindOptions` went with it. What the shipped cut rests on now is
  `calibration/set4-d1.json` — set4 read through the kernel's own `watchAs` over that endpoint,
  24 of 24 at 0.600, lowest `act` 0.625 and highest of everything else 0.582. Everything above
  is the measurement that *was* taken, kept as what it is and not read as a description of the
  code; `measured.json` says which record replaced it. The one difference that was never
  settled — `vocab.py` normalising over the pair while `readingOf` returned the raw sum — is now
  moot rather than answered: no arithmetic of that kind happens on either side.
- **The language split.** One model wants a different cut in Chinese than in English
  (0.88 against 0.53). The shipped default is a single global cut, chosen deliberately;
  branching on language in code would be inventing a ruling nobody made.
