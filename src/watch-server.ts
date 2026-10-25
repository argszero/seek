/**
 * Stage 1 wired to a server: a running model, in one call, as the loop's `Judge`.
 *
 * `watch.ts` is the rules and asks for a `WatchModel`; `llama.ts` is the transport
 * and produces one. Between the two sit five steps that have to happen in this
 * order and in one place:
 *
 * 1. settle the artifact — the prompt, the cut and the option ids are one contract
 *    (`prompts.ts`, `docs/decisions.md` row 18);
 * 2. refuse a server that cannot be read this way at all — no chat template in
 *    effect, or a window too small for the question alone (`requireServerShape`,
 *    `docs/decisions.md` row 21). Both failures come back as a number rather than as
 *    an error, which is why the check is here and not left to the caller;
 * 3. refuse a roster that names one model while this server serves another
 *    (`requireServedModel`, `docs/decisions.md` row 24) — the one claim in
 *    `agents.yml` nothing else in the kernel reads, and the one a reader is most
 *    likely to believe: the cut is calibrated against a model, so a run against a
 *    different one is not the same measurement;
 * 4. measure the option ids against the text the model will actually continue from,
 *    which for a tokeniser behind HTTP has to happen *before* the runtime is built
 *    (`bindOverServer`, because `watchAs` binds synchronously);
 * 5. build the runtime with that mask.
 *
 * Composing those by hand at each call site is how a mask ends up measured against a
 * different prompt than the one being asked — the failure `agent-lifecycle.md` §4
 * names, where the option is permanently unreachable and the only symptom is a bot
 * that never acts. So the order is a function, not a paragraph in three files.
 *
 * **No server is started here, and none is stopped.** `LlamaServer.baseUrl` is the
 * origin of a `llama-server` somebody else is running; where the weights live and
 * who supervises that process is stated by no ruling and no measurement, so it is
 * not decided in this file. `docs/decisions.md` row 20 records the default as it
 * stands, together with the word that would change it.
 *
 * **A box carrying a picture needs `server.loadMedia`, and that is the caller's.**
 * `box.ts` keeps a picture's `key` opaque — how a client names a file is its business
 * — so the bytes come in through a loader travelling on the same `LlamaServer` object
 * this function is handed. Without one, a picture-bearing judgement is refused rather
 * than read from its caption (`llama.ts`, `docs/decisions.md` row 23). Nothing else
 * here changes for it: the four steps above measure the *text*, and a reading is keyed
 * by the option's own token rather than by an id (`probabilityOf`), so a picture
 * changes what the model sees and not how its answer is named.
 */
import type { Judge } from './inbox.ts';
import {
  bindOverServer,
  llamaWatchModel,
  requireServerShape,
  type LlamaServer,
} from './llama.ts';
import { loadPromptArtifact, skeletonOf } from './prompts.ts';
import { requireServedModel } from './served.ts';
import type { SeekStore } from './store.ts';
import type { Id } from './types.ts';
import { declaredOptions, watchAs, type Watch, type WatchOptions } from './watch.ts';

/**
 * What this function needs from the caller: everything `watchAs` takes except the
 * two fields it supplies itself.
 *
 * `tokeniser` and `mask` are left out on purpose rather than merely ignored. Both
 * are answers to "where is this prompt's answer read", and here that answer is
 * measured from the server, which is the only thing that can speak for this model's
 * vocabulary — a caller passing either one alongside a server would be stating a
 * second opinion about the same fact.
 */
export type WatchServerOptions = Omit<WatchOptions, 'mask' | 'tokeniser'>;

/**
 * Bind stage 1 to one bot, over one server, and hand back the loop's `Judge`.
 *
 * Asynchronous because the ids are measured over HTTP: this is the one call a caller
 * has to `await` before the kernel can be given its stage 1. Everything it can
 * refuse, it refuses here rather than on the first tick — a runtime whose mask was
 * taken from another question would otherwise run happily and never act.
 */
export async function watchOverServer(
  store: SeekStore,
  botId: Id,
  server: LlamaServer,
  options: WatchServerOptions,
): Promise<Watch> {
  const artifact = options.prompt ?? loadPromptArtifact();
  const tokens = declaredOptions(options.optionTokens);

  // The mask is measured on the skeleton — the assembly with no summary and no
  // entries — because that is the text whose end every real assembly shares
  // (`watchAs` measures its own mask the same way). Which makes the skeleton the
  // artifact's answer to "where does the question end", and two artifacts that
  // disagree there are two questions: one mask cannot serve both, and the failure
  // would be a silently unreachable option rather than an error.
  const skeleton = skeletonOf(artifact);
  if (skeleton.text !== skeletonOf(server.artifact).text) {
    throw new Error(
      'the server and the runtime are bound to artifacts that ask different questions: ' +
        'the option ids are measured on the text this runtime will assemble, so a mask ' +
        'taken under one question cannot answer the other',
    );
  }

  // Then the server itself, before an id is measured on it: an id measured on a
  // server that will read the prompt flat is the right id in the wrong shape, and
  // the reading that comes back would still look like a reading.
  const shape = await requireServerShape(server, skeleton);

  // Then the roster's own claim about which model this is — it costs nothing, the
  // shape is already in hand, and this is the only place the two facts can meet.
  requireServedModel(store, botId, 'watch', shape);

  const mask = await bindOverServer(server, skeleton, tokens);
  return watchAs(store, botId, llamaWatchModel(server), { ...options, mask });
}
