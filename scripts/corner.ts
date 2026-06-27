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

let count = 0,
  Over = 0,
  Uder = 0;

async function getAllMarkets() {
  const all: Market[] = [];
  let afterCursor: string | undefined;
  const limit = 100;

  while (true) {
    const data = await fetchMarkets({
      closed: true,
      active: false,
      tag_id: [102232],
      limit,
      after_cursor: afterCursor,
    });
    count += data.markets.length;
    const filteredMarkets = data.markets.filter(m =>
      m.slug?.toLowerCase().endsWith('corners-total-6pt5')
    );
    filteredMarkets.forEach(m => {
      const outcomePrices = JSON.parse(m.outcomePrices);
      const outcome = outcomePrices[0] > outcomePrices[1] ? 'Over' : 'Under';
      if (outcome === 'Over') Over++;
      else Uder++;
    });

    process.stdout.write(`\r${count} Over: ${Over}, Under: ${Uder} `);
    all.push(...filteredMarkets);

    if (!data.next_cursor || data.markets.length < limit) break;
    afterCursor = data.next_cursor;
    await new Promise(r => setTimeout(r, 250));
  }
  return all;
}

async function main() {
  const markets = await getAllMarkets();

  console.log(`找到 ${markets.length} 个匹配市场：`);
  // markets.forEach(m => {
  //   console.log(`  ${m.slug}`);
  // });
}

main().catch(console.error);
