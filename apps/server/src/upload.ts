import type { IncomingMessage, ServerResponse } from "node:http";
import formidable, { errors as formidableErrors, type File as FormidableFile } from "formidable";
import path from "node:path";
import {
  MAX_FILE_SIZE,
  UPLOAD_DIR,
  buildPublicUrl,
  createStoredFileName,
  createUploadFolderForNow,
  getReadableFile,
  isAllowedMimeType,
  resolveRelativePathFromRequestPath,
  sanitizeFileName
} from "./fileStore.js";

const WINDOW_MS = 60_000;
const LIMIT_PER_WINDOW = 20;
const uploadAttemptsByIp = new Map<string, number[]>();

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function setCorsHeaders(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const list = uploadAttemptsByIp.get(ip) ?? [];
  const recent = list.filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT_PER_WINDOW) {
    uploadAttemptsByIp.set(ip, recent);
    return true;
  }
  recent.push(now);
  uploadAttemptsByIp.set(ip, recent);
  return false;
}

function firstFile(files: formidable.Files<string>): FormidableFile | null {
  const values = Object.values(files);
  if (values.length === 0) return null;
  const picked = values[0];
  if (!picked) return null;
  return Array.isArray(picked) ? (picked[0] ?? null) : picked;
}

function isMultipart(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string") return false;
  return contentType.toLowerCase().includes("multipart/form-data");
}

async function parseUpload(req: IncomingMessage): Promise<FormidableFile> {
  const target = await createUploadFolderForNow();
  const form = formidable({
    maxFiles: 1,
    maxFileSize: MAX_FILE_SIZE,
    allowEmptyFiles: false,
    uploadDir: target.folder,
    filename: (_name, _ext, part) => {
      const original = part.originalFilename ?? "file";
      return createStoredFileName(original);
    },
    filter: ({ mimetype }) => isAllowedMimeType((mimetype ?? "").toLowerCase())
  });

  return await new Promise<FormidableFile>((resolve, reject) => {
    form.parse(req, (err, _fields, files) => {
      if (err) {
        reject(err);
        return;
      }
      const file = firstFile(files);
      if (!file) {
        reject(new Error("No file uploaded"));
        return;
      }
      resolve(file);
    });
  });
}

function parseStoredPath(filePath: string): string | null {
  const relNative = path.relative(UPLOAD_DIR, filePath);
  if (!relNative || relNative.startsWith("..")) return null;
  const normalized = relNative.split(path.sep).join("/");
  if (!normalized) return null;
  return normalized;
}

export async function handleUpload(req: IncomingMessage, res: ServerResponse) {
  setCorsHeaders(res);
  if (!isMultipart(req)) {
    sendJson(res, 400, { error: "Expected multipart/form-data" });
    return;
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    sendJson(res, 429, { error: "Too many uploads. Please try again in a minute." });
    return;
  }

  try {
    const file = await parseUpload(req);
    const relativePath = parseStoredPath(file.filepath);
    if (!relativePath) {
      sendJson(res, 500, { error: "Failed to persist uploaded file" });
      return;
    }

    const originalName = sanitizeFileName(file.originalFilename ?? "file");
    const mimeType = (file.mimetype ?? "application/octet-stream").toLowerCase();
    const fileId = file.newFilename.split(".")[0] ?? file.newFilename;
    sendJson(res, 201, {
      fileId,
      url: buildPublicUrl(relativePath, req as { headers: Record<string, string | string[] | undefined> }),
      name: originalName,
      size: file.size,
      mimeType
    });
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? Number((err as { code?: unknown }).code) : null;
    if (code !== null) {
      if (code === 1009) {
        sendJson(res, 413, { error: "File is too large. Max size is 50MB." });
        return;
      }
      if (code === formidableErrors.missingContentType || code === formidableErrors.noParser) {
        sendJson(res, 400, { error: "Expected multipart/form-data" });
        return;
      }
      sendJson(res, 400, { error: "Invalid upload payload" });
      return;
    }
    sendJson(res, 500, { error: err instanceof Error ? err.message : "Upload failed" });
  }
}

export async function handleFileRead(pathname: string, res: ServerResponse) {
  const relativePath = resolveRelativePathFromRequestPath(pathname);
  if (!relativePath) {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }

  const file = await getReadableFile(relativePath);
  if (!file) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }

  res.statusCode = 200;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Length", String(file.size));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  file.stream.pipe(res);
}
