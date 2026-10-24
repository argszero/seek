/**
 * Stage 1 wired to a server: a running model, in one call, as the loop's `Judge`.
 *
 * `watch.ts` is the rules and asks for a `WatchModel`; `llama.ts` is the transport
 * and produces one. Between the two sit three steps that have to happen in this
 * order and in one place:
 *
 * 1. settle the artifact — the prompt, the cut and the option ids are one contract
 *    (`prompts.ts`, `docs/decisions.md` row 18);
 * 2. measure the option ids against the text the model will actually continue from,
 *    which for a tokeniser behind HTTP has to happen *before* the runtime is built
 *    (`bindOverServer`, because `watchAs` binds synchronously);
 * 3. build the runtime with that mask.
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
 */
import type { Judge } from './inbox.ts';
import { bindOverServer, llamaWatchModel, type LlamaServer } from './llama.ts';
import { loadPromptArtifact, skeletonOf } from './prompts.ts';
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

  const mask = await bindOverServer(server, skeleton, tokens);
  return watchAs(store, botId, llamaWatchModel(server), { ...options, mask });
}
