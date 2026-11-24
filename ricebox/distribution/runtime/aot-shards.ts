import {aotFraming, type AotShard} from '../format/aot-frames.ts';
import type {DeployedWasm} from '../format/manifest.ts';
import type {createAssetCache} from './asset-cache.ts';
import {download, type Options, type Progress} from './download.ts';

type CachePort = Pick<ReturnType<typeof createAssetCache>, 'open' | 'keep' | 'gone' | 'used'>;
type ShardOptions = Pick<Options, 'fetch' | 'message' | 'stallMs' | 'backoff' | 'attempts' | 'check'>;

async function verifiedShard(url: string, shard: AotShard, cache: CachePort, signal: AbortSignal, progress?: Progress, options?: ShardOptions) {
  signal.throwIfAborted();
  const shelf = await cache.open();
  const cached = await shelf?.match(url).catch(() => undefined);
  const downloadOptions = {...options, signal, maxBytes: shard.size, retainPartial: false};
  const expect = {size: shard.size, sha256: shard.sha256};
  signal.throwIfAborted();
  if (cached) {
    try {
      const bytes = await download(url, expect, progress, {...downloadOptions, attempts: 1, fetch: async () => cached});
      cache.used(url);
      return bytes;
    } catch (error) {
      signal.throwIfAborted();
      // A bad durable copy must not reach the compiler or poison the retry.
      if (shelf && await shelf.delete(url).catch(() => false)) cache.gone(shelf, url);
    }
  }
  const bytes = await download(url, expect, progress, downloadOptions);
  signal.throwIfAborted();
  if (shelf) await cache.keep(url, bytes);
  signal.throwIfAborted();
  return bytes;
}

/** One ordered logical body. Only the active object and a single prefetched
 * verified object can be held. The reader's cancellation drains the latter. */
export function shardedAotResponse(asset: DeployedWasm, base: string, cache: CachePort, outer: AbortSignal,
                                   progress?: Progress, options?: ShardOptions): Response {
  const framing = aotFraming(asset);
  if (!framing?.shards) throw new Error('expected physical AOT shards');
  const shards = framing.shards.map(shard => ({...shard}));
  const stop = new AbortController(), signal = AbortSignal.any([outer, stop.signal]);
  let index = 0, inflight: Promise<void> | undefined;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === shards.length) { controller.close(); return; }
      const shard = shards[index++]!;
      const step = progress && {
        bytes: (n: number) => progress.bytes(shard.at + n),
        retry: (attempt: number, why: string) => progress.retry(attempt, why),
        waiting: (quiet: number) => progress.waiting?.(quiet),
      };
      inflight = verifiedShard(new URL(shard.path, base).href, shard, cache, signal, step, options).then(bytes => {
        signal.throwIfAborted();
        controller.enqueue(bytes);
      });
      return inflight;
    },
    async cancel(reason) {
      stop.abort(reason);
      await inflight?.catch(() => {});
    },
  }, {highWaterMark: 1});
  return new Response(body);
}
