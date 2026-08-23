import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "127.0.0.1";
const publicDir = resolve("public");
const downloadRoot = resolve(process.env.DOWNLOAD_DIR || join(tmpdir(), "ytmp"));
const maxBodyBytes = 16 * 1024;
const maxConcurrentDownloads = positiveInteger(process.env.MAX_CONCURRENT_DOWNLOADS, 1);
const concurrentFragments = positiveInteger(process.env.CONCURRENT_FRAGMENTS, 4);
const maxFileSizeMb = positiveInteger(process.env.MAX_FILE_SIZE_MB, 4096);
const maxFileSizeBytes = maxFileSizeMb * 1024 * 1024;
const minFreeDiskMb = positiveInteger(process.env.MIN_FREE_DISK_MB, 5120);
const minFreeDiskBytes = minFreeDiskMb * 1024 * 1024;
const downloadJobTtl = positiveInteger(process.env.JOB_TTL_MINUTES, 15) * 60_000;
const downloadTimeout = positiveInteger(process.env.DOWNLOAD_TIMEOUT_MINUTES, 120) * 60_000;
const downloadJobs = new Map();
const pendingDownloads = [];
let activeDownloads = 0;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function isValidMediaUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBodyBytes) throw new Error("Request is too large.");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function runYtDlp(args, { timeout = 45_000, maxOutput = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("The media host took too long to respond."));
    }, timeout);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolvePromise(value);
    }

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(new Error("yt-dlp is not installed on this server."));
      } else {
        finish(error);
      }
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutput) {
        child.kill("SIGKILL");
        finish(new Error("The media response was too large."));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    child.on("close", (code) => {
      if (code === 0) return finish(null, stdout);
      let message = stderr.trim().split("\n").at(-1)?.replace(/^ERROR:\s*/, "");
      if (message?.includes("The page needs to be reloaded")) {
        message = "YouTube rejected the installed yt-dlp version. Update yt-dlp on the server and try again.";
      }
      finish(new Error(message || "yt-dlp could not read this URL."));
    });
  });
}

function uniqueSortedNumbers(values) {
  return [...new Set(values.filter(Number.isFinite).map(Math.round))].sort((a, b) => b - a);
}

function summarizeFormats(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const videoHeights = uniqueSortedNumbers(
    formats.filter((format) => format.vcodec && format.vcodec !== "none").map((format) => Number(format.height)),
  );
  const audioBitrates = uniqueSortedNumbers(
    formats
      .filter((format) => format.acodec && format.acodec !== "none" && (!format.vcodec || format.vcodec === "none"))
      .map((format) => Number(format.abr || format.tbr)),
  );

  return {
    title: String(info.title || "Untitled media").slice(0, 180),
    uploader: String(info.uploader || info.channel || "Unknown source").slice(0, 100),
    duration: Number.isFinite(info.duration) ? Math.round(info.duration) : null,
    thumbnail: typeof info.thumbnail === "string" ? info.thumbnail : null,
    qualities: {
      mp3: audioBitrates.length ? audioBitrates.slice(0, 8) : ["best"],
      mp4: videoHeights.length ? videoHeights.slice(0, 10) : ["best"],
    },
  };
}

async function inspectMedia(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  if (!isValidMediaUrl(body.url)) {
    return sendJson(res, 400, { error: "Paste a valid http or https media URL." });
  }

  try {
    const output = await runYtDlp([
      "--dump-single-json",
      "--no-playlist",
      "--no-warnings",
      "--skip-download",
      body.url,
    ]);
    sendJson(res, 200, summarizeFormats(JSON.parse(output)));
  } catch (error) {
    sendJson(res, 422, { error: error.message });
  }
}

