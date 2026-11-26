import { IncomingMessage } from 'http';

/**
 * API key authentication.
 *
 * Enabled only when the WS_SCRCPY_API_KEY environment variable is set.
 * A request is authorized when ANY of the following matches the key:
 *   1. query parameter:  ?key=<key>
 *   2. request header:   X-API-Key: <key>
 *   3. cookie:           wskey=<key>
 *
 * The cookie is issued automatically by HttpServer middleware when a raw
 * key is presented, so browser sessions only need the key once.
 */
export class Auth {
    public static isEnabled(): boolean {
        return !!process.env.WS_SCRCPY_API_KEY;
    }

    public static isValidKey(key: string | null | undefined): boolean {
        const AUTH_KEY = process.env.WS_SCRCPY_API_KEY;
        return !!AUTH_KEY && typeof key === 'string' && key === AUTH_KEY;
    }

    public static parseUrl(req: IncomingMessage): URL | null {
        if (!req.url) {
            return null;
        }
        try {
            return new URL(req.url, 'https://example.org/');
        } catch (e) {
            return null;
        }
    }

    // Returns true when the request is authorized (or auth is disabled)
    public static checkRequest(req: IncomingMessage): boolean {
        if (!Auth.isEnabled()) {
            return true;
        }
        // 1. query parameter
        const url = Auth.parseUrl(req);
        if (url && Auth.isValidKey(url.searchParams.get('key'))) {
            return true;
        }
        // 2. X-API-Key header
        const h = req.headers['x-api-key'];
        if (typeof h === 'string' && Auth.isValidKey(h)) {
            return true;
        }
        // 3. wskey cookie
        const cookies = req.headers.cookie;
        if (typeof cookies === 'string') {
            const m = cookies.match(/(?:^|;\s*)wskey=([^;]*)/);
            if (m && Auth.isValidKey(decodeURIComponent(m[1]))) {
                return true;
            }
        }
        return false;
    }

    // Returns a Set-Cookie value when the request carries a valid raw key
    public static cookieFor(req: IncomingMessage): string | null {
        if (!Auth.isEnabled()) {
            return null;
        }
        const url = Auth.parseUrl(req);
        const raw = url ? url.searchParams.get('key') : null;
        if (raw && Auth.isValidKey(raw)) {
            return `wskey=${encodeURIComponent(raw)}; Path=/; HttpOnly; SameSite=Lax`;
        }
        return null;
    }
}
