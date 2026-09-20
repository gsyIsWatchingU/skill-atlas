'use strict';

/**
 * 简介中译翻译器。
 *
 * 主端点：MyMemory 免费公共翻译 API（https://api.mymemory.translated.net）。
 *   - 零配置、零 API key、零额外依赖（Node 20 内置 fetch）
 *   - 国内网络可直连；匿名额度约每天 5000 字符，单段上限 ~500 字节，
 *     对 300 字以内的 Skill 简介完全够用
 *   - 备选端点：Google Translate 网页端点（国内常被墙，仅在 MyMemory 失败时兜底）
 *
 * 隐私边界：
 *   - 只翻译「用户在本机看到的那句简介文本」，不传 Skill 路径、不传文件内容
 *   - 不做任何持久化日志；调用方负责把结果落到自己的 settings.json
 *
 * 并发：
 *   - translateBatch 用固定并发池（默认 5），避免一次性把几百个简介同时打出去
 */

const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';
const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const TIMEOUT_MS = 8000;
const MAX_RETRIES = 1;

/** 粗略判断文本是否已经主要是中文（中日韩统一表意文字 + 全角标点） */
function isMostlyChinese(text) {
  const str = String(text || '');
  if (!str.trim()) return true;
  const cjk = (str.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g) || []).length;
  return cjk / str.length > 0.4;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 主端点：MyMemory */
async function viaMyMemory(source) {
  const url = `${MYMEMORY_ENDPOINT}?q=${encodeURIComponent(source)}&langpair=en|zh-CN`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`MyMemory 返回 ${response.status}`);
  const payload = await response.json();
  const text = payload && payload.responseData && payload.responseData.translatedText;
  if (!text) throw new Error('MyMemory 返回空');
  // MyMemory 有时会把原文里的 HTML 实体反转义掉，这里不做额外处理
  return String(text).trim();
}

/** 兜底端点：Google 网页翻译（国内常超时，仅作 fallback） */
async function viaGoogle(source) {
  const url = `${GOOGLE_ENDPOINT}?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(source)}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Google 返回 ${response.status}`);
  const payload = await response.json();
  const segments = Array.isArray(payload && payload[0]) ? payload[0] : [];
  const translated = segments
    .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
    .join('')
    .trim();
  if (!translated) throw new Error('Google 返回空');
  return translated;
}

/**
 * 调用翻译服务，把一段文本译成简体中文。
 * 输入已经是中文时直接原样返回，不发网络请求。
 */
async function translateOne(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  if (isMostlyChinese(source)) return source;

  const backends = [viaMyMemory, viaGoogle];
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    for (const backend of backends) {
      try {
        const translated = await backend(source);
        if (translated) return translated;
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError || new Error('翻译失败');
}

/**
 * 批量翻译，带并发池。
 * @param {string[]} texts
 * @param {object} [options]
 * @param {number} [options.concurrency=5]
 * @param {(done:number, total:number)=>void} [options.onProgress]
 * @returns {Promise<{ok:Record<number,string>, failed:Record<number,string>}>}
 *   按原索引返回：ok 里是译文，failed 里是错误信息；输入为空或已是中文的直接进 ok。
 */
async function translateBatch(texts, options = {}) {
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency) || 5));
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const list = Array.isArray(texts) ? texts : [];
  const ok = {};
  const failed = {};
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      const text = list[index];
      try {
        ok[index] = await translateOne(text);
      } catch (error) {
        failed[index] = (error && error.message) || String(error);
      } finally {
        done += 1;
        if (onProgress) onProgress(done, list.length);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, list.length) }, worker);
  await Promise.all(workers);
  return { ok, failed };
}

module.exports = {
  isMostlyChinese,
  translateOne,
  translateBatch
};
