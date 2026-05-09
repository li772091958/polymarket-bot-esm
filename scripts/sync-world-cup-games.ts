import 'dotenv/config';
import RedisService from '../src/middleware/RedisService.js';
import { refreshWorldCupGameIndex } from '../src/polymarket/worldCupGames.js';

async function main() {
  let exitCode = 0;

  try {
    const index = await refreshWorldCupGameIndex();
    console.log(
      JSON.stringify(
        {
          cached: index.length,
          first: index[0],
          last: index.at(-1),
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    exitCode = 1;
  } finally {
    await RedisService.closeInstance();
    process.exit(exitCode);
  }
}

main();
