import type { OperationId } from '../contract';

// Three operations upload a file as multipart/form-data (KYC photo, dispute
// evidence, support attachment). Screens hand them the photo as a data URI in
// `file`; the server wants the raw bytes in a form part. The body is built by
// hand as bytes: Hermes cannot build a Blob from bytes, and this is identical
// on the web, so one tested path serves every platform.

export const MULTIPART_OPERATIONS: ReadonlySet<OperationId> = new Set([
  'uploadKycDocument',
  'addDisputeEvidence',
  'uploadSupportAttachment',
]);

export interface EncodedForm {
  bytes: Uint8Array;
  contentType: string;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DATA_URI = /^data:([\w.+-]+\/[\w.+-]+)?(;[^,]*)?,(.*)$/s;

/** Standard base64 (what a data URI carries) to bytes. */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[\s=]+/g, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE64.indexOf(char);
    if (value < 0) throw new TypeError('The photo is not valid base64');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/** Strips characters that could end a header line or a quoted value. */
const safe = (text: string) => text.replace(/[\r\n"\\]/g, '');

/**
 * Encodes a flat object as multipart/form-data. A field named `file` must be a
 * base64 data URI and becomes the file part; every other field is sent as text.
 */
export function encodeMultipart(
  fields: Record<string, unknown>,
  boundary = `nem${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
): EncodedForm {
  const chunks: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (name === 'file') {
      const match = typeof value === 'string' ? DATA_URI.exec(value) : null;
      if (!match || !match[2]?.includes('base64')) {
        throw new TypeError('The photo must be a base64 data URI');
      }
      chunks.push(
        utf8(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"\r\n` +
            `Content-Type: ${match[1] ?? 'application/octet-stream'}\r\n\r\n`,
        ),
        decodeBase64(match[3]!),
        utf8('\r\n'),
      );
    } else {
      chunks.push(
        utf8(
          `--${boundary}\r\nContent-Disposition: form-data; name="${safe(name)}"\r\n\r\n` +
            `${String(value)}\r\n`,
        ),
      );
    }
  }
  chunks.push(utf8(`--${boundary}--\r\n`));

  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes, contentType: `multipart/form-data; boundary=${boundary}` };
}
