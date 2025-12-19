# RSS Reader

Minimal RSS reader hosted on GitHub Pages.

## Setup

1. Create a new repo and push these files
2. Enable GitHub Pages (Settings → Pages → Source: main branch)
3. Run the Action manually once (Actions → Fetch RSS Feeds → Run workflow)
4. Access at `https://<username>.github.io/<repo>/`

## Files

- `index.html` - The reader UI
- `config.json` - Feed configuration
- `scripts/fetch-feeds.js` - Feed fetcher (runs in Action)
- `.github/workflows/fetch.yml` - Hourly cron job
- `data/feeds.json` - Generated feed data

## Adding/Removing Feeds

Edit `config.json` and push. The Action will run automatically.

## Notes

- Read state stored in browser localStorage
- Feeds fetched hourly via GitHub Actions
- Supports RSS 2.0, Atom, and RSS 1.0 (RDF)
