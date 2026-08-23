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

downloadButton.addEventListener("click", () => {
  const quality = selectedQuality();
  if (!media || !quality) return;

  const params = new URLSearchParams({
    url: urlInput.value.trim(),
    type: currentFormat(),
    quality: String(quality),
  });
  window.location.assign(`/api/download?${params}`);
});

const resizeObserver = new ResizeObserver(([entry]) => {
  deck.style.setProperty("--track-width", `${entry.contentRect.width - 96}px`);
});
resizeObserver.observe(deck);
