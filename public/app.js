const form = document.querySelector("#inspect-form");
const deck = document.querySelector(".deck");
const urlInput = document.querySelector("#media-url");
const status = document.querySelector("#form-status");
const result = document.querySelector("#result");
const thumbnail = document.querySelector("#thumbnail");
const duration = document.querySelector("#duration");
const uploader = document.querySelector("#uploader");
const mediaTitle = document.querySelector("#media-title");
const qualityList = document.querySelector("#quality-list");
const qualityCount = document.querySelector("#quality-count");
const downloadButton = document.querySelector("#download-button");
const downloadType = document.querySelector("#download-type");
const downloadQuality = document.querySelector("#download-quality");
const downloadProgress = document.querySelector("#download-progress");
const progressStatus = document.querySelector("#progress-status");
const progressPercent = document.querySelector("#progress-percent");
const progressRail = document.querySelector("#progress-rail");
const progressFill = document.querySelector("#progress-fill");
const progressBytes = document.querySelector("#progress-bytes");
const progressEta = document.querySelector("#progress-eta");
const formatInputs = [...document.querySelectorAll('input[name="format"]')];

let media = null;

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function currentFormat() {
  return formatInputs.find((input) => input.checked)?.value || "mp3";
}

function qualityLabel(format, quality) {
  if (quality === "best") return "Best available";
  return format === "mp3" ? `${quality} kbps` : `${quality}p`;
}

function selectedQuality() {
  return document.querySelector('input[name="quality"]:checked')?.value || null;
}

function renderQualities() {
  if (!media) return;
  const format = currentFormat();
  const qualities = media.qualities[format];
  qualityList.replaceChildren();

  qualities.forEach((quality, index) => {
    const label = document.createElement("label");
    label.className = "quality-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "quality";
    input.value = quality;
    input.checked = index === 0;
    const text = document.createElement("span");
    text.textContent = qualityLabel(format, quality);
    label.append(input, text);
    qualityList.append(label);
  });

  qualityCount.textContent = `${qualities.length} option${qualities.length === 1 ? "" : "s"}`;
  downloadType.textContent = format.toUpperCase();
  updateDownloadLabel();
}

function updateDownloadLabel() {
  const quality = selectedQuality();
  if (quality) downloadQuality.textContent = qualityLabel(currentFormat(), quality);
}

function showStatus(message, isError = false) {
  status.textContent = message;
  status.dataset.error = String(isError);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "Unknown size";
  const units = ["B", "KB", "MB", "GB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds)) return "Calculating time";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} sec left`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes} min ${remaining} sec left`;
}

function resetProgress() {
  downloadProgress.hidden = false;
  progressStatus.textContent = "Starting preparation";
  progressStatus.dataset.error = "false";
  progressPercent.textContent = "0%";
  progressFill.style.width = "0%";
  progressRail.setAttribute("aria-valuenow", "0");
  progressBytes.textContent = "Waiting for size";
  progressEta.textContent = "Calculating time";
}

function updateProgress(data) {
  const hasTotal = Number.isFinite(data.totalBytes) && data.totalBytes > 0;
  const percent = hasTotal ? Math.min(100, (data.downloadedBytes / data.totalBytes) * 100) : null;
  const remaining = hasTotal ? Math.max(0, data.totalBytes - data.downloadedBytes) : null;

  progressStatus.textContent = data.status === "finished" ? "Preparing output" : "Downloading to server";
  progressPercent.textContent = percent === null ? "--" : `${Math.round(percent)}%`;
  progressFill.style.width = percent === null ? "18%" : `${percent}%`;
  progressFill.classList.toggle("is-indeterminate", percent === null);
  if (percent === null) progressRail.removeAttribute("aria-valuenow");
  else progressRail.setAttribute("aria-valuenow", String(Math.round(percent)));

  progressBytes.textContent = remaining === null
    ? `${formatBytes(data.downloadedBytes)} downloaded`
    : `${formatBytes(remaining)} remaining`;
  const speed = Number.isFinite(data.bytesPerSecond) ? ` at ${formatBytes(data.bytesPerSecond)}/s` : "";
  progressEta.textContent = `${formatEta(data.etaSeconds)}${speed}`;
}

function setProgressState(state) {
  const labels = {
    waiting: "Waiting in server queue",
    downloading: "Downloading to server",
    converting: "Converting to MP3",
    merging: "Merging video and audio",
  };
  if (labels[state]) progressStatus.textContent = labels[state];
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) {
    showStatus("Paste a media URL first.", true);
    urlInput.focus();
    return;
  }

  const button = form.querySelector("button");
  button.disabled = true;
  button.querySelector("span").textContent = "Reading";
  deck.classList.add("is-loading");
  result.hidden = true;
  showStatus("Checking the formats on this link...");

  try {
    const response = await fetch("/api/formats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The link could not be read.");

    media = data;
    thumbnail.src = data.thumbnail || "";
    thumbnail.hidden = !data.thumbnail;
    duration.textContent = formatDuration(data.duration);
    uploader.textContent = data.uploader;
    mediaTitle.textContent = data.title;
    renderQualities();
    result.hidden = false;
    showStatus("Formats ready. Choose the file you want.");
  } catch (error) {
    media = null;
    showStatus(error.message, true);
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Read link";
    deck.classList.remove("is-loading");
  }
});

formatInputs.forEach((input) => input.addEventListener("change", renderQualities));
qualityList.addEventListener("change", updateDownloadLabel);

downloadButton.addEventListener("click", async () => {
  const quality = selectedQuality();
  if (!media || !quality) return;

  downloadButton.disabled = true;
  resetProgress();

  try {
    const response = await fetch("/api/downloads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: urlInput.value.trim(),
        type: currentFormat(),
        quality: String(quality),
        title: media.title,
      }),
    });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || "The download could not start.");

    const events = new EventSource(job.eventsUrl);
    events.addEventListener("state", (event) => setProgressState(JSON.parse(event.data).status));
    events.addEventListener("progress", (event) => updateProgress(JSON.parse(event.data)));
    events.addEventListener("ready", (event) => {
      const data = JSON.parse(event.data);
      progressStatus.textContent = "File ready";
      progressPercent.textContent = "100%";
      progressFill.style.width = "100%";
      progressFill.classList.remove("is-indeterminate");
      progressRail.setAttribute("aria-valuenow", "100");
      progressBytes.textContent = `${formatBytes(data.sizeBytes)} ready`;
      progressEta.textContent = "Track the transfer in Ctrl-J";
      downloadButton.disabled = false;
      events.close();
      window.location.assign(data.downloadUrl);
    });
    events.addEventListener("failure", (event) => {
      const data = JSON.parse(event.data);
      progressStatus.textContent = data.error || "The download failed.";
      progressStatus.dataset.error = "true";
      progressFill.classList.remove("is-indeterminate");
      downloadButton.disabled = false;
      events.close();
    });
  } catch (error) {
    progressStatus.textContent = error.message;
    progressStatus.dataset.error = "true";
    downloadButton.disabled = false;
  }
});

const resizeObserver = new ResizeObserver(([entry]) => {
  deck.style.setProperty("--track-width", `${entry.contentRect.width - 96}px`);
});
resizeObserver.observe(deck);
