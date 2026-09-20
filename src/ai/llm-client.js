'use strict';

/**
 * OpenAI 兼容聊天接口客户端（Node 20 内置 fetch，零依赖）。
 *
 * 为什么让用户自己填端点，而不是我们代持一个：
 *   数据去哪了必须说得清，而「服务端代理」只会让这句话变长 —— 用户的 Skill 元数据
 *   要先到我们的服务器，再转发给模型厂商，中间多一跳可解释成本。
 *   端上直连的话，答案只有一句：从你的电脑直接发到你填的那个地址。
 *
 * 兼容范围：OpenAI / DeepSeek / Moonshot / 智谱 / 本地 vLLM / Ollama（开启 /v1 兼容）。
 *
 * 请求超时与错误归一化都在这里做齐：调用方（主进程 IPC）不该自己去猜 fetch 的失败形态。
 */

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_TEMPERATURE = 0.2;
const CHAT_PATH = '/chat/completions';

/** 端点规范化：用户填 base、填 /v1、填完整路径都要能work */
function resolveEndpoint(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('还没有填写接口地址');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`接口地址不是合法 URL：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`接口地址必须是 http 或 https，收到 ${url.protocol}`);
  }
  if (url.pathname.endsWith(CHAT_PATH)) return url.toString();
  const versioned = /\/v\d+$/.test(url.pathname);
  const base = url.pathname === '/' ? '' : url.pathname;
  if (versioned) return `${url.origin}${base}${CHAT_PATH}`;
  return `${url.origin}${base}/v1${CHAT_PATH}`;
}

function normalizeFailure(error) {
  if (error && error.name === 'AbortError') return new Error('请求超时，模型没有在限定时间内返回');
  const code = error && error.cause && error.cause.code;
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') {
    return new Error(`连不上接口地址（${code}），检查地址与网络`);
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return new Error('接口地址证书不受信任（自签名证书？）');
  }
  return error instanceof Error ? error : new Error(String(error));
}

function statusMessage(status, body) {
  const detail = body && typeof body === 'object' && (body.error && (body.error.message || body.error.code));
  if (status === 401 || status === 403) return `API Key 无效或没有权限${detail ? `（${detail}）` : ''}`;
  if (status === 404) return `接口路径或模型名不对${detail ? `（${detail}）` : ''}`;
  if (status === 429) return `被限流了${detail ? `（${detail}）` : ''}`;
  if (status >= 500) return `模型服务端报错 ${status}`;
  return `请求失败 ${status}${detail ? `：${detail}` : ''}`;
}

/**
 * 发一轮对话。
 *
 * @param {object} config {baseUrl, apiKey, model, messages, temperature, timeoutMs}
 * @param {object} [options] {fetchImpl} 便于测试注入
 * @returns {Promise<{text: string, model: string, usage: object|null, endpoint: string}>}
 */
async function chatComplete(config = {}, options = {}) {
  const endpoint = resolveEndpoint(config.baseUrl);
  const model = String(config.model || '').trim();
  if (!model) throw new Error('还没有填写模型名');
  const messages = Array.isArray(config.messages) ? config.messages : [];
  if (!messages.length) throw new Error('没有要发送的内容');

  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const apiKey = String(config.apiKey || '').trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        temperature: Number.isFinite(config.temperature) ? config.temperature : DEFAULT_TEMPERATURE,
        stream: false
      })
    });
  } catch (error) {
    throw normalizeFailure(error);
  } finally {
    clearTimeout(timer);
  }
  if (!response || typeof response.ok !== 'boolean') {
    throw new Error('接口返回了无法识别的响应');
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) throw new Error(statusMessage(response.status, data));

  const text = data && Array.isArray(data.choices) && data.choices[0]
    ? String((data.choices[0].message && data.choices[0].message.content) || '')
    : '';
  if (!text.trim()) throw new Error('模型返回了空内容');

  return {
    text,
    model: (data && data.model) || model,
    usage: (data && data.usage) || null,
    endpoint
  };
}

module.exports = {
  CHAT_PATH,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_MS,
  chatComplete,
  resolveEndpoint
};
