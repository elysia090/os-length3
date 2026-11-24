/** A trusted build's sidecar for one root and one decoded Sods translator. */
export interface MappedCodeManifest {
  readonly version: 1;
  readonly generation: string;
  readonly translator: string;
  readonly pieces: readonly MappedCodeArtifact[];
}

export interface MappedCodeArtifact {
  readonly origin: string;
  readonly sourceSize: number;
  readonly sourceSha256: string;
  readonly text: {
    readonly role: 'main' | 'interpreter' | 'library';
    readonly bias: number;
    readonly address: number;
    readonly offset: number;
    readonly length: number;
  };
  readonly entry: number;
  readonly sha256: string;
  readonly bytes: number;
}
