// The Remote on Cloudflare: remote.ts over an R2 bucket. Deployed apart from
// the app (remote/wrangler.toml); the app's origins are the only pages that
// may call it.
import {handle, type Bucket} from './remote.ts';

interface R2Object { etag: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }
interface R2Bucket {
  get(key: string, options?: {range?: {offset: number; length?: number}}): Promise<R2Object | null>;
  head(key: string): Promise<{etag: string} | null>;
  put(key: string, value: Uint8Array, options?: {onlyIf?: {etagMatches?: string} | Headers}): Promise<{etag: string} | null>;
}

function r2(b: R2Bucket): Bucket {
  return {
    async get(key) { const o = await b.get(key); return o ? {bytes: new Uint8Array(await o.arrayBuffer()), etag: o.etag} : null; },
    async head(key) { return (await b.head(key)) !== null; },
    async range(key, start, end) {
      const o = await b.get(key, {range: {offset: start, ...(end === null ? {} : {length: end - start + 1})}});
      return o ? {bytes: new Uint8Array(await o.arrayBuffer()), size: o.size} : null;
    },
    async put(key, bytes, onlyIf) {
      // R2 answers null when the condition does not hold.
      const options = onlyIf?.absent ? {onlyIf: new Headers({'If-None-Match': '*'})}
        : onlyIf?.etag !== undefined ? {onlyIf: {etagMatches: onlyIf.etag}} : undefined;
      const o = await b.put(key, bytes, options);
      return o ? {etag: o.etag} : null;
    },
  };
}

export default {
  fetch(request: Request, env: {REMOTE: R2Bucket; APP_ORIGINS?: string}) {
    return handle(request, r2(env.REMOTE), {origins: (env.APP_ORIGINS ?? '').split(/\s+/).filter(Boolean)});
  },
};
