import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.PORT) || 8081;
const host = process.env.HOST || "127.0.0.1";
const publicDir = resolve("public");
const cookiesFile = resolve(process.env.COOKIES_FILE || "cookies.txt");
const maxBodyBytes = 16 * 1024;
const maxConcurrentDownloads = Number(process.env.MAX_CONCURRENT_DOWNLOADS) || 2;
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
    const child = spawn("yt-dlp", ["--cookies", cookiesFile, "--js-runtimes", "node", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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

async function downloadMedia(req, res, requestUrl) {
  const mediaUrl = requestUrl.searchParams.get("url");
  const type = requestUrl.searchParams.get("type");
  const qualityParam = requestUrl.searchParams.get("quality");
  const quality = Number(qualityParam);
  const hasValidQuality = qualityParam === "best" || Number.isFinite(quality);

  if (!isValidMediaUrl(mediaUrl) || !["mp3", "mp4"].includes(type) || !hasValidQuality) {
    return sendJson(res, 400, { error: "The download options are invalid." });
  }
  if (activeDownloads >= maxConcurrentDownloads) {
    return sendJson(res, 429, { error: "The server is busy. Try again in a moment." });
  }

  activeDownloads += 1;
  const workDir = await mkdtemp(join(tmpdir(), "ytmp-"));
  const outputTemplate = join(workDir, "%(title).160B [%(id)s].%(ext)s");
  const args = ["--no-playlist", "--no-warnings", "--restrict-filenames", "-o", outputTemplate];

  if (type === "mp3") {
    const audioQuality = qualityParam === "best" ? "0" : `${Math.max(32, Math.min(320, quality))}K`;
    args.push("-x", "--audio-format", "mp3", "--audio-quality", audioQuality);
  } else {
    const formatSelector = qualityParam === "best"
      ? "bestvideo+bestaudio/best"
      : `bestvideo[height<=${Math.max(144, Math.min(4320, quality))}]+bestaudio/best[height<=${Math.max(144, Math.min(4320, quality))}]/best`;
    args.push(
      "-f",
      formatSelector,
      "--merge-output-format",
      "mp4",
      "--remux-video",
      "mp4",
    );
  }
  args.push(mediaUrl);

  try {
    await runYtDlp(args, { timeout: 30 * 60_000, maxOutput: 2 * 1024 * 1024 });
    const files = (await readdir(workDir)).filter((name) => !name.endsWith(".part") && !name.endsWith(".ytdl"));
    if (files.length !== 1) throw new Error("The download did not produce a media file.");

    const filename = files[0];
    const filePath = join(workDir, filename);
    const fileStat = await stat(filePath);
    res.writeHead(200, {
      "content-type": type === "mp3" ? "audio/mpeg" : "video/mp4",
      "content-length": fileStat.size,
      "content-disposition": `attachment; filename="${safeDownloadName(filename)}"`,
      "cache-control": "no-store",
    });
    const stream = createReadStream(filePath);
    stream.pipe(res);
    await new Promise((resolvePromise) => {
      stream.on("close", resolvePromise);
      stream.on("error", resolvePromise);
      res.on("close", resolvePromise);
    });
  } catch (error) {
    if (!res.headersSent) sendJson(res, 422, { error: error.message });
    else res.destroy();
  } finally {
    activeDownloads -= 1;
    await rm(workDir, { recursive: true, force: true });
  }
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
    if (req.method === "GET" && requestUrl.pathname === "/api/download") {
      return await downloadMedia(req, res, requestUrl);
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
