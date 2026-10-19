type InlineImageRef = {
  readonly cid: string;
  readonly assetId: string;
  readonly mimeType: "image/png";
};

const MAX_IMAGE_BYTES = 262144;
const PNG_HEADER = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A manifest is derived from the immutable document, never from fetched bytes.
export function snapshotImageRefs(source: Record<string, unknown>): readonly InlineImageRef[] | null {
  const lesson = source.lesson;
  const document = isRecord(lesson) && isRecord(lesson.document) ? lesson.document : null;
  const visuals: unknown = document?.visuals ?? [];
  if (!Array.isArray(visuals) || visuals.length > 3) return null;
  const expected = new Set<string>();
  for (const visual of visuals) {
    if (!isRecord(visual) || typeof visual.emailAssetId !== "string" || !/^[0-9a-f]{64}$/.test(visual.emailAssetId)) return null;
    expected.add(visual.emailAssetId);
  }
  const value: unknown = source.inlineImageRefs ?? [];
  if (!Array.isArray(value) || value.length !== expected.size) return null;
  const refs: InlineImageRef[] = [];
  const seen = new Set<string>();
  for (const ref of value) {
    if (!isRecord(ref) || typeof ref.assetId !== "string" || !expected.has(ref.assetId) ||
        ref.cid !== `visual-${ref.assetId}` || ref.mimeType !== "image/png" || seen.has(ref.assetId)) return null;
    seen.add(ref.assetId);
    refs.push({ cid: ref.cid, assetId: ref.assetId, mimeType: ref.mimeType });
  }
  if (refs.length && (typeof source.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(source.contentHash) ||
      typeof source.snapshotId !== "string" || !/^[0-9a-fA-F-]{36}$/.test(source.snapshotId))) return null;
  if (refs.length && isRecord(lesson) && lesson.contentHash !== undefined && lesson.contentHash !== source.contentHash) return null;
  return refs.sort((left, right) => left.assetId.localeCompare(right.assetId));
}

export function htmlMatchesImageRefs(html: string, refs: readonly InlineImageRef[]): boolean {
  const pattern = /<img\b[^>]*\bsrc\s*=\s*(?:"cid:([^"]*)"|'cid:([^']*)'|cid:([^\s>]+))/gi;
  const cids = new Set(Array.from(html.matchAll(pattern), (match) => match[1] ?? match[2] ?? match[3] ?? ""));
  return cids.size === refs.length && refs.every((ref) => cids.has(ref.cid));
}

export async function validInlineImages(source: Record<string, unknown>): Promise<boolean> {
  const refs = snapshotImageRefs(source);
  const images: unknown = source.inlineImages ?? [];
  if (refs === null || !Array.isArray(images) || images.length !== refs.length) return false;
  if (typeof source.html === "string" && !htmlMatchesImageRefs(source.html, refs)) return false;
  const seen = new Set<string>();
  for (const image of images) {
    if (!isRecord(image) || typeof image.cid !== "string" || seen.has(image.cid)) return false;
    const ref = refs.find((entry) => entry.cid === image.cid);
    if (ref === undefined || image.assetId !== ref.assetId || image.mimeType !== ref.mimeType || typeof image.base64 !== "string") return false;
    const base64 = image.base64;
    if (base64.length === 0 || base64.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) || base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return false;
    const decoded = atob(base64);
    if (decoded.length < 33 || decoded.length > MAX_IMAGE_BYTES || btoa(decoded) !== base64) return false;
    const bytes = Uint8Array.from(decoded, (byte) => byte.charCodeAt(0));
    if (PNG_HEADER.some((byte, index) => bytes[index] !== byte)) return false;
    const dimensions = new DataView(bytes.buffer);
    if (dimensions.getUint32(16) < 1 || dimensions.getUint32(16) > 2048 || dimensions.getUint32(20) < 1 || dimensions.getUint32(20) > 2048) return false;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hash !== ref.assetId) return false;
    seen.add(image.cid);
  }
  return true;
}
