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
  type ServerShape,
} from './llama.ts';
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

  // Then the server itself, before an id is measured on it: an id measured on a
  // server that will read the prompt flat is the right id in the wrong shape, and
  // the reading that comes back would still look like a reading.
  const shape = await requireServerShape(server, skeleton);

  // Then the roster's own claim about which model this is — it costs nothing, the
  // shape is already in hand, and this is the only place the two facts can meet.
  requireServedModel(store, botId, shape);

  const mask = await bindOverServer(server, skeleton, tokens);
  return watchAs(store, botId, llamaWatchModel(server), { ...options, mask });
}

/**
 * Refuse a roster that names one model while this server serves another.
 *
 * `agents.yml` lets a row declare `model` (defaults 15), `Agent.model` carries it, and
 * **until now nothing read it** — so a person could write a model name, get no
 * complaint, and be served by whatever was in front of the port. That is the failure
 * this repository keeps writing about in another form: a number that looks like a
 * verdict. The cut is `0.600` calibrated *against a model*, so a judgement taken from
 * a different one is not the same measurement, and the report would say stage 1 was a
 * real model read without saying which model did the reading.
 *
 * **`unset` is not a claim, so nothing is compared.** It is the roster's default and
 * the shipped row's state: the file has no standing to pick a model (line 26 of the
 * checklist), and inventing a requirement here would refuse every store that never
 * mentioned one.
 *
 * **The comparison is exact, against the two strings the server reports** — its
 * `--alias` and its weights path (`ServerShape`, measured on the real binary). No
 * basename stripping, no extension trimming, no substring: each of those is this
 * function deciding which model a caller meant, and the whole point is that the
 * server is the one who knows. A short name works exactly when the server was
 * started with `--alias`, which is what that flag is for.
 *
 * **A server that names itself not at all cannot confirm a claim, and that is a
 * refusal rather than a pass.** It is the same direction `visionOf` reads `modalities`
 * in: silence is not agreement.
 *
 * The row consulted is the bot's **watch** row, because stage 1 is the watch half —
 * the `work` row's model belongs to the other server, and comparing this one against
 * that would refuse every correct roster. A bot with no watch row declares nothing to
 * compare, which is the same case as `unset`.
 */
function requireServedModel(store: SeekStore, botId: Id, shape: ServerShape): void {
  const declared = store.agentsOf(botId).find((agent) => agent.role === 'watch')?.model;
  if (declared === undefined || declared === 'unset') return;

  const served = [shape.modelAlias, shape.modelPath].filter((name) => name !== '');
  if (served.length === 0) {
    throw new Error(
      `the roster declares model '${declared}' and this server names no model at all, ` +
        'so it cannot confirm the claim: /props carried neither model_alias nor ' +
        'model_path. Silence is not agreement — restart the server with --alias ' +
        `'${declared}', or say 'unset' in the roster row and claim no model`,
    );
  }
  if (served.includes(declared)) return;

  throw new Error(
    `the roster declares model '${declared}' but this server serves ` +
      `${served.map((name) => `'${name}'`).join(' / ')}: the shipped cut was measured ` +
      'against one model, so a judgement taken from another is a different ' +
      'measurement wearing the same number. Restart the server with ' +
      `--alias '${declared}', write the server's own name in the roster row, or say ` +
      "'unset' and claim no model",
  );
}
