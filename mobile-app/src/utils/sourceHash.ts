/**
 * SHA-256 fingerprint of an EPUB file for monthly retry-doesn't-count dedup.
 *
 * Hashes the first 64 KB of the file's raw bytes, deterministically across
 * platforms — the backend matches against the same hash to detect that a
 * user is re-converting a book they already converted this month (different
 * voice, etc) so it doesn't burn another conversion slot.
 *
 * 64 KB is more than enough to identify an EPUB uniquely (it covers all of
 * the OPF + the start of the first content file) while staying cheap to
 * compute on a phone.
 */
import { Platform } from 'react-native';
import { sha256 } from 'js-sha256';

const CHUNK_BYTES = 64 * 1024;

let FileSystem: any = null;
if (Platform.OS !== 'web') {
  FileSystem = require('expo-file-system');
}

/**
 * Decode a base64 string into a Uint8Array using whatever decoder the
 * platform exposes — `atob` on web/modern RN, `Buffer` as fallback.
 *
 * Typed loosely on purpose: tsc's React-Native lib doesn't include DOM,
 * so `atob` and `Buffer` both look "missing" at compile time. They exist
 * at runtime on every platform we ship to.
 */
function base64ToBytes(b64: string): Uint8Array {
  const g = globalThis as any;
  const binary: string = typeof g.atob === 'function'
    ? g.atob(b64)
    : g.Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Compute the source hash for a picked EPUB file.
 *
 * On web, expects a `Blob` or `File` (the original `file` from `<input>`).
 * On native, expects a local file URI (`file://...` from expo-document-picker).
 *
 * Returns null on any failure — the caller should treat a null hash as
 * "no dedup possible" and proceed normally; the backend tolerates a missing
 * source_hash field (the conversion just always counts toward the limit).
 */
export async function computeEpubSourceHash(
  uri: string,
  fileObj?: any,
): Promise<string | null> {
  try {
    let bytes: Uint8Array;

    if (Platform.OS === 'web') {
      const blob = fileObj ?? await (await fetch(uri)).blob();
      if (!blob) return null;
      const slice = blob.slice(0, CHUNK_BYTES);
      const buf: ArrayBuffer = await slice.arrayBuffer();
      bytes = new Uint8Array(buf);
    } else {
      if (!FileSystem) return null;
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
        length: CHUNK_BYTES,
        position: 0,
      });
      bytes = base64ToBytes(base64);
      // Defensive clamp: if `length` is silently ignored by an older
      // expo-file-system (older RN dev clients can ship a JS shim ahead
      // of the native side), the whole file gets read.  Hashing the full
      // file would still be deterministic, but it would mismatch the
      // 64-KB hashes produced by other clients and break dedup silently.
      if (bytes.length > CHUNK_BYTES) {
        bytes = bytes.subarray(0, CHUNK_BYTES);
      }
    }

    return sha256(bytes);
  } catch (err) {
    console.warn('[sourceHash] failed to compute hash:', err);
    return null;
  }
}
