const fs = require('fs');
const https = require('https');
const http = require('http');
const { XMLParser } = require('fast-xml-parser');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

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
  let result = str;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.split(entity).join(char);
  }
  result = result.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return result;
}

// Clean extracted text content
function cleanTextContent(text) {
  if (!text) return null;

  let lines = text.split('\n');

  // Remove lines that are just URLs, emails, phone numbers, or metadata
  lines = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;

    // Skip lines that are just URLs
    if (/^https?:\/\/\S+$/.test(trimmed)) return false;

    // Skip lines that look like email addresses
    if (/^[\w.-]+@[\w.-]+\.\w+$/.test(trimmed)) return false;

    // Skip lines that are just phone numbers
    if (/^[\d\s\-\+\(\)]{7,20}$/.test(trimmed)) return false;

    // Skip lines that are just dates in various formats
    if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/.test(trimmed)) return false;

    // Skip very short lines (likely navigation/UI elements)
    if (trimmed.length < 10) return false;

    return true;
  });

  // Remove duplicate consecutive lines
  lines = lines.filter((line, i) => i === 0 || line.trim() !== lines[i-1].trim());

  // Join and clean up
  let cleaned = lines.join('\n\n').trim();

  // Remove excessive whitespace
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.replace(/[ \t]+/g, ' ');

  // Must have at least 100 chars of actual content
  if (cleaned.length < 100) return null;

  // Convert to HTML paragraphs
  const paragraphs = cleaned.split('\n\n')
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .map(p => `<p>${p}</p>`)
    .join('\n');

  return paragraphs;
}

function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      return reject(new Error('Too many redirects'));
    }

    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,de;q=0.8,ru;q=0.7',
        'Accept-Charset': 'utf-8'
      },
      timeout: 15000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
      }

      if (res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || '';
        let encoding = 'utf-8';
        const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
        if (charsetMatch) {
          encoding = charsetMatch[1].toLowerCase();
        }
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

// Extract article content using Readability - with retry
async function extractArticleContent(url, retries = 1) {
  try {
    const html = await fetchUrl(url);

    const dom = new JSDOM(html, { url });
    const document = dom.window.document;

    // Remove script, style, nav, footer, aside elements before parsing
    const removeSelectors = ['script', 'style', 'nav', 'footer', 'aside', 'header', '.advertisement', '.ad', '.social-share', '.comments'];
    removeSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => el.remove());
    });

    const reader = new Readability(document, {
      charThreshold: 50
    });

    const article = reader.parse();

    if (article && article.textContent) {
      // Use textContent (plain text) and clean it - no images, no metadata
      const cleaned = cleanTextContent(article.textContent);
      return cleaned;
    }

    return null;
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 500));
      return extractArticleContent(url, retries - 1);
    }
    return null;
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

  const allFeeds = [];
  for (const category of config.categories) {
    for (const feed of category.feeds) {
      allFeeds.push({ ...feed, categoryName: category.name });
    }
  }

  console.log(`Total feeds: ${allFeeds.length}`);
  console.log(`Full text extraction: ${config.fetchFullText ? 'enabled' : 'disabled'}\n`);

  // Fetch ALL RSS feeds in parallel
  console.log('Fetching RSS feeds...');
  const feedPromises = allFeeds.map(async (feed) => {
    try {
      const xml = await fetchWithRetry(feed.url);
      const items = parseRSS(xml, feed.title);
      console.log(`  ✓ ${feed.title}: ${items.length} items`);
      return { feed, items, error: null };
    } catch (err) {
      console.log(`  ✗ ${feed.title}: ${err.message}`);
      return { feed, items: [], error: err.message };
    }
  });

  const feedResults = await Promise.all(feedPromises);

  // If fetchFullText is enabled, extract full article content
  if (config.fetchFullText) {
    console.log('\n\nExtracting full article content...');

    // Collect all items with their references
    const allItems = [];
    for (const result of feedResults) {
      for (const item of result.items) {
        allItems.push(item);
      }
    }

    console.log(`Total articles to extract: ${allItems.length}`);

    // Lower concurrency for better reliability
    const concurrency = 10;
    let extracted = 0;
    let failed = 0;
    let completed = 0;
    let index = 0;

    const processNext = async () => {
      while (index < allItems.length) {
        const currentIndex = index++;
        const item = allItems[currentIndex];

        if (!item.link) {
          completed++;
          continue;
        }

        try {
          const fullContent = await extractArticleContent(item.link);
          if (fullContent) {
            item.fullContent = fullContent;
            extracted++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }

        completed++;
        if (completed % 10 === 0 || completed === allItems.length) {
          process.stdout.write(`\r  Progress: ${completed}/${allItems.length} (${extracted} extracted, ${failed} failed)`);
        }
      }
    };

    // Start concurrent workers
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, allItems.length); i++) {
      workers.push(processNext());
    }
    await Promise.all(workers);

    console.log(`\n  ✓ Successfully extracted ${extracted}/${allItems.length} articles`);
    if (failed > 0) {
      console.log(`  ⚠ ${failed} articles will use RSS summary as fallback`);
    }
  }

  // Reassemble into categories
  const output = {
    lastUpdated: new Date().toISOString(),
    categories: config.categories.map(cat => ({
      name: cat.name,
      feeds: []
    }))
  };

  for (const result of feedResults) {
    const categoryData = output.categories.find(c => c.name === result.feed.categoryName);
    categoryData.feeds.push({
      title: result.feed.title,
      url: result.feed.url,
      items: result.items,
      error: result.error
    });
  }

  fs.writeFileSync('data/feeds.json', JSON.stringify(output, null, 2));

  const totalItems = output.categories.reduce((sum, cat) =>
    sum + cat.feeds.reduce((s, f) => s + f.items.length, 0), 0);
  const totalWithFullContent = output.categories.reduce((sum, cat) =>
    sum + cat.feeds.reduce((s, f) => s + f.items.filter(i => i.fullContent).length, 0), 0);

  console.log(`\nDone! ${totalItems} articles saved (${totalWithFullContent} with full content)`);
}

main();
