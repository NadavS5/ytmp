# ytmp

A small web interface for `yt-dlp`. Paste a supported media URL, inspect the available audio and video qualities, then download MP3 or MP4.

## Requirements

- Node.js 22 or newer (also used by `yt-dlp` for YouTube JavaScript challenges)
- A current `yt-dlp` release
- `ffmpeg`

Export signed-in YouTube cookies from Firefox in Netscape format and save them as `cookies.txt` in the project root:

1. Open one Firefox private window and sign in to YouTube.
2. In that same tab, open `https://www.youtube.com/robots.txt`.
3. Use a conforming cookies.txt extension to export the `youtube.com` cookies.
4. Close the private window immediately and do not reuse that session in Firefox.

The file is used for both format inspection and downloads, and is excluded from Git because it contains session credentials. A general Firefox export made while not signed in to YouTube only contains guest cookies and will not bypass YouTube's sign-in check. To use a file elsewhere, set `COOKIES_FILE` to its path.

Distribution packages often lag behind YouTube changes. On Debian or Ubuntu, install the current upstream binary:

```bash
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
  -o /usr/local/bin/yt-dlp
sudo chmod 0755 /usr/local/bin/yt-dlp
yt-dlp --version
```

## Run

```bash
npm start
```

The server listens on `127.0.0.1:8081` by default. Set `HOST=0.0.0.0` to expose it directly, or keep the default and put Caddy or nginx in front of it.

```bash
HOST=0.0.0.0 PORT=8081 MAX_CONCURRENT_DOWNLOADS=2 COOKIES_FILE=/path/to/cookies.txt npm start
```

## VPS setup

Clone the repo, install the three requirements, and run `npm start` under systemd or another process manager. Proxy requests to port 8081. Downloads use a temporary directory and are removed after each response.

Only download media you have permission to use. You are responsible for complying with the source site's terms and local law.
