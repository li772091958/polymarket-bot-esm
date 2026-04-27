/*
 * @Author: 0x0d
 * @LastEditors: 0x0d
 * @Date: 2023-08-08 21:09:53
 * @LastEditTime: 2026-01-10 21:17:21
 * @FilePath: /polymarket-bot-ts/utils/logger.ts
 *
 */
import { Effect } from 'effect';
import fs from 'fs';
import path from 'path';

const MAX_LOG_FILE_BYTES = Number(process.env.LOG_MAX_BYTES || 50 * 1024 * 1024);

type StreamState = {
  dateStr: string;
  index: number;
  stream: fs.WriteStream;
  bytesWritten: number;
  draining: boolean;
  pending: string[];
};

const streams = new Map<string, StreamState>();
const ensuredDirs = new Set<string>();

function ensureDir(dir: string) {
  if (ensuredDirs.has(dir)) return;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  ensuredDirs.add(dir);
}

function getDateStr(d = new Date()) {
  return (
    d.getFullYear() +
    (d.getMonth() + 1).toString().padStart(2, '0') +
    d.getDate().toString().padStart(2, '0')
  );
}

function getFileName(prefix: string, dateStr: string, index: number) {
  return index === 0 ? `${prefix}-${dateStr}.log` : `${prefix}-${dateStr}-${index}.log`;
}

function openStream(file: string) {
  const stream = fs.createWriteStream(file, { flags: 'a' });
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }
  return { stream, size };
}

function rotateStream(baseKey: string, dir: string, prefix: string, dateStr: string, index: number) {
  const file = path.join(dir, getFileName(prefix, dateStr, index));
  const { stream, size } = openStream(file);
  const state: StreamState = {
    dateStr,
    index,
    stream,
    bytesWritten: size,
    draining: false,
    pending: [],
  };
  streams.set(baseKey, state);
  stream.on('error', err => {
    console.error('logger stream error:', err?.message || err);
  });
  return state;
}

function getStreamState(baseKey: string, dir: string, prefix: string, dateStr: string, nextBytes: number) {
  let state = streams.get(baseKey);
  if (!state || state.dateStr !== dateStr) {
    if (state) state.stream.end();
    state = rotateStream(baseKey, dir, prefix, dateStr, 0);
  }
  if (state.bytesWritten + nextBytes > MAX_LOG_FILE_BYTES) {
    state.stream.end();
    state = rotateStream(baseKey, dir, prefix, dateStr, state.index + 1);
  }
  return state;
}

function writeLine(state: StreamState, line: string, lineBytes: number) {
  if (state.draining) {
    state.pending.push(line);
    return;
  }
  state.bytesWritten += lineBytes;
  const ok = state.stream.write(line);
  if (!ok) {
    state.draining = true;
    state.stream.once('drain', () => {
      state.draining = false;
      if (state.pending.length === 0) return;
      const pending = state.pending.splice(0);
      for (const item of pending) {
        writeLine(state, item, Buffer.byteLength(item));
      }
    });
  }
}

function formatLine(args: any[]) {
  let str = '[' + new Date().toLocaleTimeString() + '] ';
  args.forEach(v => {
    str +=
      typeof v === 'string'
        ? v
        : JSON.stringify(v, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
          );
    str += ' ';
  });
  return str + '\n';
}

function createInfo(subDir: string = '') {
  return (...args: any[]) =>
    Effect.sync(() => {
      const line = formatLine(args);
      const dateStr = getDateStr();
      const dir = path.join(process.cwd(), 'logs', subDir);
      ensureDir(dir);
      console.log('\x1B[36m%s\x1B[0m', line.replace('\n', ''));
      const baseKey = `${dir}::out`;
      const state = getStreamState(baseKey, dir, 'out', dateStr, Buffer.byteLength(line));
      writeLine(state, line, Buffer.byteLength(line));
    });
}

const logger = {
  info: createInfo(),
  error: (...args: any[]) =>
    Effect.sync(() => {
      const line = formatLine(args);
      const dateStr = getDateStr();
      const dir = path.join(process.cwd(), 'logs');
      ensureDir(dir);
      console.log('\x1b[91m%s\x1B[0m', line.replace('\n', ''));
      const baseKey = `${dir}::error`;
      const state = getStreamState(baseKey, dir, 'error', dateStr, Buffer.byteLength(line));
      writeLine(state, line, Buffer.byteLength(line));
    }),
};
export default logger;
