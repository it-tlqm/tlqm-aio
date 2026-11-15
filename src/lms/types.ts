/** The Worker adapter uses Web APIs and D1 only, never the Foundation database connection. */
export type D1Result<T = Record<string, unknown>> = {
  success: boolean;
  results: T[];
  meta: { changes: number };
};
export interface D1Statement {
  bind(...values: (string | number | null | ArrayBuffer)[]): D1Statement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
export interface D1Database {
  prepare(sql: string): D1Statement;
  batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<D1Result<T>[]>;
}
export type MediaObject = {
  key: string;
  size: number;
  etag: string;
  version?: string;
  body?: ReadableStream<Uint8Array>;
};
export interface MediaBucket {
  put(
    key: string,
    value: ReadableStream<Uint8Array>,
    options: { httpMetadata: { contentType: string }; sha256: string },
  ): Promise<MediaObject | null>;
  head(key: string): Promise<MediaObject | null>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number }; onlyIf?: { etagMatches: string } },
  ): Promise<MediaObject | null>;
  delete(key: string): Promise<void>;
}
export type MediaRecord = {
  id: string;
  tenant_id: string;
  owner_unit_id: string;
  kind: 'video' | 'document' | 'image';
  object_key: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  created_by: string;
  created_at: number;
};