function safeDownloadName(filename) {
  return filename.replace(/[\r\n"\\]/g, "_");
}

function contentDisposition(filename) {
  const safeName = safeDownloadName(filename);
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function hasValidDownloadOptions(mediaUrl, type, qualityParam) {
  const quality = Number(qualityParam);
  return isValidMediaUrl(mediaUrl) && ["mp3", "mp4"].includes(type) &&
    (qualityParam === "best" || Number.isFinite(quality));
}

function sendJobEvent(job, event, data) {
  job.lastEvent = { event, data };
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const listener of job.listeners) listener.write(payload);
}

async function removeJob(job) {
  clearTimeout(job.removalTimer);
  for (const listener of job.listeners) listener.end();
  job.listeners.clear();
  downloadJobs.delete(job.id);
  if (job.directory) await rm(job.directory, { recursive: true, force: true });
}

async function cleanupOrphanedDownloads() {
  const entries = await readdir(downloadRoot, { withFileTypes: true });
  const now = Date.now();
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name) || downloadJobs.has(entry.name)) return;
    const directory = join(downloadRoot, entry.name);
    const directoryStat = await stat(directory);
    if (now - directoryStat.mtimeMs >= downloadJobTtl) {
      await rm(directory, { recursive: true, force: true });
    }
  }));
}

function scheduleJobRemoval(job) {
  clearTimeout(job.removalTimer);
  job.removalTimer = setTimeout(() => void removeJob(job).catch(console.error), downloadJobTtl);
  job.removalTimer.unref();
}

async function freeDiskBytes() {
  const disk = await statfs(downloadRoot);
  return disk.bavail * disk.bsize;
}

function normalizeYtDlpError(message) {
  const clean = message?.replace(/^ERROR:\s*/, "").trim();
  if (clean?.includes("The page needs to be reloaded")) {
    return "YouTube rejected the installed yt-dlp version. Update yt-dlp on the server and try again.";
  }
  return clean || "The download failed.";
}

function parseProgressLine(job, line) {
  if (!line.startsWith("ytmp:")) return false;
  const [downloadedRaw, totalRaw, estimateRaw, etaRaw, speedRaw, status] = line.slice(5).split("|");
  const downloaded = Number(downloadedRaw);
  const exactTotal = Number(totalRaw);
  const estimatedTotal = Number(estimateRaw);
  const currentTotal = Number.isFinite(exactTotal) ? exactTotal : estimatedTotal;
  const phaseBase = job.completedBytes;

  sendJobEvent(job, "progress", {
    status,
    downloadedBytes: phaseBase + (Number.isFinite(downloaded) ? downloaded : 0),
    totalBytes: Number.isFinite(currentTotal) ? phaseBase + currentTotal : null,
    totalIsEstimate: !Number.isFinite(exactTotal),
    etaSeconds: Number.isFinite(Number(etaRaw)) ? Number(etaRaw) : null,
    bytesPerSecond: Number.isFinite(Number(speedRaw)) ? Number(speedRaw) : null,
  });

  if (status === "finished" && !job.phaseFinished) {
    job.completedBytes += Number.isFinite(downloaded) ? downloaded : 0;
    job.phaseFinished = true;
  } else if (status === "downloading") {
    job.phaseFinished = false;
  }
  return true;
}

function buildDownloadArgs(job) {
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--concurrent-fragments",
    String(concurrentFragments),
    "--max-filesize",
    `${maxFileSizeMb}M`,
    "--progress-template",
    "download:ytmp:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.eta)s|%(progress.speed)s|%(progress.status)s",
    "-o",
    join(job.directory, "media.%(ext)s"),
  ];

  if (job.type === "mp3") {
    const audioQuality = job.quality === "best" ? "0" : `${Math.max(32, Math.min(320, Number(job.quality)))}K`;
    args.push("-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", audioQuality);
  } else {
    const maxHeight = Math.max(144, Math.min(4320, Number(job.quality)));
    const selector = job.quality === "best"
      ? "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[ext=mp4]/best"
      : `bestvideo[height<=${maxHeight}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=${maxHeight}][ext=mp4]/best`;
    args.push("-f", selector, "--merge-output-format", "mp4", "--remux-video", "mp4");
  }

  args.push(job.url);
  return args;
}

async function findPreparedFile(job) {
  const expectedPath = join(job.directory, `media.${job.type}`);
  if (existsSync(expectedPath)) return expectedPath;
  const entries = await readdir(job.directory, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".part") && !entry.name.endsWith(".ytdl"))
    .map((entry) => join(job.directory, entry.name));
  return candidates.length === 1 ? candidates[0] : null;
}

