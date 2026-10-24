# Where the image cases came from

`calibration/vision/` exists because `src/README.md` line 25 asks for a watch model that
**sees images**, and until this set existed the requirement had never been run at all —
`../provenance.md` recorded exactly that ("Vision. No image case was ever run").

## What the cases are

**Hand-written screenshots**, drawn for this set in this project's own session
(`seek-opensource-task`) on 2026-10-25 with the same frame as the text corpus: a
payment-operations team's room. They are not captured from a real chat, not taken from a
third party, and not photographs of anything real.

Each case is one image, one caption, and a label. The labels mean what they mean in the text
corpus:

| label | meaning |
|---|---|
| `act` | this bot should speak or do work now |
| `ignore` | nothing to do with this bot |

**The caption is deliberately uninformative.** Every message reads like `fyi`, `just landed`
or `lol`, and the label is derivable only from the picture. That is the whole point: a case
whose label could be read from its words would score a text-only model just as well, which is
the failure `src/README.md` line 25 exists to prevent ("judging from alt text does not count").

Sixteen cases, eight per label, four of them carrying Chinese text in the image. The pictures
are dashboards, charts, failure screenshots, a slide, an invoice, a whiteboard, two photos,
and a green status board — the ordinary traffic of an ops room.

## What each file is

| file | is |
|---|---|
| `cases.json` | the 16 cases: id, label, image path, caption, a note, and the language of the image text |
| `img/*.png` | the images themselves, at the size they were measured |
| `heldout.json` | the second 16 cases, written after the first 16 had been measured and used to pick nothing |
| `measured.json` | the readings: model files and their hashes, the runner, per-case `p_act`, accuracy, AUC, latency, and the diagnostic below |
| `probe.json` | the prompt probe: four wordings of the ask over the same 32 cases, and the operating-point finding below |
| `boundary.json` | the third 24 cases, written to **choose** a cut: thin-evidence positives against evidence-like negatives |
| `boundary-measured.json` | their reading, the plateau they form, and the three sets compared |
| `zh.json` | twelve Chinese-authored cases, for the multilingual half of the requirement |
| `remeasured.json` | **every set re-scored in the prompt shape the kernel assembles** — the reading to quote |
| `provenance.md` / `provenance.zh-CN.md` | this record |

## How the reading was taken

The shipped question and the shipped shape: the `watch-v1` system line, then
`Message: <caption>`, then the image, then *"Do you need to do something about this message?
Answer act or ignore."*, zero shots, temperature 0.

The number reported is **P(act) as the ratio at the 0.600 cut declared in
`src/prompts/watch-v1.json`**, read from the next-token distribution at the end of the
formatted prompt and summed over every token whose decoded form strips to `act` — the same
estimator `../provenance.md` describes for the text run.

**Two deviations from that run, both of them forced.** The earlier harness was
`llama-cpp-python` with a `LogitsProcessor`; it cannot take an image, so the reading here
comes through `libmtmd` and `libllama` from a llama.cpp built at `701fd25`, with a one-shot
scorer that loads the checkpoint and prints the distribution. And the checkpoint is the
**Q4_0** file rather than whichever was to hand, because that is the quant
`docs/decisions.md` names as bundled — the point of the run is to describe the artifact the
kernel would ship. Both model files were checked against the SHA-256 the hub publishes for
them before anything was measured; the hashes are in `measured.json`.

## The reading

Two sets, the second written only after the first had been read — so the reading is not one set
flattering the model it was used to diagnose.

| set | accuracy at the 0.600 cut | AUC | `act` | `ignore` |
|---|---|---|---|---|
| `cases.json` (16) | 12/16 = 0.750 | 0.875 | 4/8 | 8/8 |
| `heldout.json` (16) | 13/16 = 0.812 | 0.875 | 5/8 | 8/8 |
| **both (32)** | **25/32 = 0.781** | **0.891** | **9/16** | **16/16** |


| | |
|---|---|
| per case, image encoding and forward pass | **1.05 s** median, measured across both sets |
| quant check | Q4_K_M scored 12/16, AUC 0.891 on the first set — the verdict does not turn on the quant |

**What that says.** The two halves agree, which is the reason there are two. The model sees
images: it never once fired on a picture that carried nothing to act on, 16 out of 16, and
that is the failure mode that makes a bot noisy. It **under-fires on pictures that carry an
incident** — of sixteen such pictures it missed seven, and the misses are not one kind of
picture: a disk gauge at 98%, a deploy that failed, a queue chart that collapsed, a
certificate two days from expiry, a traffic chart that fell to zero, and both Chinese
failure screenshots. The held-out set was written to include exactly those classes after the
first set had shown them, and the model missed them again — so this is what the model does
with an ops screenshot, not an accident of sixteen pictures. That is the other half of the
failure line 25 warns about, so the multimodal requirement is **measured and still not met**,
and line 25 stays unticked with the number beside it instead of with the word "unmeasured".

