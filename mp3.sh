#!/usr/bin/env bash

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cookies_file="${COOKIES_FILE:-$script_dir/cookies.txt}"
yt-dlp --cookies "$cookies_file" --js-runtimes node -x --audio-format mp3 "$1"
