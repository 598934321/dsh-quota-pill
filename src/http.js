/**
 * HTTP layer.
 *
 * Some upstreams (chatgpt.com, googleapis, open-design) sit behind Cloudflare
 * and reject Node's default TLS fingerprint with `403 error code: 1010`. The
 * Python original used curl_cffi's Chrome impersonation to get around that.
 *
 * We do the same thing with the system `curl`, which already presents a normal
 * browser-ish fingerprint:
 *
 *   · chatgpt.com / googleapis  → need TLS impersonation (curl works, fetch does not)
 *   · everything else           → plain fetch is fine and much cheaper
 *
 * Using curl is not a security bypass: it is the same request with a different
 * TLS stack. Nothing here skips authentication.
 */
import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = Number(process.env.QUOTA_PILL_TIMEOUT_MS || 20000);

function proxyUrl() {
  return process.env.QUOTA_PILL_PROXY || process.env.QUOTA_SIDECAR_PROXY || null;
}

/** GET JSON through the system curl. Used where TLS fingerprint matters. */
export function getJsonViaCurl(url, { token, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const args = [
    '-sS',
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '-H', 'Accept: application/json',
    '-w', '\n%{http_code}',
  ];
  // Never route these through a proxy unless the user explicitly configured one:
  // a broken proxy is a far more common cause of failure than a needed proxy.
  if (!proxyUrl()) args.push('--noproxy', '*');
  if (token) args.push('-H', 'Authorization: Bearer ' + token);
  if (proxyUrl()) args.push('--proxy', proxyUrl());
  for (const [k, v] of Object.entries(headers)) {
    if (v != null && v !== '') args.push('-H', `${k}: ${v}`);
  }
  args.push(url);

  return new Promise((resolve) => {
    execFile('curl', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) {
        resolve({ ok: false, error: String(err.message || err) });
        return;
      }
      const text = String(stdout || '');
      const cut = text.lastIndexOf('\n');
      if (cut < 0) {
        resolve({ ok: false, error: 'empty response' });
        return;
      }
      const body = text.slice(0, cut);
      const status = Number(text.slice(cut + 1).trim());
      if (status < 200 || status >= 300) {
        resolve({ ok: false, status, error: `http ${status}: ${body.slice(0, 160)}` });
        return;
      }
      try {
        resolve({ ok: true, status, data: JSON.parse(body) });
      } catch {
        resolve({ ok: false, status, error: 'unparsable json: ' + body.slice(0, 120) });
      }
    });
  });
}

/** GET JSON with fetch. Cheaper; fine for upstreams without TLS fingerprinting. */
export async function getJson(url, { token, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const hdrs = { Accept: 'application/json', ...headers };
  if (token) hdrs.Authorization = 'Bearer ' + token;
  try {
    const res = await fetch(url, { headers: hdrs, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: `http ${res.status}: ${text.slice(0, 160)}` };
    }
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) };
    } catch {
      return { ok: false, status: res.status, error: 'unparsable json: ' + text.slice(0, 120) };
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}
