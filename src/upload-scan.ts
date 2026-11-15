export type UploadScan = (
  content: Uint8Array | ReadableStream<Uint8Array>,
) => Promise<'clean' | 'infected'>;
