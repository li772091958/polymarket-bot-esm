import { Effect } from 'effect';
import { getMarketBySlug } from '../src/polymarket/api';

const slugs = [
  'fifwc-cze-mex-2026-06-24',
  'fifwc-rsa-kr-2026-06-24',
  'fifwc-ecu-ger-2026-06-25',
  'fifwc-kor-civ-2026-06-25',
  'fifwc-jpn-swe-2026-06-25',
  'fifwc-tun-nld-2026-06-25',
  'fifwc-par-aus-2026-06-25',
  'fifwc-tur-usa-2026-06-25',
  'fifwc-nor-fra-2026-06-26',
  'fifwc-sen-irq-2026-06-26',
  'fifwc-cvi-ksa-2026-06-26',
  'fifwc-ury-esp-2026-06-26',
  'fifwc-egy-irn-2026-06-26',
  'fifwc-nzl-bel-2026-06-26',
  'fifwc-pan-eng-2026-06-27',
  'fifwc-hrv-gha-2026-06-27',
  'fifwc-col-prt-2026-06-27',
  'fifwc-cdr-uzb-2026-06-27',
  'fifwc-jor-arg-2026-06-27',
  'fifwc-alg-aut-2026-06-27',
];

const base = 7;

function getMarket(slug: string) {
  return Effect.runPromise(getMarketBySlug(slug));
}

(async () => {
  for (const slug of slugs) {
    await getMarket(`${slug}-corners-total-${base}pt5`).then(market => {
      console.log(`${market.slug}, Outcome Prices: ${market.outcomePrices}`);
    });
    await new Promise(r => setTimeout(r, 250));
  }

  process.exit(0);
})();
