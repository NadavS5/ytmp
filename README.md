# ytmp

A small web interface for `yt-dlp`. Paste a supported media URL, inspect the available audio and video qualities, then download MP3 or MP4.

## Requirements

- Node.js 20 or newer
- A current `yt-dlp` release
- `ffmpeg`

Distribution packages often lag behind YouTube changes. On Debian or Ubuntu, install the current upstream binary:

```bash
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
sudo chmod 0755 /usr/local/bin/yt-dlp
yt-dlp --version
```

## Run

```bash
npm start
```

The server listens on `127.0.0.1:3000` by default. Set `HOST=0.0.0.0` to expose it directly, or keep the default and put Caddy or nginx in front of it.

```bash
HOST=0.0.0.0 PORT=3000 \
MAX_CONCURRENT_DOWNLOADS=1 \
CONCURRENT_FRAGMENTS=4 \
MAX_FILE_SIZE_MB=4096 \
MIN_FREE_DISK_MB=5120 \
JOB_TTL_MINUTES=15 \
npm start
```

## VPS setup

Clone the repo, install the three requirements, and run `npm start` under systemd or another process manager. Proxy requests to port 3000.

The server prepares each download in `/tmp/ytmp` before sending it to the browser. This lets the final response include an exact `Content-Length`, so the browser download page shows bytes remaining, ETA, and completion. Downloads support HTTP ranges for retries and resume. The server deletes each job 15 minutes after its last transfer finishes.

Set `DOWNLOAD_DIR` if `/tmp` is on a small partition. The defaults are sized for a 1 GB RAM VPS with about 35 GB free:

- One active preparation at a time
- Four concurrent media fragments
- 4 GB maximum final file size
- 5 GB free-space reserve
- 15-minute retry window

The free-space check runs before and during preparation. `yt-dlp` also rejects source files above the configured size. If you use nginx, disable proxy buffering so nginx does not create a second temporary copy:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_buffering off;
    proxy_read_timeout 30m;
}
```

The in-page bar reports the server preparation. Once the file is ready, the browser starts the exact-size transfer. Open `Ctrl-J` to follow that transfer.

Only download media you have permission to use. You are responsible for complying with the source site's terms and local law.