**But those seven misses are not the model's ceiling on these pictures, and this record was
wrong to imply a bare model limit.** `probe.json` holds the experiment: with the model, the
prompt and the 32 cases all fixed, a cut of **0.150** scores the same checkpoint **29/32 =
0.906** — act 13/16 rather than 9/16, with `ignore` still perfect. No `ignore` case anywhere
in either half exceeds p_act 0.134, while act cases have medians of 0.616 and 0.735, so the
classes barely overlap and it is the **0.600 cut slicing through the middle of the act range**
that produces most of the misses, not a failure to see. The cut was calibrated on text cases
(`docs/decisions.md` row 12) and does not transfer to image-bearing messages. Choosing it on
one half and scoring the other gives 0.150 from each half independently, cross-validated at
0.906 — so the finding is not a cut picked on the cases that then scored it, though two folds
of sixteen synthetic screenshots still is not a calibrated operating point.

**Resolution was ruled out as the cause.** Measured on the first set: raising the image token budget from the
projector's default to 1024 does not fix the misses and costs about three times the latency:
`a4` rises 0.438 → 0.739 and becomes correct, `a1` falls 0.616 → 0.585 and becomes wrong, and
`a5`/`a6`/`a8` rise but stay under the cut. The default budget is the better operating point
and the misses are judgement, not sampling.

## Does the wording or the cut carry the gap?

Two explanations survive a reading of 9/16: the model cannot see what an ops screenshot
means, or the ask does not point it at the screenshot. `calibration/provenance.md` records
that for the text path *rewording alone moved one model's discrimination from 0.09 to 0.77*,
so the second is not a straw man. `probe.json` tests it: the model and all 32 cases held
fixed, four wordings of the ask, the variants written before any of them was run, and the
answer a single token from `{act, ignore}` in every one, as line 26 requires.

| variant | at 0.600 | AUC | `act` | `ignore` | its own best cut | there |
|---|---|---|---|---|---|---|
| V0 the shipped ask (control) | 0.781 | 0.891 | 9/16 | 16/16 | 0.150 | **0.906** |
| V1 the attachment is named in the ask | 0.656 | 0.922 | 5/16 | 16/16 | 0.150 | 0.875 |
| V2 the system line says screenshots matter | 0.781 | 0.914 | 9/16 | 16/16 | 0.175 | 0.906 |
| V3 on-call incident framing | 0.688 | 0.957 | 6/16 | 16/16 | 0.075 | 0.906 |

**Wording is not the lever.** Naming the screenshot in the ask makes it *worse* at the shipped
cut, and once each variant is allowed its own best cut they all land at 0.906 or below — V3
buys one more act case by giving back one ignore case, which is a trade rather than an
improvement. Note what the AUC column does: it climbs to 0.957 while accuracy falls, because
the rewording pushes the whole distribution down; an AUC gain the kernel cannot spend at its
operating point is not a gain.

**The cut is.** That is the finding worth carrying: the vision gap is mostly an
operating-point mismatch, and an operating point is cheap to question and expensive to
assume. A third set, written afterwards to choose that cut rather than to describe the model,
confirms the interval and states what moving costs — next section.

## A set written to choose the cut, and what moving it costs

`boundary.json` is the set the first two could not be. Line 25 and `docs/decisions.md` row 12 both
ended at "choosing a cut for the image path needs a set written for that purpose", and the first 32
could not supply one: their accuracy-maximal interval, (0.134, 0.168], was pinned by exactly one
case on each side — `i6` at 0.1340 and `a8` at 0.1680 — so the boundary rested on two pictures
nobody had chosen for the job. The third set stresses that boundary on purpose: twelve positives
whose evidence is **thin** (one amber tile among twelve, one ERROR line among INFO, a gauge at 91%,
an SLO just crossed, a warn counter trending up) and twelve negatives that **look** like evidence
and carry none (a red brand header over an all-green status page, an incident marked RESOLVED, an
audit reporting zero errors, a dip annotated recovered, a red announcement slide, a backup that
COMPLETED). Every case was assigned to its family before anything was scored, and all 24 are
reported whatever they scored.

