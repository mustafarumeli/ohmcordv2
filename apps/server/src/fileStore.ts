import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

const FALLBACK_UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
const PUBLIC_FILE_BASE_URL = (process.env.PUBLIC_FILE_BASE_URL ?? "").trim();

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR ?? FALLBACK_UPLOAD_DIR);
export const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE ?? 50 * 1024 * 1024);

const ALLOWED_MIME_TYPES = new Set<string>([
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain"
]);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

export type StoredFileMeta = {
  fileId: string;
  url: string;
  name: string;
  size: number;
  mimeType: string;
  relativePath: string;
};

export function isAllowedMimeType(mimeType: string): boolean {
  if (!mimeType) return false;
  if (mimeType.startsWith("image/")) return true;
  return ALLOWED_MIME_TYPES.has(mimeType);
}

export function sanitizeFileName(input: string): string {
  const cleaned = input.replace(/[^\w.\- ]+/g, "").trim();
  if (!cleaned) return "file";
  return cleaned.slice(0, 120);
}

export function safeExtension(fileName: string): string {
  const raw = path.extname(fileName).toLowerCase();
  if (!raw) return "";
  if (!/^\.[a-z0-9]{1,10}$/.test(raw)) return "";
  return raw;
}

export async function createUploadTarget(originalFileName: string) {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const folder = path.join(UPLOAD_DIR, year, month);
  await mkdir(folder, { recursive: true });

  const fileId = randomUUID().replace(/-/g, "");
  const ext = safeExtension(originalFileName);
  const storedName = `${fileId}${ext}`;
  return {
    fileId,
    folder,
    storedName,
    relativePath: `${year}/${month}/${storedName}`
  };
}

export async function createUploadFolderForNow(): Promise<{ folder: string; relativePrefix: string }> {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const relativePrefix = `${year}/${month}`;
  const folder = path.join(UPLOAD_DIR, relativePrefix);
  await mkdir(folder, { recursive: true });
  return { folder, relativePrefix };
}

export function createStoredFileName(originalFileName: string): string {
  const fileId = randomUUID().replace(/-/g, "");
  const ext = safeExtension(originalFileName);
  return `${fileId}${ext}`;
}

export function buildPublicUrl(relativePath: string, req: { headers: Record<string, string | string[] | undefined> }): string {
  if (PUBLIC_FILE_BASE_URL) {
    return `${PUBLIC_FILE_BASE_URL.replace(/\/+$/, "")}/${relativePath}`;
  }
  const host = (typeof req.headers.host === "string" ? req.headers.host : "localhost:8080").trim();
  const protoHeader = req.headers["x-forwarded-proto"];
  const proto = typeof protoHeader === "string" ? protoHeader.split(",")[0].trim() : "http";
  return `${proto}://${host}/files/${relativePath}`;
}

export function resolveRelativePathFromRequestPath(pathname: string): string | null {
  const rel = pathname.replace(/^\/files\//, "").trim();
  if (!rel) return null;
  if (rel.includes("\0")) return null;
  const normalized = path.posix.normalize(rel);
  if (normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") return null;
  return normalized;
}

export function resolveAbsoluteUploadPath(relativePath: string): string | null {
  const abs = path.resolve(UPLOAD_DIR, relativePath);
  const root = path.resolve(UPLOAD_DIR);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (abs !== root && !abs.startsWith(rootPrefix)) return null;
  return abs;
}

export async function getReadableFile(relativePath: string): Promise<{ stream: NodeJS.ReadableStream; size: number; mimeType: string } | null> {
  const absPath = resolveAbsoluteUploadPath(relativePath);
  if (!absPath) return null;
  try {
    const info = await stat(absPath);
    if (!info.isFile()) return null;
    const ext = path.extname(absPath).toLowerCase();
    return {
      stream: createReadStream(absPath),
      size: info.size,
      mimeType: MIME_BY_EXT[ext] ?? "application/octet-stream"
    };
  } catch {
    return null;
  }
}
