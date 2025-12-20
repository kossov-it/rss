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
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
    '&ndash;': '\u2013', '&mdash;': '\u2014',
    '&lsquo;': '\u2018', '&rsquo;': '\u2019', '&ldquo;': '\u201C', '&rdquo;': '\u201D',
    '&bull;': '\u2022', '&hellip;': '\u2026',
    '&copy;': '\u00A9', '&reg;': '\u00AE', '&trade;': '\u2122',
    '&euro;': '\u20AC', '&pound;': '\u00A3', '&yen;': '\u00A5',
    '&auml;': '\u00E4', '&ouml;': '\u00F6', '&uuml;': '\u00FC',
    '&Auml;': '\u00C4', '&Ouml;': '\u00D6', '&Uuml;': '\u00DC', '&szlig;': '\u00DF',
  };
  let result = str;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.split(entity).join(char);
  }
  result = result.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return result;
}

// Aggressive text content cleaning for Russian news sites
function cleanTextContent(text, title = '') {
  if (!text) return null;

  // Normalize title for comparison
  const normalizedTitle = title.toLowerCase().trim();
  const titleWords = normalizedTitle.split(/\s+/).filter(w => w.length > 3);

  let lines = text.split('\n').map(l => l.trim()).filter(l => l);

  // Patterns that indicate junk lines
  const junkPatterns = [
    /^https?:\/\//i,                              // URLs
    /[\w.-]+@[\w.-]+\.\w{2,}/,                    // Email addresses
    /^\+?\d[\d\s\-\(\)]{6,}$/,                    // Phone numbers
    /^\d{4}-\d{2}-\d{2}/,                         // ISO dates
    /^\d{2}\.\d{2}\.\d{4}/,                       // European dates
    /^\d{2}:\d{2}.*?(GMT|UTC|MSK|\+\d{2})/i,      // Times with timezone
    /^(Updated|Published|Опубликовано|Обновлено):/i,
    /Sputnik International/i,
    /Rossiya Segodnya/i,
    /РИА Новости/i,
    /ТАСС/i,
    /feedback@|internet-group@/i,
    /MIA\s*[„"«»]/i,
    /ФГУП\s/i,
    /^[a-z]{2}[-_][A-Z]{2}$/,                     // Locale codes
    /^(News|Новости|World|В мире)$/i,
    /^\d{4}$/,                                     // Just a year
    /^(world|russia|ukraine|usa|europe|россия|украина|мир)$/i,
    /xn--.*?\.xn--/i,                             // Punycode domains
    /\.jpg|\.png|\.gif|\.webp/i,                  // Image file extensions
    /awards?\/?$/i,                               // Awards pages
    /^Copyright\s|©\s?\d{4}/i,                    // Copyright
    /All rights reserved/i,
    /Все права защищены/i,
    /Cookie|Datenschutz|Privacy/i,                // Cookie/privacy notices
    /Cookies zustimmen/i,                         // German cookie consent
    /Golem pur/i,                                 // Golem subscription
    /^Zu Golem|^Hier anmelden/i,
  ];

  // Filter lines aggressively
  lines = lines.filter(line => {
    if (line.length < 20) return false;
    if (line.length > 500) return true; // Long lines are usually content

    // Check junk patterns
    for (const pattern of junkPatterns) {
      if (pattern.test(line)) return false;
    }

    // Skip if line looks like repeated title
    const lineLower = line.toLowerCase();
    if (lineLower === normalizedTitle) return false;

    // Skip if line is mostly the title words
    if (titleWords.length >= 3) {
      const matchingWords = titleWords.filter(w => lineLower.includes(w));
      if (matchingWords.length >= titleWords.length * 0.8 && line.length < 150) return false;
    }

    // Skip lines that are just comma-separated tags
    const commaCount = (line.match(/,/g) || []).length;
    if (commaCount > 3 && line.length < 200 && !line.includes('.')) return false;

    // Skip lines with low letter ratio (metadata)
    const letters = (line.match(/[a-zA-Zа-яА-ЯёЁäöüÄÖÜß]/g) || []).length;
    if (letters / line.length < 0.5 && line.length < 100) return false;

    return true;
  });

  // Remove consecutive duplicates and near-duplicates
  const seen = new Set();
  lines = lines.filter(line => {
    const key = line.substring(0, 60).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Join and clean
  let cleaned = lines.join('\n\n').trim();
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.replace(/[ \t]+/g, ' ');

  if (cleaned.length < 100) return null;

  // Convert to paragraphs
  return cleaned.split('\n\n')
    .map(p => p.trim())
    .filter(p => p.length > 20)
    .map(p => `<p>${p}</p>`)
    .join('\n');
}

// Extract article with images and videos (HTML content)
function cleanHtmlContent(html, title = '') {
  if (!html) return null;

  const virtualConsole = new (require('jsdom').VirtualConsole)();
  virtualConsole.on('error', () => {});

  try {
    const dom = new JSDOM(html, { virtualConsole });
    const doc = dom.window.document;

    // Remove unwanted elements
    const removeSelectors = [
      'script', 'style', 'nav', 'footer', 'aside', 'header', 'noscript',
      '.advertisement', '.ad', '.ads', '.social-share', '.comments',
      '.related', '.sidebar', '.newsletter', '.popup', '.modal',
      '[class*="cookie"]', '[class*="consent"]', '[class*="banner"]',
      '[class*="promo"]', '[class*="subscribe"]', '[class*="share"]',
      '[class*="social"]', '[class*="author"]', '[class*="meta"]',
      '[class*="byline"]', '[class*="timestamp"]', '[class*="date"]'
    ];
    removeSelectors.forEach(sel => {
      try { doc.querySelectorAll(sel).forEach(el => el.remove()); } catch {}
    });

    // Get main content area
    const article = doc.querySelector('article') || doc.querySelector('main') || doc.body;
    if (!article) return null;

    // Process images - keep with fixed dimensions
    let hasMedia = false;
    article.querySelectorAll('img').forEach(img => {
      const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
      if (src && src.startsWith('http') && !src.includes('avatar') && !src.includes('icon') && !src.includes('logo') && !src.includes('pixel') && !src.includes('tracking')) {
        img.setAttribute('src', src);
        img.setAttribute('style', 'max-width: 100%; height: auto; max-height: 300px; object-fit: contain; border-radius: 6px; margin: 10px 0;');
        img.removeAttribute('srcset');
        img.removeAttribute('data-src');
        img.removeAttribute('data-lazy-src');
        hasMedia = true;
      } else {
        img.remove();
      }
    });

    // Process YouTube embeds
    article.querySelectorAll('iframe[src*="youtube"], iframe[src*="youtu.be"]').forEach(iframe => {
      const src = iframe.src || iframe.getAttribute('data-src');
      if (src) {
        iframe.setAttribute('src', src.replace(/^http:/, 'https:'));
        iframe.setAttribute('style', 'width: 100%; max-width: 560px; height: 315px; border: none; border-radius: 6px; margin: 10px 0;');
        iframe.setAttribute('allowfullscreen', 'true');
        hasMedia = true;
      }
    });

    // Process Vimeo embeds
    article.querySelectorAll('iframe[src*="vimeo"]').forEach(iframe => {
      iframe.setAttribute('style', 'width: 100%; max-width: 560px; height: 315px; border: none; border-radius: 6px; margin: 10px 0;');
      hasMedia = true;
    });

    // Process native video elements
    article.querySelectorAll('video').forEach(video => {
      video.setAttribute('style', 'max-width: 100%; height: auto; border-radius: 6px; margin: 10px 0;');
      video.setAttribute('controls', 'true');
      hasMedia = true;
    });

    // Get cleaned HTML
    let content = article.innerHTML;

    // Remove empty elements repeatedly until stable
    let prevLen;
    do {
      prevLen = content.length;
      content = content.replace(/<(\w+)[^>]*>\s*<\/\1>/g, '');
    } while (content.length !== prevLen);

    // Clean up whitespace
    content = content.replace(/\s+/g, ' ').trim();

    // Only return HTML content if it has meaningful text or media
    const textLength = content.replace(/<[^>]+>/g, '').trim().length;
    if (textLength > 100 || hasMedia) {
      return content;
    }
    return null;
  } catch {
    return null;
  }
}

// Follow redirect to get real URL (for Google News)
async function followRedirect(url, maxRedirects = 3) {
  return new Promise((resolve) => {
    if (maxRedirects <= 0) return resolve(url);

    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html',
      },
      timeout: 10000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        // If redirect is still Google News, follow again
        if (redirectUrl.includes('news.google.com')) {
          followRedirect(redirectUrl, maxRedirects - 1).then(resolve);
        } else {
          resolve(redirectUrl);
        }
      } else {
        resolve(url);
      }
      res.destroy();
    });
    req.on('error', () => resolve(url));
    req.on('timeout', () => { req.destroy(); resolve(url); });
  });
}

