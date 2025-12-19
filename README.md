# RSS Reader

A minimal, fast RSS reader hosted on GitHub Pages with a dark UI.

## Features

- **Dark mode UI** - GitHub-inspired dark theme
- **Category tabs** - Filter feeds by category (instant CSS-based switching)
- **Collapsible feeds** - Click feed headers to expand/collapse
- **Inline article expansion** - Click articles to read content inline
- **Read state tracking** - Read articles are dimmed (stored in localStorage)
- **Hourly updates** - GitHub Actions fetches feeds every hour
- **Multi-format support** - RSS 2.0, Atom, RSS 1.0 (RDF)
- **XSS protection** - Content sanitized with DOMPurify
- **Parallel fetching** - All feeds fetched in parallel for speed

## Live Demo

https://kossov-it.github.io/rss/

## Setup

1. Fork or clone this repo
2. Enable GitHub Pages: Settings → Pages → Source: `main` branch
3. Enable Actions: Actions → Enable workflows
4. Run the Action manually once: Actions → "Fetch RSS Feeds" → Run workflow
5. Access at `https://<username>.github.io/<repo>/`

## Files

| File | Purpose |
|------|---------|
| `index.html` | Frontend UI (single-page app) |
| `config.json` | Feed configuration |
| `scripts/fetch-feeds.js` | Feed fetcher (runs in GitHub Action) |
| `.github/workflows/fetch.yml` | Hourly cron job |
| `data/feeds.json` | Generated feed data (auto-updated) |

## Adding/Removing Feeds

Edit `config.json`:

```json
{
  "articlesPerFeed": 20,
  "categories": [
    {
      "name": "News",
      "feeds": [
        { "title": "Feed Name", "url": "https://example.com/rss" }
      ]
    }
  ]
}
```

Push changes and the Action will run automatically.

## Local Development

```bash
# Install dependency
npm install fast-xml-parser

# Fetch feeds locally
node scripts/fetch-feeds.js

# Serve locally (required - can't open index.html directly due to CORS)
python3 -m http.server 8000
# Then open http://localhost:8000
```

## Notes

- **Read state** stored in browser localStorage (not synced across devices)
- **Collapsed feeds** state also stored in localStorage
- **Feeds fetched hourly** via GitHub Actions cron
- **10 concurrent fetches** with 1 retry on failure
- **UTF-8 support** with HTML entity decoding
