'use strict';

function invalidSetting(message) {
    const error = new Error(message);
    error.code = 'network_settings_invalid';
    error.statusCode = 400;
    return error;
}

function isSupportedProxyUrl(value) {
    return /^(http|https|socks4|socks5):\/\//i.test(String(value || '').trim());
}

function normalizeNetworkSettingsPayload(body = {}) {
    const defaultProxyUrl = String(body.defaultProxyUrl || body.proxyUrl || '').trim();
    if (defaultProxyUrl && !isSupportedProxyUrl(defaultProxyUrl)) {
        throw invalidSetting('defaultProxyUrl must start with http://, https://, socks4:// or socks5://');
    }

    const cityProxyPool = Array.isArray(body.cityProxyPool)
        ? body.cityProxyPool.map((item = {}, index) => {
            const proxyUrl = String(item.proxyUrl || '').trim();
            if (proxyUrl && !isSupportedProxyUrl(proxyUrl)) {
                throw invalidSetting(`cityProxyPool[${index}].proxyUrl must start with http://, https://, socks4:// or socks5://`);
            }
            return {
                id: String(item.id || '').trim(),
                enabled: item.enabled !== false,
                province: String(item.province || '').trim(),
                city: String(item.city || '').trim(),
                proxyUrl,
                keepProxyUrl: item.keepProxyUrl === true,
            };
        }).filter(item => item.province || item.city || item.proxyUrl || item.keepProxyUrl)
        : [];

    const provider = body.providerProxy && typeof body.providerProxy === 'object'
        ? body.providerProxy
        : {};
    const providerApiUrl = String(provider.apiUrl || '').trim();
    if (providerApiUrl && !/^https?:\/\//i.test(providerApiUrl)) {
        throw invalidSetting('providerProxy.apiUrl must start with http:// or https://');
    }

    return {
        enabled: Boolean(body.enabled),
        defaultProxyUrl,
        keepDefaultProxyUrl: body.keepDefaultProxyUrl === true,
        autoCityProxyEnabled: Boolean(body.autoCityProxyEnabled),
        cityProxyPool,
        providerProxy: {
            enabled: Boolean(provider.enabled),
            apiUrl: providerApiUrl,
            authHeader: String(provider.authHeader || '').trim(),
            authToken: String(provider.authToken || '').trim(),
            keepAuthToken: provider.keepAuthToken === true,
            clearAuthToken: provider.clearAuthToken === true,
            ttlMinutes: Math.max(1, Math.floor(Number(provider.ttlMinutes) || 10)),
        },
    };
}

module.exports = {
    isSupportedProxyUrl,
    normalizeNetworkSettingsPayload,
};
