const fs = require('fs');
const https = require('https');
const http = require('http');
const { XMLParser } = require('fast-xml-parser');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// HTML entity decoder
function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return str;
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&ndash;': '\u2013',
    '&mdash;': '\u2014',
    '&lsquo;': '\u2018',
    '&rsquo;': '\u2019',
    '&ldquo;': '\u201C',
    '&rdquo;': '\u201D',
    '&bull;': '\u2022',
    '&hellip;': '\u2026',
    '&copy;': '\u00A9',
    '&reg;': '\u00AE',
    '&trade;': '\u2122',
    '&euro;': '\u20AC',
    '&pound;': '\u00A3',
    '&yen;': '\u00A5',
    '&auml;': '\u00E4',
    '&ouml;': '\u00F6',
    '&uuml;': '\u00FC',
    '&Auml;': '\u00C4',
    '&Ouml;': '\u00D6',
    '&Uuml;': '\u00DC',
    '&szlig;': '\u00DF',
  };
  // Decode named entities
  let result = str;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.split(entity).join(char);
  }
  // Decode numeric entities (&#123; or &#x7B;)
  result = result.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return result;
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RSS-Reader/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Charset': 'utf-8'
      },
      timeout: 10000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(redirectUrl).then(resolve).catch(reject);
      }

      // Collect chunks as buffers for proper encoding
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        // Try to detect encoding from content-type header or default to UTF-8
        const contentType = res.headers['content-type'] || '';
        let encoding = 'utf-8';
        const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
        if (charsetMatch) {
          encoding = charsetMatch[1].toLowerCase();
        }
        // Convert to string with proper encoding
        let data;
        try {
          if (encoding === 'iso-8859-1' || encoding === 'latin1') {
            data = buffer.toString('latin1');
          } else {
            data = buffer.toString('utf8');
          }
        } catch {
          data = buffer.toString('utf8');
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Fetch with 1 retry on failure
async function fetchWithRetry(url, retries = 1) {
  try {
    return await fetchUrl(url);
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1000));
      return fetchWithRetry(url, retries - 1);
    }
    throw err;
  }
}

function parseDate(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function extractContent(item) {
  const content = item['content:encoded']
    || item.content?.['#text']
    || item.content
    || item.description
    || item.summary?.['#text']
    || item.summary
    || '';
  return decodeHtmlEntities(content);
}

function extractTitle(item) {
  const title = item.title?.['#text'] || item.title || 'Untitled';
  return decodeHtmlEntities(title);
}

function parseRSS(xml, feedTitle) {
  const parsed = parser.parse(xml);
  const items = [];

  // RSS 2.0
  if (parsed.rss?.channel?.item) {
    const feedItems = Array.isArray(parsed.rss.channel.item)
      ? parsed.rss.channel.item
      : [parsed.rss.channel.item];

    for (const item of feedItems.slice(0, config.articlesPerFeed)) {
      items.push({
        id: item.guid?.['#text'] || item.guid || item.link || Math.random().toString(36),
        title: extractTitle(item),
        link: item.link,
        content: extractContent(item),
        date: parseDate(item.pubDate),
        feedTitle
      });
    }
  }

  // Atom
  if (parsed.feed?.entry) {
    const feedItems = Array.isArray(parsed.feed.entry)
      ? parsed.feed.entry
      : [parsed.feed.entry];

    for (const item of feedItems.slice(0, config.articlesPerFeed)) {
      const link = Array.isArray(item.link)
        ? item.link.find(l => l['@_rel'] === 'alternate')?.['@_href'] || item.link[0]?.['@_href']
        : item.link?.['@_href'] || item.link;

      items.push({
        id: item.id || link || Math.random().toString(36),
        title: extractTitle(item),
        link,
        content: extractContent(item),
        date: parseDate(item.updated || item.published),
        feedTitle
      });
    }
  }

  // RDF/RSS 1.0
  if (parsed['rdf:RDF']?.item) {
    const feedItems = Array.isArray(parsed['rdf:RDF'].item)
      ? parsed['rdf:RDF'].item
      : [parsed['rdf:RDF'].item];

    for (const item of feedItems.slice(0, config.articlesPerFeed)) {
      items.push({
        id: item.link || Math.random().toString(36),
        title: extractTitle(item),
        link: item.link,
        content: extractContent(item),
        date: parseDate(item['dc:date']),
        feedTitle
      });
    }
  }

  return items;
}

async function main() {
  console.log('Fetching all feeds in parallel...\n');

  // Flatten all feeds with category info
  const allFeeds = [];
  for (const category of config.categories) {
    for (const feed of category.feeds) {
      allFeeds.push({ ...feed, categoryName: category.name });
    }
  }

  console.log(`Total feeds: ${allFeeds.length}`);

  // Fetch ALL feeds in parallel batches (10 concurrent)
  const results = [];
  const batchSize = 10;

  for (let i = 0; i < allFeeds.length; i += batchSize) {
    const batch = allFeeds.slice(i, i + batchSize);
    console.log(`\nBatch ${Math.floor(i/batchSize) + 1}/${Math.ceil(allFeeds.length/batchSize)}`);

    const batchResults = await Promise.allSettled(
      batch.map(async (feed) => {
        console.log(`  Fetching: ${feed.title}`);
        const xml = await fetchWithRetry(feed.url);
        const items = parseRSS(xml, feed.title);
        console.log(`    ✓ ${items.length} items`);
        return { feed, items };
      })
    );
    results.push(...batchResults);
  }

  // Reassemble into categories
  const output = {
    lastUpdated: new Date().toISOString(),
    categories: config.categories.map(cat => ({
      name: cat.name,
      feeds: []
    }))
  };

  // Map results back to categories
  for (let i = 0; i < allFeeds.length; i++) {
    const feed = allFeeds[i];
    const result = results[i];
    const categoryData = output.categories.find(c => c.name === feed.categoryName);

    if (result.status === 'fulfilled') {
      categoryData.feeds.push({
        title: feed.title,
        url: feed.url,
        items: result.value.items,
        error: null
      });
    } else {
      console.error(`  ✗ ${feed.title}: ${result.reason?.message || 'Unknown error'}`);
      categoryData.feeds.push({
        title: feed.title,
        url: feed.url,
        items: [],
        error: result.reason?.message || 'Fetch failed'
      });
    }
  }

  fs.writeFileSync('data/feeds.json', JSON.stringify(output, null, 2));

  const totalItems = output.categories.reduce((sum, cat) =>
    sum + cat.feeds.reduce((s, f) => s + f.items.length, 0), 0);
  console.log(`\nDone! ${totalItems} articles saved to data/feeds.json`);
}

main();
