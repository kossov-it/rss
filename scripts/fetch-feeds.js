const fs = require('fs');
const https = require('https');
const http = require('http');
const { XMLParser } = require('fast-xml-parser');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': 'RSS-Reader/1.0' },
      timeout: 10000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
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
      await new Promise(r => setTimeout(r, 1000)); // 1s backoff
      return fetchWithRetry(url, retries - 1);
    }
    throw err;
  }
}

// Process feeds in batches for controlled parallelism
async function processBatch(feeds, batchSize = 5) {
  const results = [];
  for (let i = 0; i < feeds.length; i += batchSize) {
    const batch = feeds.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(async (feed) => {
        console.log(`Fetching: ${feed.title}`);
        const xml = await fetchWithRetry(feed.url);
        const items = parseRSS(xml, feed.title);
        console.log(`  ✓ ${items.length} items`);
        return { feed, items, error: null };
      })
    );
    results.push(...batchResults);
  }
  return results;
}

function parseDate(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function extractContent(item) {
  // Try various content fields (RSS and Atom have different structures)
  return item['content:encoded'] 
    || item.content?.['#text'] 
    || item.content 
    || item.description 
    || item.summary?.['#text']
    || item.summary
    || '';
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
        title: item.title || 'Untitled',
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
        title: item.title?.['#text'] || item.title || 'Untitled',
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
        title: item.title || 'Untitled',
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
  const output = {
    lastUpdated: new Date().toISOString(),
    categories: []
  };

  for (const category of config.categories) {
    console.log(`\n=== ${category.name} ===`);
    const categoryData = {
      name: category.name,
      feeds: []
    };

    // Process all feeds in this category in parallel batches
    const results = await processBatch(category.feeds, 5);

    // Map results back to feed data
    for (let i = 0; i < category.feeds.length; i++) {
      const result = results[i];
      const feed = category.feeds[i];

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

    output.categories.push(categoryData);
  }

  fs.writeFileSync('data/feeds.json', JSON.stringify(output, null, 2));
  console.log('\nDone! Output: data/feeds.json');
}

main();