// Check if content is a cookie/consent wall
function isCookieWall(text) {
  const cookiePatterns = [
    /cookies?\s*(zustimmen|akzeptieren|accept)/i,
    /cookie\s*consent/i,
    /datenschutz.*?zustimm/i,
    /privacy.*?consent/i,
    /golem\s*pur/i,
    /ohne\s*werbung/i,
  ];
  return cookiePatterns.some(p => p.test(text));
}

function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,de;q=0.8,ru;q=0.7',
      },
      timeout: 15000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
      }
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || '';
        const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
        const encoding = charsetMatch?.[1]?.toLowerCase() || 'utf-8';
        try {
          resolve(encoding === 'iso-8859-1' || encoding === 'latin1'
            ? buffer.toString('latin1')
            : buffer.toString('utf8'));
        } catch {
          resolve(buffer.toString('utf8'));
        }
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

// Extract article content - returns both text and HTML versions
async function extractArticleContent(url, title = '', retries = 1) {
  try {
    const html = await fetchUrl(url);

    // Check for cookie walls
    if (isCookieWall(html)) {
      return null;
    }

    const virtualConsole = new (require('jsdom').VirtualConsole)();
    virtualConsole.on('error', () => {});

    const dom = new JSDOM(html, { url, virtualConsole });
    const document = dom.window.document;

    // Remove junk before parsing
    ['script', 'style', 'nav', 'footer', 'aside', '.ad', '.advertisement', '.comments', '.social'].forEach(sel => {
      try { document.querySelectorAll(sel).forEach(el => el.remove()); } catch {}
    });

    const reader = new Readability(document, { charThreshold: 50 });
    const article = reader.parse();

    if (!article) return null;

    // Try to get HTML content with images/videos, fallback to text
    const htmlContent = cleanHtmlContent(article.content, title);
    if (htmlContent) return htmlContent;

    // Fallback to clean text if HTML extraction failed
    return cleanTextContent(article.textContent, title);

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

function parseRSS(xml, feedTitle, maxArticles = config.articlesPerFeed) {
  const parsed = parser.parse(xml);
  const items = [];
  const isGoogleNews = feedTitle.toLowerCase().includes('google news');
  const isHackerNews = feedTitle.toLowerCase().includes('hacker news');

  // RSS 2.0
  if (parsed.rss?.channel?.item) {
    const feedItems = Array.isArray(parsed.rss.channel.item)
      ? parsed.rss.channel.item : [parsed.rss.channel.item];

    for (const item of feedItems.slice(0, maxArticles)) {
      const content = extractContent(item);
      let link = item.link;

      // For Google News, keep the link to resolve via redirect later

      // For Hacker News, the link might be to HN comments
      // Store both the HN link and extract the actual article URL if present
      let hnCommentsUrl = null;
      if (isHackerNews && item.comments) {
        hnCommentsUrl = item.comments;
      }

      items.push({
        id: item.guid?.['#text'] || item.guid || item.link || Math.random().toString(36),
        title: extractTitle(item),
        link,
        hnCommentsUrl,
        content,
        date: parseDate(item.pubDate),
        feedTitle,
        isHackerNews,
        isGoogleNews
      });
    }
  }

  // Atom
  if (parsed.feed?.entry) {
    const feedItems = Array.isArray(parsed.feed.entry)
      ? parsed.feed.entry : [parsed.feed.entry];

    for (const item of feedItems.slice(0, maxArticles)) {
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
      ? parsed['rdf:RDF'].item : [parsed['rdf:RDF'].item];

    for (const item of feedItems.slice(0, maxArticles)) {
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

  // Fetch RSS feeds
  console.log('Fetching RSS feeds...');
  const feedPromises = allFeeds.map(async (feed) => {
    try {
      const xml = await fetchWithRetry(feed.url);
      const maxArticles = feed.articlesPerFeed || config.articlesPerFeed;
      const items = parseRSS(xml, feed.title, maxArticles);
      console.log(`  ✓ ${feed.title}: ${items.length} items`);
      return { feed, items, error: null };
    } catch (err) {
      console.log(`  ✗ ${feed.title}: ${err.message}`);
      return { feed, items: [], error: err.message };
    }
  });

  const feedResults = await Promise.all(feedPromises);

  // Extract full article content
  if (config.fetchFullText) {
    console.log('\n\nExtracting full article content...');

    const allItems = feedResults.flatMap(r => r.items);
    console.log(`Total articles to extract: ${allItems.length}`);

    const concurrency = 10;
    let extracted = 0, failed = 0, completed = 0, index = 0;

    const processNext = async () => {
      while (index < allItems.length) {
        const item = allItems[index++];
        if (!item.link) { completed++; continue; }

        try {
          // For Google News, follow redirect to get real URL
          let articleUrl = item.link;
          if (item.isGoogleNews && item.link.includes('news.google.com')) {
            const realUrl = await followRedirect(item.link);
            if (realUrl && !realUrl.includes('news.google.com')) {
              articleUrl = realUrl;
              item.link = realUrl; // Update the item link to the real URL
            }
          }

          const fullContent = await extractArticleContent(articleUrl, item.title);
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

    await Promise.all(Array(Math.min(concurrency, allItems.length)).fill().map(processNext));

    console.log(`\n  ✓ Successfully extracted ${extracted}/${allItems.length} articles`);
    if (failed > 0) console.log(`  ⚠ ${failed} articles will use RSS summary`);
  }

  // Build output
  const output = {
    lastUpdated: new Date().toISOString(),
    categories: config.categories.map(cat => ({ name: cat.name, feeds: [] }))
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
