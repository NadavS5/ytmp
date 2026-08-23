import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "127.0.0.1";
const publicDir = resolve("public");
const maxBodyBytes = 16 * 1024;
const maxConcurrentDownloads = Number(process.env.MAX_CONCURRENT_DOWNLOADS) || 2;
const downloadJobTtl = 10 * 60_000;
const downloadJobs = new Map();
let activeDownloads = 0;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
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
    formats
      .filter((format) => format.vcodec && format.vcodec !== "none")
      .map((format) => Number(format.height)),
  );
  const audioBitrates = uniqueSortedNumbers(
    formats
      .filter(
        (format) =>
          format.acodec &&
          format.acodec !== "none" &&
          (!format.vcodec || format.vcodec === "none"),
      )
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

function hasValidDownloadOptions(mediaUrl, type, qualityParam) {
  const quality = Number(qualityParam);
  return (
    isValidMediaUrl(mediaUrl) &&
    ["mp3", "mp4"].includes(type) &&
    (qualityParam === "best" || Number.isFinite(quality))
  );
}

function sendJobEvent(job, event, data) {
  job.lastEvent = { event, data };
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const listener of job.listeners) listener.write(payload);
}

function scheduleJobRemoval(job) {
  clearTimeout(job.removalTimer);
  job.removalTimer = setTimeout(() => {
    for (const listener of job.listeners) listener.end();
    downloadJobs.delete(job.id);
  }, downloadJobTtl);
  job.removalTimer.unref();
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
    id: randomUUID(),
    url: body.url,
    type: body.type,
    quality: qualityParam,
    title: String(body.title || "download").slice(0, 160),
    listeners: new Set(),
    lastEvent: { event: "state", data: { status: "waiting" } },
    started: false,
    completedBytes: 0,
    phaseFinished: false,
    removalTimer: null,
  };
  downloadJobs.set(job.id, job);
  scheduleJobRemoval(job);
  sendJson(res, 201, {
    id: job.id,
    downloadUrl: `/api/downloads/${job.id}/file`,
    eventsUrl: `/api/downloads/${job.id}/events`,
  });
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
  if (job.lastEvent) {
    res.write(`event: ${job.lastEvent.event}\ndata: ${JSON.stringify(job.lastEvent.data)}\n\n`);
  }

  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  req.on("close", () => {
    clearInterval(heartbeat);
    job.listeners.delete(res);
  });
}

function parseProgressLine(job, line) {
  if (!line.startsWith("ytmp:")) return;
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
}

