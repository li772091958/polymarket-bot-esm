import axios from 'axios';

const keys = (process.env.SERVER_CHAN_KEYS || process.env.SCT_KEYS || '')
  .split(',')
  .map(key => key.trim())
  .filter(Boolean);

export function simpleObjectToMarkdown(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([key, value]) => `- **${key}**: ${JSON.stringify(value)}`)
    .join('\n');
}

export default async function notify(title: string, desp: string) {
  if (keys.length === 0) {
    return;
  }

  await Promise.all(
    keys.map(key => {
      const body = new URLSearchParams();
      body.append('title', title);
      body.append('desp', desp);
      body.append('short', title.slice(0, 32));

      return axios.post(`https://sctapi.ftqq.com/${key}.send`, body);
    })
  );
}
