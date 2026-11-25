import {PreparedMappedTrace} from '../../../../../../sods/runtime/linux.ts';
import {lendRaster, rasterFile, type Raster} from '../../../support/mirror-raster.ts';

type Frame = Pick<Raster, 'sequence' | 'width' | 'height'>;
type End = 'raster' | 'geometry-changed' | 'closed' | 'error';
type Source = {path: string; origin: string};

/** Only the explicit pointer-plus-prepared fixture asks for this receipt. */
export class PreparedClickDiagnostics {
  readonly trace = new PreparedMappedTrace();
  #indexSha256: string;
  #paths: Map<string, Source>;
  #frame?: Frame;
  #contact?: Frame;

  constructor(indexSha256: string, sources: readonly Source[]) {
    this.#indexSha256 = indexSha256;
    this.#paths = new Map(sources.map(({path, origin}) => [origin, {path, origin}]));
  }

  input(bytes: Uint8Array): void {
    const frame = this.#frame;
    if (!this.#contact && frame && bytes.length === 3 && bytes[0] === 1 && bytes[1] < frame.width && bytes[2] < frame.height) {
      this.#contact = frame;
      this.trace.begin();
    }
  }

  frame(files: readonly {path: string; bytes: Uint8Array}[]) {
    let bytes: Uint8Array | undefined;
    for (const file of files) if (file.path === rasterFile) {
      if (bytes) return;
      bytes = file.bytes;
    }
    const frame = bytes && lendRaster(bytes);
    if (!frame || (this.#frame && frame.sequence <= this.#frame.sequence)) return;
    const {sequence, width, height} = frame;
    this.#frame = {sequence, width, height};
    const contact = this.#contact;
    if (this.trace.recording && contact && sequence > contact.sequence)
      return this.finish(width === contact.width && height === contact.height ? 'raster' : 'geometry-changed', sequence);
  }

  finish(end: End, toSequence?: number) {
    const result = this.trace.finish();
    if (!result) return;
    return {indexSha256: this.#indexSha256, end, fromSequence: this.#contact?.sequence, toSequence,
      omitted: result.omitted, samples: result.samples.map(({origin, ...sample}) => ({...sample, elf: this.#paths.get(origin) ?? null}))};
  }
}
