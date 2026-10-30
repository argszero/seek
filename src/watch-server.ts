/**
 * Stage 1 wired to a server: a running decision model, as the loop's `Judge`.
 *
 * `watch.ts` is the rules and asks for a `WatchModel`; `llama.ts` is the transport and
 * produces one. Between the two sit three steps that have to happen in this order and in one
 * place:
 *
 * 1. settle the artifact — the prompt, the cut and the option names are one contract
 *    (`prompts.ts`), so they are read together rather than handed in separately;
 * 2. refuse a server that cannot answer this question at all — one that reports no window,
 *    or one whose window cannot hold the smallest state a judgement has
 *    (`requireWatchShape`);
 * 3. refuse a roster that names one model while this server serves another
 *    (`requireServedModel`) — the cut is calibrated against a model, so a run against a
 *    different one is not the same measurement.
 *
 * **What used to be here and is not any more is a fourth step: measuring option ids.** The
 * judgement was once a sentence ending in "Answer act or ignore" with one token read after
 * it, so the ids that spelled `act` had to be measured against the exact text the model
 * would continue from, and measured *before* the runtime was built. A decision model
 * (`/v1/systemone`) is handed its two answers by name and replies with a probability per
 * name, so there is no id to find and nothing to measure: the names travel in the artifact's
 * `question.criteria` and reach the endpoint through `llamaWatchModel`.
 *
 * **No server is started here, and none is stopped.** `LlamaServer.baseUrl` is the origin of
 * a `llama-server` somebody else is running; where the weights live and who supervises that
 * process is stated by no ruling and no measurement, so it is not decided in this file.
 *
 * **No picture reaches the model.** `d1-2B` is a text model and the endpoint takes a
 * `state` string, so a box carrying an image is neither read nor sent: `watch.ts` counts it
 * in `WatchOutcome.unreadPictures` and judges the room on its words. Restoring the picture
 * route needs a model that has one.
 */
import type { Judge } from './inbox.ts';
import { llamaWatchModel, requireWatchShape, type LlamaServer } from './llama.ts';
import { loadPromptArtifact, skeletonOf } from './prompts.ts';
import { requireServedModel } from './served.ts';
import type { SeekStore } from './store.ts';
import type { Id } from './types.ts';
import { declaredOptions, watchAs, type Watch, type WatchOptions } from './watch.ts';

/**
 * What this function needs from the caller: everything `watchAs` takes.
 *
 * It is its own name rather than a re-export of `WatchOptions` because the two are free to
 * drift — the seam's options are the loop's, and this wrapper may want to add one that the
 * rules half has no opinion about.
 */
export type WatchServerOptions = WatchOptions;

/**
 * Bind stage 1 to one bot, over one server, and hand back the loop's `Judge`.
 *
 * Asynchronous because the server is asked about itself over HTTP: this is the one call a
 * caller has to `await` before the kernel can be given its stage 1. Everything it can
 * refuse, it refuses here rather than on the first tick — a runtime bound to a server that
 * cannot hold its question would otherwise start and judge every message off a truncated
 * state.
 */
export async function watchOverServer(
  store: SeekStore,
  botId: Id,
  server: LlamaServer,
  options: WatchServerOptions,
): Promise<Watch> {
  const artifact = options.prompt ?? loadPromptArtifact();
  const tokens = declaredOptions(options.optionTokens);

  // The skeleton is the state with no summary and no entries, which is the smallest state
  // every real judgement contains: a server that cannot hold it cannot serve a single
  // judgement, whatever the caller's own `window` is.
  const shape = await requireWatchShape(server, skeletonOf(artifact).text);

  // Then the roster's own claim about which model this is — it costs nothing, the shape is
  // already in hand, and this is the only place the two facts can meet.
  requireServedModel(store, botId, 'watch', shape);

  return watchAs(store, botId, llamaWatchModel(server), options);
}
