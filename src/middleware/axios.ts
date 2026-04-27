import { Effect } from 'effect';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import 'dotenv/config';

// 自定义配置（你可以在这里统一放默认 headers、timeout 等）
const defaultConfig: AxiosRequestConfig = {
  baseURL: process.env.GAMMA_HOST!,
  timeout: 15000, // 15秒超时
};
if (process.env.ENABLE_AGENT) {
  defaultConfig.proxy = {
    protocol: process.env.AGENT_PROTOCOL as string,
    host: process.env.AGENT_HOST as string,
    port: process.env.AGENT_PORT as any,
  };
}

// 创建 axios 实例
const axiosInstance: AxiosInstance = axios.create(defaultConfig);

// 请求拦截器（统一加 token、日志等）
// axiosInstance.interceptors.request.use(
//   config => {

//     console.log(`[${config.method?.toUpperCase()}] ${config.url}`);÷
//     return config;
//   },
//   error => {
//     return Promise.reject(error);
//   }
// );

const toError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));

export const axiosGet = <T = unknown>(url: string, config?: AxiosRequestConfig) =>
  Effect.tryPromise({
    try: () => axiosInstance.get<T>(url, config),
    catch: toError,
  });

export default axiosInstance;
