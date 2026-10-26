export const apiBase = '/api';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// The server's own message wins (a failed login is a 401 that says which input was wrong);
// a bare 401 from the session guard reads as an expired login.
function failureMessage(response, data) {
  const serverMessage = data && typeof data.error === 'string' ? data.error : '';
  if (response.status === 401 && (!serverMessage || serverMessage === '未登录')) return '登录已过期，请重新登录';
  if (serverMessage) return serverMessage;
  return `请求失败（${response.status}）`;
}

// Fetches JSON from the API and turns network failures, non-JSON bodies and
// error statuses into an ApiError with a readable message. AbortError is rethrown unchanged.
export async function requestJson(path, options = {}) {
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, options);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError('无法连接服务，请确认服务正在运行', 0);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      const message = response.ok ? '接口返回格式异常，请确认服务已更新并重新启动' : failureMessage(response, null);
      throw new ApiError(message, response.status);
    }
  }

  if (!response.ok) throw new ApiError(failureMessage(response, data), response.status);
  return data;
}

export function jsonBody(method, body) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

export function isAbort(error) {
  return error?.name === 'AbortError';
}