At the shipped 0.600 cut the new set answers **15/24** — `act` 3/12, `ignore` 12/12 — with an AUC of
**0.701** against 0.891 on the first 32. That gap is not noise: the earlier figure was measured on
negatives that were easy to dismiss (a plant, a meme, a receipt, a burndown), and evidence-like
negatives are not easy. On this set alone the best cut is (0.1097, 0.1143].

Pooled, the picture is steadier than either half:

| cut | first 32 | boundary 24 | all 56 |
|---|---|---|---|
| 0.600 (shipped) | 25/32, `ignore` 16/16 | 15/24, `ignore` 12/12 | **40/56**, `act` 12/28, `ignore` 28/28 |
| 0.200 | 28/32, `ignore` 16/16 | 15/24, `ignore` 10/12 | 43/56, `act` 17/28, `ignore` 26/28 |
| 0.168 | 28/32, `ignore` 16/16 | 15/24, `ignore` 9/12 | 43/56, `act` 18/28, `ignore` 25/28 |
| **0.151** (max-margin) | 29/32, `ignore` 16/16 | 16/24, `ignore` 9/12 | **45/56**, `act` 20/28, `ignore` 25/28 |
| 0.134 | 28/32, `ignore` 15/16 | 15/24, `ignore` 8/12 | 43/56, `act` 20/28, `ignore` 23/28 |
| 0.112 | 26/32, `ignore` 13/16 | 17/24, `ignore` 8/12 | 43/56, `act` 22/28, `ignore` 21/28 |

**The interval survives, and it is no longer two lucky pictures.** Over all 56 cases the
accuracy-maximal cut is **(0.1356, 0.1667]**, max-margin **0.1512** — against **0.1510** for the
first 32 alone, but now pinned by `b-i4` (0.1356, a dip annotated recovered) and `b-a9`
(0.1667, an incident still investigating): two cases from the set that was built to stress it. Drop
the three act labels a reader could dispute (`b-a1`, `b-a4`, `b-a10` — one amber tile among twelve,
and a certificate 21 and 18 days out) and the interval does not move.

**What the move costs is what this reading adds.** Going from 0.600 to 0.151 lifts `act` recall from
12/28 to 20/28 and drops negatives answered correctly from 28/28 to 25/28. The three that start to
fire are `b-i8` at 0.3588 (a backup log whose last line is COMPLETED), `b-i5` at 0.2482 (a red
announcement slide) and `b-i3` at 0.1985 (an audit whose line reads `errors 0`). Each is a plausible
thing to find in an ops room, and each would cost a message the bot should not have sent.

So the set does not close the question; it turns it from a question about the model into a question
about cost. At 0.600 the gate misses 16 of 28 incidents and never fires wrongly; at 0.151 it misses
8 and fires wrongly 3 times in 28. Which of those the kernel prefers is a ruling, and the cut in
`src/prompts/watch-v1.json` is unchanged at 0.600.

## The picture sat in the wrong place, and every image number moved

The rigs behind the readings above had two defects, and the second one is not a rounding
difference.

**The picture was appended after the question.** The shipped shape is the artifact's order:
the system line, `Message: <caption>`, the picture, the question. The rig put the marker at
the very end instead, so the model read *"…Answer act or ignore."* and only then met the
image. `agent-lifecycle.md` §2 and `decisions.md` row 17 both say the picture reaches the
judgement with the message it belongs to, so the rig was wrong and the prose above was
right. **The prompt also ended without the question part's trailing space**, which `watch-v1`
declares as `after: " "` and `src/prompts.ts` appends — that space is the boundary the option
ids are bound at, so dropping it moves the answer as well.

Both are fixed, and every set was re-scored on one rig: the same scorer, the same quant and
projector hashes, the chat template with the `watch-v1` system line as a system message, the
picture on its message, and the user turn ending on that trailing space
(`remeasured.json`). A third shape was tried and rejected on measurement: the artifact's
parts fed to the model as one flat string with **no** chat template scores `set4.json` at
AUC **0.469** with `act` **0/12** — below chance, because this is a chat model and the
assembled text is its user turn, not its whole prompt.

| set | at 0.600, before | at 0.600, re-measured | AUC before → after |
|---|---|---|---|
| `cases.json` (16) | 12/16 | **13/16** | 0.875 → **0.938** |
| `heldout.json` (16) | 13/16 | **13/16** | 0.875 → **0.922** |
| `boundary.json` (24) | 15/24 | **15/24** | 0.701 → **0.840** |
| all images (56) | 40/56 | **41/56** | 0.811 → **0.889** |
| `set4.json` (24 text) | 24/24 recorded | **20/24** | 1.000 → 1.000 |

