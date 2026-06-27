import fs from 'fs/promises';
import path from 'path';

const BASE_URL = 'https://gamma-api.polymarket.com/markets/keyset';

interface Market {
  id: string;
  slug: string;
  question: string;
  closed: boolean;
  active: boolean;
  outcomePrices: string;
}

interface KeysetResponse {
  markets: Market[];
  next_cursor?: string;
}

async function fetchMarkets(params: Record<string, any>): Promise<KeysetResponse> {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      if (Array.isArray(v)) v.forEach(item => query.append(k, item.toString()));
      else query.append(k, v.toString());
    }
  });

  const res = await fetch(`${BASE_URL}?${query}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let count = 0;

async function getAllMarkets() {
  const set = new Set<string>();
  let afterCursor: string | undefined;
  const limit = 100;

  while (true) {
    const data = await fetchMarkets({
      closed: false,
      active: true,
      tag_id: [102232],
      limit,
      after_cursor: afterCursor,
    });
    count += data.markets.length;
    data.markets.forEach(m => {
      if (m.slug.startsWith('fifwc')) set.add(m.slug.split('-').slice(0, 6).join('-'));
    });

    process.stdout.write(`\r${count}: ${set.size} `);

    if (!data.next_cursor || data.markets.length < limit) break;
    afterCursor = data.next_cursor;
    await new Promise(r => setTimeout(r, 250));
  }
  return set;
}

async function main() {
  const slugs = await getAllMarkets();
  console.log(`\nFound ${slugs.size} unique slugs.`);
  const outDir = path.join(process.cwd(), 'out');
  const outFile = path.join(outDir, 'worldcup-sports-slug1.txt');
  fs.writeFile(outFile, Array.from(slugs).join('\n'));
}

main().catch(console.error);
