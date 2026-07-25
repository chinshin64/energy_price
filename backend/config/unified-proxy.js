'use strict';

const DEFAULT_UNIFIED_PROXY_HOST = '';
const DEFAULT_UNIFIED_PROXY_PORT = '';
const DEFAULT_UNIFIED_PROXY_URL = '';

function normalizeProxyUrl(value = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    if (/^(http|https|socks4|socks5):\/\//i.test(text)) return text;
    if (/^[\w.-]+:\d{2,5}$/.test(text)) return `http://${text}`;
    return text;
}

const UNIFIED_OUTBOUND_PROXY_URL = normalizeProxyUrl(
    process.env.UNIFIED_OUTBOUND_PROXY_URL
    || process.env.METHOD3_UPSTREAM_PROXY
    || ''
);

module.exports = {
    DEFAULT_UNIFIED_PROXY_HOST,
    DEFAULT_UNIFIED_PROXY_PORT,
    DEFAULT_UNIFIED_PROXY_URL,
    UNIFIED_OUTBOUND_PROXY_URL,
    normalizeProxyUrl,
};
