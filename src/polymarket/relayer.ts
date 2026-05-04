import { createWalletClient, encodeFunctionData, Hex, http, parseUnits, zeroHash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import {
  RelayClient,
  RelayerTransactionState,
  RelayerTxType,
  type Transaction,
} from '@polymarket/builder-relayer-client';
import 'dotenv/config';

import { Position } from '../types.js';
import {
  CTF_COLLATERAL_ADAPTER_ADDRESS,
  NEG_RISK_CTF_COLLATERAL_ADAPTER_ADDRESS,
  POLYMARKET_USD,
} from './constants.js';

const BINARY_MARKET_PARTITION = [1n, 2n];

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

  return new RelayClient(
    'https://relayer-v2.polymarket.com/',
    137,
    wallet,
    builderConfig,
    RelayerTxType.PROXY
  );
};

const executeRelayerTransaction = async (tx: Transaction, description: string) => {
  const client = createRelayerClient();
  const response = await client.execute([tx], description);
  const result = await response.wait();

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

export const splitPosition = (params: SplitMergeParams) =>
  executeRelayerTransaction(
    createSplitMergeTransaction('splitPosition', params),
    'Split collateral into outcome tokens'
  );

export const mergePositions = (params: SplitMergeParams) =>
  executeRelayerTransaction(
    createSplitMergeTransaction('mergePositions', params),
    'Merge outcome tokens to collateral'
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

    return executeRelayerTransaction(redeemTx, 'Redeem positions');
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

    return executeRelayerTransaction(redeemTx, 'Redeem positions');
  }
}
