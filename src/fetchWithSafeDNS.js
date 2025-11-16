import { lookup } from 'node:dns/promises';
import http from 'http';
import https from 'https';
import fetch from 'node-fetch';

/**
 * Fetch wrapper that resolves DNS manually to avoid Node.js/undici ENOTFOUND errors,
 * especially with fast-changing edge services like Cloudflare Workers.
 *
 * @param {string} url - The full URL to fetch
 * @param {object} [options={}] - Optional fetch options
 * @returns {Promise<Response>}
 */
export async function fetchWithSafeDNS(url, options = {}) {
    const { hostname } = new URL(url);

    const { address } = await lookup(hostname);

    const agent = url.startsWith('https')
        ? new https.Agent({ lookup: (_, __, cb) => cb(null, address, 4) })
        : new http.Agent({ lookup: (_, __, cb) => cb(null, address, 4) });

    return fetch(url, { ...options, agent });
}