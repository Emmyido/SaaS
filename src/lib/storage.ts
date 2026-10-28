import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf",
};
export const ALLOWED_UPLOADS = Object.keys(EXT);

/**
 * Local-disk storage. Files are served at {PUBLIC_BASE_URL}/uploads/... For production, swap this
 * module for S3/Cloudinary (the rest of the code only uses saveFile/readFile).
 */
export async function saveFile(orgId: string, data: Buffer, mimeType: string): Promise<{ key: string; url: string }> {
  const ext = EXT[mimeType];
  if (!ext) throw new Error(`Unsupported file type ${mimeType}`);
  const key = `${orgId}/${crypto.randomUUID()}.${ext}`;
  const full = path.join(config.uploadDir, key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
  return { key, url: `${config.publicBaseUrl}/uploads/${key}` };
}

export function resolveUploadPath(key: string): string | null {
  const root = path.resolve(config.uploadDir);
  const full = path.resolve(root, key);
  return full.startsWith(root + path.sep) ? full : null;
}

/** Read a file we stored, given its public URL. Returns null for foreign URLs. */
export async function readStoredFile(url: string): Promise<{ data: Buffer; mimeType: string } | null> {
  const prefix = `${config.publicBaseUrl}/uploads/`;
  if (!url.startsWith(prefix)) return null;
  const full = resolveUploadPath(url.slice(prefix.length));
  if (!full) return null;
  const ext = path.extname(full).slice(1);
  const mimeType = Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
  return { data: await fs.readFile(full), mimeType };
}

export function mimeFor(file: string): string {
  const ext = path.extname(file).slice(1);
  return Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
}
