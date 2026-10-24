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
| `measured.json` | the readings: model files and their hashes, the runner, per-case `p_act`, accuracy, AUC, latency, and the diagnostic below |
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

| | |
|---|---|
| accuracy at the 0.600 cut | **12/16 = 0.750** |
| AUC | **0.875** |
| `ignore` cases correct | **8/8** |
| `act` cases correct | **4/8** |
| per case, image encoding and forward pass | **1.05 s** median (1.04–1.07 s) |
| quant check | Q4_K_M scored 12/16, AUC 0.891 on the same set — the verdict does not turn on the quant |

**What that says.** The model sees images: it never once fired on a picture that carried
nothing to act on, which is the failure mode that makes a bot noisy. It **under-fires on
pictures that carry an incident** — a disk at 98%, a stalled queue with a 92k backlog, a
deploy that failed, and a Chinese payment-failure screenshot all sat under the cut. That is
the other half of the failure line 25 warns about, so the multimodal requirement is
**measured and still not met**, and line 25 stays unticked with the number beside it instead
of with the word "unmeasured".

**Resolution was ruled out as the cause.** Raising the image token budget from the
projector's default to 1024 does not fix the misses and costs about three times the latency:
`a4` rises 0.438 → 0.739 and becomes correct, `a1` falls 0.616 → 0.585 and becomes wrong, and
`a5`/`a6`/`a8` rise but stay under the cut. The default budget is the better operating point
and the misses are judgement, not sampling.

## What this material does not settle

- **One message, one image.** Every case is a single image with a single caption. A box
  carrying several messages or several images is not measured here, the same extrapolation
  the text corpus carries.
- **Synthetic screenshots.** Rendered, not captured: a real screenshot has chrome, scale
  factors and compression that these do not.
- **n = 16.** Eight images per label is a wide interval, and two Chinese cases cannot make
  a language split. The reading is enough to say the requirement is unmet and not enough to
  rank models on vision.
- **The estimator.** The scorer reads the whole next-token distribution; the kernel masks a
  single id per option. That difference is already recorded as an open tension in
  `docs/decisions.md`, and this run neither widens nor narrows it.
- **No rule was changed.** The 0.600 cut is the one measured on the text set. Whether a
  vision-bearing room wants a different cut is a question this set was not written to answer.
