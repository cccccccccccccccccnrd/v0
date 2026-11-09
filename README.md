# yt0

This is the engine yt0 behind the artwork [Arranging Data Into Lists](https://cnrd.computer/#arranging-data-into-lists).

> Software that facilitates the downloading of video content that has not been viewed yet. Exhibited as a video installation that displays a montage of the dataset on an inaccessible screen.

**Live:** https://v0.cnrd.computer/ (original gallery at [/v1](https://v0.cnrd.computer/v1))

## What it does

- Crawls public YouTube search results and channel feeds. It uses no API key and no login.
- Archives videos that show **zero views** and are **at least seven days old**.
  - **Verified:** the zero is confirmed by the channel feed.
  - **Unverified:** the video only looked like zero once.
- Paces itself to at most one request per second and one search per minute, and backs off when YouTube pushes back.
- Serves the archive through a small read-only API and a browser interface. Clustering and search run entirely in the visitor's browser.

## Files

| Path | What |
| --- | --- |
| `main.ts` | Starts the crawler and the web server |
| `crawler.ts`, `provider.ts`, `network.ts` | Discovery, verification, request pacing |
| `store.ts` | SQLite archive and task queue |
| `server.ts`, `public/` | API and web pages |
| `cli.ts` | Seed, import and backup commands |
| `deploy/` | systemd units and proxy route |