async function prepareDownload(job) {
  activeDownloads += 1;
  clearTimeout(job.removalTimer);
  job.status = "preparing";
  job.directory = join(downloadRoot, job.id);
  let child;
  let diskTimer;
  let timeout;
  let lastError = "";

  try {
    await mkdir(job.directory, { recursive: true });
    if ((await freeDiskBytes()) < minFreeDiskBytes) {
      throw new Error(`The server has less than ${minFreeDiskMb} MB of free disk space.`);
    }

    sendJobEvent(job, "state", { status: "downloading" });
    child = spawn("yt-dlp", buildDownloadArgs(job), { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const consumeLines = (source, chunk) => {
      const combined = `${source === "stdout" ? stdoutBuffer : stderrBuffer}${chunk}`;
      const lines = combined.split("\n");
      if (source === "stdout") stdoutBuffer = lines.pop() || "";
      else stderrBuffer = lines.pop() || "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (parseProgressLine(job, line)) continue;
        if (line.startsWith("ERROR:")) lastError = line;
        if (/^\[(ExtractAudio|Merger|VideoRemuxer|Metadata)\]/.test(line)) {
          sendJobEvent(job, "state", { status: job.type === "mp3" ? "converting" : "merging" });
        }
      }
    };

    child.stdout.on("data", (chunk) => consumeLines("stdout", String(chunk)));
    child.stderr.on("data", (chunk) => consumeLines("stderr", String(chunk)));
    diskTimer = setInterval(async () => {
      try {
        if ((await freeDiskBytes()) < minFreeDiskBytes) {
          lastError = `The server reached its ${minFreeDiskMb} MB free-space reserve.`;
          child.kill("SIGKILL");
        }
      } catch (error) {
        console.error(error);
      }
    }, 5000);
    diskTimer.unref();
    timeout = setTimeout(() => {
      lastError = "The download exceeded the server time limit.";
      child.kill("SIGKILL");
    }, downloadTimeout);
    timeout.unref();

    const exitCode = await new Promise((resolvePromise, reject) => {
      child.once("error", (error) => {
        reject(new Error(error.code === "ENOENT" ? "yt-dlp is not installed on this server." : error.message));
      });
      child.once("close", resolvePromise);
    });
    if (exitCode !== 0) throw new Error(normalizeYtDlpError(lastError));

    const filePath = await findPreparedFile(job);
    if (!filePath) throw new Error("yt-dlp finished without creating a downloadable file.");
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size === 0) throw new Error("The prepared file is empty.");
    if (fileStat.size > maxFileSizeBytes) throw new Error(`The prepared file exceeds the ${maxFileSizeMb} MB limit.`);

    job.filePath = filePath;
    job.fileSize = fileStat.size;
    job.status = "ready";
    sendJobEvent(job, "ready", {
      status: "ready",
      sizeBytes: job.fileSize,
      downloadUrl: `/api/downloads/${job.id}/file`,
    });
  } catch (error) {
    job.status = "failed";
    sendJobEvent(job, "failure", { status: "failed", error: normalizeYtDlpError(error.message) });
  } finally {
    clearInterval(diskTimer);
    clearTimeout(timeout);
    activeDownloads -= 1;
    scheduleJobRemoval(job);
    pumpDownloadQueue();
  }
}

function pumpDownloadQueue() {
  while (activeDownloads < maxConcurrentDownloads && pendingDownloads.length) {
    const job = pendingDownloads.shift();
    if (!job || !downloadJobs.has(job.id) || job.status !== "waiting") continue;
    void prepareDownload(job);
  }
}