**Two published claims do not survive this.** Last set's report said the boundary set showed
"AUC 0.701" and that buying `act` recall at a 0.151 cut "costs three of 28 negatives". Both
were properties of the misplaced picture, not of the model: re-measured, that set's AUC is
**0.840**, and at the best cut **no negative in any of the 56 image cases fires at all**
(`ignore` 28/28). The price was an artefact, and this record withdraws it.

**And the single cut turns out to exist after all.** With both paths on one rig their plateaus
overlap:

| cut | images (56) | text (24) |
|---|---|---|
| 0.600 (shipped) | 41/56, `act` 13/28, `ignore` 28/28 | **20/24**, `act` 8/12 |
| **0.3896** | **48/56**, `act` 20/28, `ignore` 28/28 | **24/24** |

The text plateau is **(0.3845, 0.3948]** and the image plateau is **(0.3688, 0.4500]** — the
first sits inside the second, so one cut serves both. Moving from 0.600 to about 0.39 is
better on **both** paths and costs no precision on either: text 20/24 → 24/24, images
41/56 → 48/56, `ignore` 28/28 either way. That is not a trade, so the earlier framing — a
second cut, or a choice between missing incidents and sending what it should not — was an
artefact of the wrong rig too. `src/prompts/watch-v1.json` still declares 0.600 and the cut is
not changed here; choosing it is `decisions.md` row 12's, and this record only says what the
labelled sets now say.

## The Chinese half, measured on its own

Line 25 asks for **multilingual and multimodal**, and until now the multilingual half rested
on 8 Chinese pictures out of 56 — which `measured.json` itself says cannot carry a language
split. `zh.json` adds twelve cases, written in Chinese from the start as a Chinese ops room's
traffic (对账日报, 短信通道, 工单, 灰度发布演练, 快递柜, 会议室预订), six act — three of them
thin evidence — against six ignore — three of them evidence-like. Two of them share a family
with an English case and say so per case; none is a translation.

| | |
|---|---|
| AUC | **0.694** (English image pool: 0.889) |
| at 0.600 | 7/12 — `act` **1/6**, `ignore` 6/6 |
| at 0.3896 | 7/12 — `act` **1/6**, `ignore` 6/6 |
| best cut | (0.0365, 0.2836], 8/12 |

**The Chinese side is materially worse, and it fails the same way as the first English set
did: it under-fires.** Six pictures that carry an incident, one answered. The two clear ones
it missed are a Chinese point-of-sale error dialog and a Chinese log line reading
`FATAL 结算进程退出 code=137`; the thin ones — an amber tile among twelve, one reconciliation
row reading 差异 3 笔, an exhausted error budget — were all missed. Its negatives are perfect
at every cut above 0.29, so this is not a model that fires at everything in Chinese; it is one
that does not fire.

Twelve cases is a narrow reading and it is stated as one: it is enough to say the multilingual
half is **measured and not met**, which is a different sentence from the one line 25 carried
before, and not enough to rank models on Chinese vision.

## What this material does not settle

- **One message, one image.** Every case is a single image with a single caption. A box
  carrying several messages or several images is not measured here, the same extrapolation
  the text corpus carries.
- **Synthetic screenshots.** Rendered, not captured: a real screenshot has chrome, scale
  factors and compression that these do not.
- **n = 32.** Sixteen images per label is a narrower interval than sixteen cases were, and
  a language split. The reading is enough to say the requirement is unmet and not enough to
  rank models on vision.
- **The estimator.** The scorer reads the whole next-token distribution, summed over every
  token that spells the option. The kernel's own mask names a single id per option, and this
  sentence used to say that difference *was already recorded* in `docs/decisions.md` — it was
  recorded nowhere, and four files repeated the claim. The row exists now (`docs/decisions.md`
  row 19), and it settles the reading rather than describing two: the runtime sums the
  distribution as the measurement did, and `calibration/vision/server-transport.json` shows that
  transport reproducing this file's text set exactly — AUC 1.000, 20/24 at 0.600, per-case
  difference at most 0.0008. What is still open on that path is the images: `/completion` takes
  no projector, so no image figure in this directory has been read through the server transport
  at all, and none should be quoted as if it had.
- **No rule was changed.** The 0.600 cut is unchanged in `src/prompts/watch-v1.json`. The
  re-measurement above says one cut near 0.39 serves both paths and dominates 0.600 on each, but
  choosing it is `decisions.md` row 12's to do, not a measurement's to declare.
- **The Chinese reading is 12 cases.** Enough to call the multilingual half measured and unmet;
  not enough to rank models on Chinese vision, and not enough to say whether the deficit is the
  script, the pictures this set chose, or the model's training mix.
