import 'dotenv/config';
import { randomInt } from 'node:crypto';
import { ClobClient } from '@polymarket/clob-client-v2';
import { Wallet } from '@ethersproject/wallet';

function createNonce() {
  return randomInt(1, 2_147_483_647);
}

async function main() {
  const cbc = new ClobClient({
    host: process.env.CLOB_HOST!,
    chain: 137,
    signer: new Wallet(process.env.PRIVATE_KEY!),

    signatureType: 1,
    funderAddress: process.env.FUNDER,
    throwOnError: true,
  });

  const nonce = createNonce();
  const newApiKey = await cbc.createApiKey(nonce);

  console.log(
    JSON.stringify(
      {
        nonce,
        created: newApiKey,
      },
      null,
      2
    )
  );
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Failed to manage CLOB API keys:', message);
  process.exitCode = 1;
});
