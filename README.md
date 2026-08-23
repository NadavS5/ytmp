# ytmp

A small web interface for `yt-dlp`. Paste a supported media URL, inspect the available audio and video qualities, then download MP3 or MP4.

## Requirements

- Node.js 20 or newer
- A current `yt-dlp` release
- `ffmpeg`

## Run

```bash
npm start
```

The server listens on `127.0.0.1:3000` by default. Set `HOST=0.0.0.0` to expose it directly, or keep the default and put Caddy or nginx in front of it.

```bash
HOST=0.0.0.0 PORT=3000 MAX_CONCURRENT_DOWNLOADS=2 npm start
```

## VPS setup

Clone the repo, install the three requirements, and run `npm start` under systemd or another process manager. Proxy requests to port 3000. Downloads use a temporary directory and are removed after each response.

Only download media you have permission to use. You are responsible for complying with the source site's terms and local law.