async function createDownloadJob(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const qualityParam = String(body.quality ?? "");
  if (!hasValidDownloadOptions(body.url, body.type, qualityParam)) {
    return sendJson(res, 400, { error: "The download options are invalid." });
  }
  if (downloadJobs.size >= 100) {
    return sendJson(res, 503, { error: "The server has too many pending downloads." });
  }

  const job = {
    id: randomUUID(), url: body.url, type: body.type, quality: qualityParam,
    title: String(body.title || "download").slice(0, 160), listeners: new Set(),
    lastEvent: { event: "state", data: { status: "waiting" } }, status: "waiting",
    directory: null, filePath: null, fileSize: null, completedBytes: 0,
    phaseFinished: false, removalTimer: null, activeTransfers: 0,
  };
  downloadJobs.set(job.id, job);
  scheduleJobRemoval(job);
  sendJson(res, 201, { id: job.id, eventsUrl: `/api/downloads/${job.id}/events` });
  pendingDownloads.push(job);
  pumpDownloadQueue();
}

function subscribeToDownload(job, req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  job.listeners.add(res);
  if (job.lastEvent) res.write(`event: ${job.lastEvent.event}\ndata: ${JSON.stringify(job.lastEvent.data)}\n\n`);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  req.on("close", () => {
    clearInterval(heartbeat);
    job.listeners.delete(res);
  });
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function servePreparedDownload(job, req, res) {
  if (job.status !== "ready" || !job.filePath || !Number.isFinite(job.fileSize)) {
    return sendJson(res, 409, { error: "This file is still being prepared." }, { "retry-after": "2" });
  }

  const range = parseRange(req.headers.range, job.fileSize);
  if (range === false) {
    res.writeHead(416, {
      "content-range": `bytes */${job.fileSize}`,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    return res.end();
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? job.fileSize - 1;
  const contentLength = end - start + 1;
  const headers = {
    "content-type": job.type === "mp3" ? "audio/mpeg" : "video/mp4",
    "content-disposition": contentDisposition(`${job.title}.${job.type}`),
    "content-length": contentLength,
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${job.fileSize}`;
  res.writeHead(range ? 206 : 200, headers);
  clearTimeout(job.removalTimer);
  job.activeTransfers += 1;
  let transferFinished = false;
  const finishTransfer = () => {
    if (transferFinished) return;
    transferFinished = true;
    job.activeTransfers -= 1;
    if (job.activeTransfers === 0) scheduleJobRemoval(job);
  };
  res.on("finish", finishTransfer);
  res.on("close", finishTransfer);
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(job.filePath, { start, end });
  stream.on("error", (error) => {
    console.error(error);
    if (!res.writableEnded) res.destroy(error);
  });
  stream.pipe(res);
}

async function serveStatic(req, res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = resolve(publicDir, relativePath);
  if (!filePath.startsWith(`${publicDir}${sep}`) || !existsSync(filePath)) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) return sendJson(res, 404, { error: "Not found." });
  res.writeHead(200, {
    "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "content-length": fileStat.size,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(filePath).pipe(res);
}

await mkdir(downloadRoot, { recursive: true });
await cleanupOrphanedDownloads();
const cleanupTimer = setInterval(() => void cleanupOrphanedDownloads().catch(console.error), Math.min(downloadJobTtl, 5 * 60_000));
cleanupTimer.unref();

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "POST" && requestUrl.pathname === "/api/formats") return await inspectMedia(req, res);
    if (req.method === "POST" && requestUrl.pathname === "/api/downloads") return await createDownloadJob(req, res);
    const downloadRoute = requestUrl.pathname.match(/^\/api\/downloads\/([0-9a-f-]+)\/(events|file)$/);
    if (downloadRoute) {
      const job = downloadJobs.get(downloadRoute[1]);
      if (!job) return sendJson(res, 404, { error: "This download has expired." });
      if (req.method === "GET" && downloadRoute[2] === "events") return subscribeToDownload(job, req, res);
      if (["GET", "HEAD"].includes(req.method) && downloadRoute[2] === "file") {
        return servePreparedDownload(job, req, res);
      }
    }
    if (req.method === "GET" || req.method === "HEAD") return await serveStatic(req, res, requestUrl.pathname);
    sendJson(res, 405, { error: "Method not allowed." });
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: "The server could not complete the request." });
    console.error(error);
  }
});

server.listen(port, host, () => {
  console.log(`ytmp listening on http://${host}:${port}`);
  console.log(`temporary downloads: ${downloadRoot}`);
});