function streamDownload(job, req, res) {
  if (job.started) return sendJson(res, 409, { error: "This download has already started." });
  if (activeDownloads >= maxConcurrentDownloads) {
    return sendJson(res, 429, { error: "The server is busy. Try again in a moment." });
  }

  job.started = true;
  activeDownloads += 1;
  clearTimeout(job.removalTimer);
  const quality = Number(job.quality);
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--progress-template",
    "download:ytmp:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.eta)s|%(progress.speed)s|%(progress.status)s",
    "-o",
    "-",
  ];

  if (job.type === "mp3") {
    args.push("-f", "bestaudio/best");
  } else {
    const maxHeight = Math.max(144, Math.min(4320, quality));
    const formatSelector = job.quality === "best"
      ? "bestvideo[vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[ext=mp4]/best"
      : `bestvideo[height<=${maxHeight}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=${maxHeight}][ext=mp4]/best`;
    args.push("-f", formatSelector);
  }
  args.push(job.url);

  const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
  const ffmpegArgs = job.type === "mp3"
    ? [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-vn",
        ...(job.quality === "best"
          ? ["-c:a", "libmp3lame", "-q:a", "0"]
          : ["-c:a", "libmp3lame", "-b:a", `${Math.max(32, Math.min(320, quality))}k`]),
        "-f",
        "mp3",
        "pipe:1",
      ]
    : [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "pipe:1",
      ];
  const transcoder = spawn("ffmpeg", ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });
  const mediaStream = transcoder.stdout;
  const processes = [child, transcoder];
  let stderrBuffer = "";
  let lastError = "";
  let responseStarted = false;
  let settled = false;
  let ytDlpClosed = false;
  let ytDlpExitCode = null;
  let transcoderClosed = false;
  let transcoderExitCode = null;

  child.stdout.pipe(transcoder.stdin);

  const timeout = setTimeout(() => {
    for (const process of processes) process.kill("SIGKILL");
  }, 30 * 60_000);
  timeout.unref();

  transcoder.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") lastError = error.message;
  });

  function finish(code, error) {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (code !== 0 || error) {
      for (const process of processes) {
        if (!process.killed) process.kill("SIGKILL");
      }
    }
    activeDownloads -= 1;
    scheduleJobRemoval(job);

    if (code === 0 && !error) {
      if (!responseStarted) {
        sendJson(res, 422, { error: "The media host returned no data." });
      } else if (!res.writableEnded) {
        res.end();
      }
      sendJobEvent(job, "complete", { status: "complete" });
      for (const listener of job.listeners) listener.end();
      job.listeners.clear();
      return;
    }

    const message = error?.message || lastError || "The download failed.";
    if (!responseStarted && !res.headersSent) sendJson(res, 422, { error: message });
    else if (!res.writableEnded) res.destroy();
    sendJobEvent(job, "failure", { status: "failed", error: message });
    for (const listener of job.listeners) listener.end();
    job.listeners.clear();
  }

  child.once("error", (error) => {
    const message = error.code === "ENOENT" ? "yt-dlp is not installed on this server." : error.message;
    finish(1, new Error(message));
  });

  transcoder.once("error", (error) => {
    const message = error.code === "ENOENT" ? "ffmpeg is not installed on this server." : error.message;
    finish(1, new Error(message));
  });

  mediaStream.once("data", (chunk) => {
    responseStarted = true;
    res.writeHead(200, {
      "content-type": job.type === "mp3" ? "audio/mpeg" : "video/mp4",
      "content-disposition": `attachment; filename="${safeDownloadName(`${job.title}.${job.type}`)}"`,
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    res.write(chunk);
    mediaStream.pipe(res, { end: false });
    sendJobEvent(job, "state", { status: job.type === "mp3" ? "converting" : "streaming" });
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() || "";
    for (const line of lines) {
      parseProgressLine(job, line.trim());
      if (line.startsWith("ERROR:")) lastError = line.replace(/^ERROR:\s*/, "").trim();
      if (/^\[(ExtractAudio|Merger|VideoRemuxer)\]/.test(line)) {
        sendJobEvent(job, "state", { status: job.type === "mp3" ? "converting" : "merging" });
      }
    }
  });

  transcoder.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) lastError = message.split("\n").at(-1);
  });

  function finishWhenProcessesClose() {
    if (!ytDlpClosed || !transcoderClosed) return;
    const code = ytDlpExitCode || transcoderExitCode || 0;
    finish(code);
  }

  child.once("close", (code) => {
    ytDlpClosed = true;
    ytDlpExitCode = code;
    finishWhenProcessesClose();
  });
  transcoder.once("close", (code) => {
    transcoderClosed = true;
    transcoderExitCode = code;
    finishWhenProcessesClose();
  });
  res.once("close", () => {
    if (!res.writableEnded && !settled) {
      for (const process of processes) process.kill("SIGKILL");
      finish(1, new Error("The client canceled the download."));
    }
  });
}

async function serveStatic(res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = resolve(publicDir, relativePath);
  if (!filePath.startsWith(`${publicDir}${sep}`) || !existsSync(filePath)) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }

  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  res.writeHead(200, {
    "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "content-length": fileStat.size,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "POST" && requestUrl.pathname === "/api/formats") {
      return await inspectMedia(req, res);
    }
    if (req.method === "POST" && requestUrl.pathname === "/api/downloads") {
      return await createDownloadJob(req, res);
    }
    const downloadRoute = requestUrl.pathname.match(/^\/api\/downloads\/([0-9a-f-]+)\/(events|file)$/);
    if (req.method === "GET" && downloadRoute) {
      const job = downloadJobs.get(downloadRoute[1]);
      if (!job) return sendJson(res, 404, { error: "This download has expired." });
      return downloadRoute[2] === "events"
        ? subscribeToDownload(job, req, res)
        : streamDownload(job, req, res);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return await serveStatic(res, requestUrl.pathname);
    }
    sendJson(res, 405, { error: "Method not allowed." });
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: "The server could not complete the request." });
    console.error(error);
  }
});

server.listen(port, host, () => {
  console.log(`ytmp listening on http://${host}:${port}`);
});
