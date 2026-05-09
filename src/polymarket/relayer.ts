import { createWalletClient, encodeFunctionData, Hex, http, parseUnits, zeroHash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import {
  RelayClient,
  type RelayerTransaction,
  RelayerTransactionState,
  RelayerTxType,
  type RelayerTransactionResponse,
  type Transaction,
} from '@polymarket/builder-relayer-client';
import type { AxiosInstance, AxiosProxyConfig } from 'axios';
import 'dotenv/config';

import { Position } from '../types.js';
import {
  CTF_CONDITIONAL_TOKENS_ADDRESS,
  CTF_COLLATERAL_ADAPTER_ADDRESS,
  NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS,
  POLYMARKET_USD,
} from './constants.js';

const BINARY_MARKET_PARTITION = [1n, 2n];

const erc20Abi = [
  {
    name: 'approve',
    type: 'function',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

const erc1155Abi = [
  {
    name: 'setApprovalForAll',
    type: 'function',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

const ctfSplitMergeAbi = [
  {
    name: 'splitPosition',
    type: 'function',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'partition', type: 'uint256[]' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'mergePositions',
    type: 'function',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'partition', type: 'uint256[]' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

const ctfRedeemAbi = [
  {
    name: 'redeemPositions',
    type: 'function',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'indexSets', type: 'uint256[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export type SplitMergeParams = {
  conditionId: Hex;
  amount: number | string | bigint;
  negativeRisk?: boolean;
};

const parseCollateralAmount = (amount: number | string | bigint) =>
  typeof amount === 'bigint' ? amount : parseUnits(String(amount), 6);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const isEnabled = (value: string | undefined) =>
  value !== undefined && !['0', 'false', 'no', 'off'].includes(value.toLowerCase());

const resolveProxyConfig = (): AxiosProxyConfig | undefined => {
  if (!isEnabled(process.env.ENABLE_AGENT)) return undefined;
  if (!process.env.AGENT_HOST || !process.env.AGENT_PORT) return undefined;

  return {
    protocol: process.env.AGENT_PROTOCOL || 'http',
    host: process.env.AGENT_HOST,
    port: Number(process.env.AGENT_PORT),
  };
};

const configureRelayerHttpProxy = (client: RelayClient) => {
  const proxy = resolveProxyConfig();
  if (!proxy) return;

  const httpClient = client as unknown as {
    httpClient?: {
      instance?: AxiosInstance;
    };
  };

  if (httpClient.httpClient?.instance) {
    httpClient.httpClient.instance.defaults.proxy = proxy;
    httpClient.httpClient.instance.defaults.timeout = 30_000;
  }
};

const createRelayerClient = () => {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(process.env.RPC),
  });

  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: process.env.BUILD_API_KEY!,
      secret: process.env.BUILD_SECRET!,
      passphrase: process.env.BUILD_PASS_PHRASE!,
    },
  });

  const client = new RelayClient(
    'https://relayer-v2.polymarket.com/',
    137,
    wallet,
    builderConfig,
    RelayerTxType.PROXY
  );

  configureRelayerHttpProxy(client);

  return client;
};

const isTransientRelayerPollError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes('"status":502') ||
    message.includes('Bad Gateway') ||
    message.includes('connection error') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('timeout')
  );
};

const waitForRelayerTransaction = async (
  response: RelayerTransactionResponse,
  maxPolls = 120,
  pollIntervalMs = 2_000
): Promise<RelayerTransaction | undefined> => {
  console.log(
    `Waiting for transaction ${response.transactionID} matching states: ${RelayerTransactionState.STATE_MINED},${RelayerTransactionState.STATE_CONFIRMED}...`
  );

  let latest: RelayerTransaction | undefined;
  let transientErrors = 0;

  for (let pollCount = 0; pollCount < maxPolls; pollCount += 1) {
    try {
      const [transaction] = await response.getTransaction();

      if (transaction) {
        latest = transaction;

        if (
          transaction.state === RelayerTransactionState.STATE_MINED ||
          transaction.state === RelayerTransactionState.STATE_CONFIRMED
        ) {
          return transaction;
        }

        if (
          transaction.state === RelayerTransactionState.STATE_FAILED ||
          transaction.state === RelayerTransactionState.STATE_INVALID
        ) {
          return transaction;
        }
      }
    } catch (error) {
      if (!isTransientRelayerPollError(error)) {
        throw error;
      }

      transientErrors += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Transient relayer poll error (${transientErrors}/${maxPolls}): ${message}`
      );
    }

    await sleep(pollIntervalMs);
  }

  return latest;
};

const executeRelayerTransactions = async (txs: Transaction[], description: string) => {
  const client = createRelayerClient();
  const response = await client.execute(txs, description);
  const result = await waitForRelayerTransaction(response);

  if (!result) {
    const [latest] = await response.getTransaction().catch(() => []);
    const state = latest?.state || 'UNKNOWN';
    const transactionHash = latest?.transactionHash || response.transactionHash || '';

    throw new Error(
      [
        `Relayer transaction did not complete successfully: ${description}`,
        `transactionID=${response.transactionID}`,
        `state=${state}`,
        `transactionHash=${transactionHash || 'N/A'}`,
      ].join(', ')
    );
  }

  if (
    result.state === RelayerTransactionState.STATE_FAILED ||
    result.state === RelayerTransactionState.STATE_INVALID
  ) {
    throw new Error(
      [
        `Relayer transaction failed: ${description}`,
        `transactionID=${result.transactionID}`,
        `state=${result.state}`,
        `transactionHash=${result.transactionHash || 'N/A'}`,
      ].join(', ')
    );
  }

  return result;
};

const executeRelayerTransaction = async (tx: Transaction, description: string) =>
  executeRelayerTransactions([tx], description);

const createSplitMergeTransaction = (
  functionName: 'splitPosition' | 'mergePositions',
  {
    conditionId,
    amount,
    negativeRisk = false,
  }: SplitMergeParams
): Transaction => {
  const to = negativeRisk
    ? NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS
    : CTF_COLLATERAL_ADAPTER_ADDRESS;

  return {
    to,
    data: encodeFunctionData({
      abi: ctfSplitMergeAbi,
      functionName,
      args: [
        POLYMARKET_USD,
        zeroHash,
        conditionId,
        BINARY_MARKET_PARTITION,
        parseCollateralAmount(amount),
      ],
    }),
    value: '0',
  };
};

const createCollateralApprovalTransaction = (
  spender: Hex,
  amount: SplitMergeParams['amount']
): Transaction => ({
  to: POLYMARKET_USD,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, parseCollateralAmount(amount)],
  }),
  value: '0',
});

const resolveCollateralAdapterAddress = (negativeRisk = false) =>
  (negativeRisk
    ? NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS
    : CTF_COLLATERAL_ADAPTER_ADDRESS) as Hex;

const createConditionalTokensApprovalTransaction = (operator: Hex): Transaction => ({
  to: CTF_CONDITIONAL_TOKENS_ADDRESS,
  data: encodeFunctionData({
    abi: erc1155Abi,
    functionName: 'setApprovalForAll',
    args: [operator, true],
  }),
  value: '0',
});

export const splitPosition = (params: SplitMergeParams) =>
  executeRelayerTransactions(
    [
      createCollateralApprovalTransaction(resolveCollateralAdapterAddress(params.negativeRisk), params.amount),
      createSplitMergeTransaction('splitPosition', params),
    ],
    'Approve and split collateral into outcome tokens'
  );

export const mergePositions = (params: SplitMergeParams) =>
  executeRelayerTransactions(
    [
      createConditionalTokensApprovalTransaction(resolveCollateralAdapterAddress(params.negativeRisk)),
      createSplitMergeTransaction('mergePositions', params),
    ],
    'Approve and merge outcome tokens to collateral'
  );

export const mergePosition = mergePositions;

export async function redeemPosition(position: Position) {
  if (!position.redeemable) return;

  if (position.negativeRisk) {
    const redeemTx = {
      to: NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS,
      data: encodeFunctionData({
        abi: ctfRedeemAbi,
        functionName: 'redeemPositions',
        args: [
          POLYMARKET_USD,
          zeroHash,
          position.conditionId as Hex,
          BINARY_MARKET_PARTITION,
        ],
      }),
      value: '0',
    };

    return executeRelayerTransactions(
      [
        createConditionalTokensApprovalTransaction(resolveCollateralAdapterAddress(position.negativeRisk)),
        redeemTx,
      ],
      'Approve and redeem positions'
    );
  } else {
    const redeemTx = {
      to: CTF_COLLATERAL_ADAPTER_ADDRESS,
      data: encodeFunctionData({
        abi: ctfRedeemAbi,
        functionName: 'redeemPositions',
        args: [
          POLYMARKET_USD,
          zeroHash,
          position.conditionId as Hex,
          [BigInt(position.outcomeIndex + 1)],
        ],
      }),
      value: '0',
    };

    return executeRelayerTransactions(
      [
        createConditionalTokensApprovalTransaction(resolveCollateralAdapterAddress(position.negativeRisk)),
        redeemTx,
      ],
      'Approve and redeem positions'
    );
  }
}
