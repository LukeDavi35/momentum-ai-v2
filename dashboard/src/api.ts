const KEY = "momentum_admin_token";
export const getToken = (): string => {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
};
export const setToken = (t: string): void => {
  try {
    t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: token just won't persist across reloads */
  }
};

export class AuthError extends Error {}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${getToken()}`, ...(init.body ? { "content-type": "application/json" } : {}) } });
  if (res.status === 401) throw new AuthError("unauthorized");
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}
