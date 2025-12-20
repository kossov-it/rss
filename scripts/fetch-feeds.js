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

// Clean extracted text content - improved filtering
function cleanTextContent(text, title = '') {
  if (!text) return null;

  let lines = text.split('\n');

  // Patterns to skip
  const skipPatterns = [
    /^https?:\/\/\S+$/,                          // URLs only
    /[\w.-]+@[\w.-]+\.\w+/,                       // Contains email
    /^\+?\d[\d\s\-\(\)]{6,20}$/,                  // Phone numbers
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})/,          // ISO dates
    /^\d{2}:\d{2}\s*(GMT|UTC|[A-Z]{3})/,         // Time with timezone
    /^(Updated|Published):/i,                     // Metadata labels
    /Sputnik International/i,                     // News agency names
    /Rossiya Segodnya/i,
    /РИА Новости/i,
    /feedback@/i,
    /MIA\s*[„"]/i,
    /^[a-z]{2}_[A-Z]{2}$/,                        // Locale codes like en_EN
    /^News$/i,
    /^\d{4}$/,                                    // Just a year
    /^(world|russia|ukraine|usa|europe)$/i,       // Single tag words
  ];

  // Filter lines
  lines = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.length < 15) return false;

    // Check skip patterns
    for (const pattern of skipPatterns) {
      if (pattern.test(trimmed)) return false;
    }

    // Skip if line is just the title repeated
    if (title && trimmed.toLowerCase() === title.toLowerCase()) return false;

    // Skip lines that are mostly non-letter characters (likely metadata)
    const letterRatio = (trimmed.match(/[a-zA-Zа-яА-ЯёЁäöüÄÖÜß]/g) || []).length / trimmed.length;
    if (letterRatio < 0.5 && trimmed.length < 50) return false;

    return true;
  });

  // Remove duplicate consecutive lines
  lines = lines.filter((line, i) => i === 0 || line.trim() !== lines[i-1].trim());

  // Also remove near-duplicates (first 50 chars match)
  lines = lines.filter((line, i) => {
    if (i === 0) return true;
    const curr = line.trim().substring(0, 50);
    const prev = lines[i-1].trim().substring(0, 50);
    return curr !== prev;
  });

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

// Extract first real article URL from Google News content
function extractGoogleNewsArticleUrl(content) {
  if (!content) return null;

  // Google News content contains <a href="..."> links to actual articles
  // The first link after news.google.com redirect is usually the main source
  const matches = content.match(/href="(https?:\/\/(?!news\.google\.com)[^"]+)"/g);
  if (matches && matches.length > 0) {
    // Extract URL from first match
    const urlMatch = matches[0].match(/href="([^"]+)"/);
    if (urlMatch) {
      return urlMatch[1];
    }
  }
  return null;
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
async function extractArticleContent(url, title = '', retries = 1) {
  try {
    const html = await fetchUrl(url);

    // Create virtual console to suppress CSS parsing errors
    const virtualConsole = new (require('jsdom').VirtualConsole)();
    virtualConsole.on('error', () => {}); // Suppress errors

    const dom = new JSDOM(html, {
      url,
      virtualConsole
    });
    const document = dom.window.document;

    // Remove script, style, nav, footer, aside elements before parsing
    const removeSelectors = ['script', 'style', 'nav', 'footer', 'aside', 'header', '.advertisement', '.ad', '.social-share', '.comments', '.related-articles', '.sidebar'];
    removeSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => el.remove());
    });

    const reader = new Readability(document, {
      charThreshold: 50
    });

    const article = reader.parse();

    if (article && article.textContent) {
      // Use textContent (plain text) and clean it - pass title for dedup
      const cleaned = cleanTextContent(article.textContent, title);
      return cleaned;
    }

    return null;
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 500));
      return extractArticleContent(url, title, retries - 1);
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
  const isGoogleNews = feedTitle.toLowerCase().includes('google news');

  // RSS 2.0
  if (parsed.rss?.channel?.item) {
    const feedItems = Array.isArray(parsed.rss.channel.item)
      ? parsed.rss.channel.item
      : [parsed.rss.channel.item];

    for (const item of feedItems.slice(0, config.articlesPerFeed)) {
      const content = extractContent(item);
      let link = item.link;

      // For Google News, extract real article URL from content
      if (isGoogleNews) {
        const realUrl = extractGoogleNewsArticleUrl(content);
        if (realUrl) {
          link = realUrl;
        }
      }

      items.push({
        id: item.guid?.['#text'] || item.guid || item.link || Math.random().toString(36),
        title: extractTitle(item),
        link,
        content,
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
          const fullContent = await extractArticleContent(item.link, item.title);
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
