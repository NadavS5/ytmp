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
HOST=0.0.0.0 PORT=3000 MAX_CONCURRENT_DOWNLOADS=2 npm start
```

## VPS setup

Clone the repo, install the three requirements, and run `npm start` under systemd or another process manager. Proxy requests to port 3000.

Downloads stream through `yt-dlp` and `ffmpeg` pipes. The server does not write media files to disk. If you use nginx, disable response buffering and allow long-running responses:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_buffering off;
    proxy_read_timeout 30m;
}
```

Streaming conversions do not have an exact final size before they finish, so the binary response uses chunked transfer encoding. The in-page progress display uses `yt-dlp` byte counts and ETA estimates.

Only download media you have permission to use. You are responsible for complying with the source site's terms and local law.
