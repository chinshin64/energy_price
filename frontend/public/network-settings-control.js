(function attachNetworkSettingsControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Network settings dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const maskProxyUrl = deps.maskProxyUrl || (value => String(value || ''));
        const providerAuthSecretField = deps.providerAuthSecretField || 'authToken';

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function positiveInteger(id, fallback) {
            return Math.max(1, Math.floor(Number(byId(id)?.value) || fallback));
        }

        function renderSettings(data = {}) {
            const provider = data.providerProxy || {};
            const enabledEl = byId('networkProxyEnabled');
            const autoCityEl = byId('autoCityProxyEnabled');
            const defaultProxyEl = byId('networkDefaultProxyUrl');
            const providerEnabledEl = byId('providerProxyEnabled');
            const providerApiEl = byId('providerProxyApiUrl');
            const providerTtlEl = byId('providerProxyTtl');
            const providerAuthHeaderEl = byId('providerProxyAuthHeader');
            const providerAuthSecretEl = byId('providerProxyAuthSecret');
            const statusEl = byId('networkProxyStatus');

            if (enabledEl) enabledEl.checked = Boolean(data.enabled);
            if (autoCityEl) autoCityEl.checked = Boolean(data.autoCityProxyEnabled);
            if (defaultProxyEl) {
                defaultProxyEl.value = data.defaultProxyUrl || data.proxyUrl || '';
                defaultProxyEl.dataset.keepSecret = data.keepDefaultProxyUrl ? 'true' : 'false';
                defaultProxyEl.placeholder = data.defaultProxyUrlSecret
                    ? `${data.defaultProxyUrlPreview || '已保存凭据'}，留空保留`
                    : 'http://user:pass@host:port';
            }
            renderCityProxyPool(data.cityProxyPool || []);
            if (providerEnabledEl) providerEnabledEl.checked = Boolean(provider.enabled);
            if (providerApiEl) providerApiEl.value = provider.apiUrl || '';
            if (providerTtlEl) providerTtlEl.value = String(Math.max(1, Math.floor(Number(provider.ttlMinutes) || 10)));
            if (providerAuthHeaderEl) providerAuthHeaderEl.value = provider.authHeader || '';
            if (providerAuthSecretEl) {
                providerAuthSecretEl.value = '';
                providerAuthSecretEl.dataset.keepSecret = provider.keepAuthToken ? 'true' : 'false';
                providerAuthSecretEl.placeholder = provider.authTokenConfigured
                    ? `已保存密钥：${provider.authTokenPreview || '********'}，留空保留`
                    : '鉴权密钥内容';
            }
            const clearProviderSecretEl = byId('providerProxyClearAuthSecret');
            if (clearProviderSecretEl) clearProviderSecretEl.checked = false;

            if (statusEl) {
                if (!data.enabled) {
                    statusEl.textContent = '当前未启用网络出口';
                    return;
                }

                const cityCount = Array.isArray(data.cityProxyPool)
                    ? data.cityProxyPool.filter(item => item?.enabled !== false && item?.proxyUrlConfigured).length
                    : 0;
                const defaultProxyUrl = data.defaultProxyUrl || data.proxyUrl || '';
                const defaultProxyLabel = defaultProxyUrl
                    ? maskProxyUrl(defaultProxyUrl)
                    : (data.defaultProxyUrlConfigured ? data.defaultProxyUrlPreview : '直连');
                const parts = [
                    '网络出口已启用',
                    data.autoCityProxyEnabled ? `城市网络出口 ${cityCount} 条` : '城市自动匹配关闭',
                    `默认 ${defaultProxyLabel}`,
                    provider.enabled ? '供应商出口补充已启用' : '供应商出口补充关闭'
                ];
                statusEl.textContent = parts.join(' ｜ ');
            }
        }

        function collectSettings() {
            const defaultProxyEl = byId('networkDefaultProxyUrl');
            const providerSecretEl = byId('providerProxyAuthSecret');
            const defaultProxyUrl = defaultProxyEl?.value?.trim() || '';
            const providerAuthToken = providerSecretEl?.value?.trim() || '';
            return {
                enabled: Boolean(byId('networkProxyEnabled')?.checked),
                defaultProxyUrl,
                keepDefaultProxyUrl: !defaultProxyUrl && defaultProxyEl?.dataset.keepSecret === 'true',
                autoCityProxyEnabled: Boolean(byId('autoCityProxyEnabled')?.checked),
                cityProxyPool: collectCityProxyPoolFromRows(),
                providerProxy: {
                    enabled: Boolean(byId('providerProxyEnabled')?.checked),
                    apiUrl: byId('providerProxyApiUrl')?.value?.trim() || '',
                    authHeader: byId('providerProxyAuthHeader')?.value?.trim() || '',
                    [providerAuthSecretField]: providerAuthToken,
                    keepAuthToken: !providerAuthToken && providerSecretEl?.dataset.keepSecret === 'true',
                    clearAuthToken: Boolean(byId('providerProxyClearAuthSecret')?.checked),
                    ttlMinutes: positiveInteger('providerProxyTtl', 10)
                }
            };
        }

        function renderCityProxyPool(pool = []) {
            const container = byId('cityProxyPoolRows');
            if (!container) {
                return;
            }

            container.innerHTML = '';
            const rows = Array.isArray(pool) && pool.length > 0
                ? pool
                : [{ enabled: true, province: '', city: '', proxyUrl: '' }];
            rows.forEach(item => appendCityProxyRow(item));
        }

        function appendCityProxyRow(item = {}) {
            const container = byId('cityProxyPoolRows');
            if (!container) {
                return;
            }

            const row = documentRef.createElement('div');
            row.className = 'proxy-pool-row';
            row.dataset.proxyId = item.id || '';
            row.dataset.keepProxyUrl = item.keepProxyUrl ? 'true' : 'false';
            const proxyPlaceholder = item.proxyUrlSecret
                ? `${item.proxyUrlPreview || '已保存凭据'}，留空保留`
                : 'http://user:pass@host:port';
            row.innerHTML = `
                <input class="city-proxy-province" type="text" placeholder="省份" value="${escapeHtml(item.province || '')}">
                <input class="city-proxy-city" type="text" placeholder="城市" value="${escapeHtml(item.city || '')}">
                <input class="city-proxy-url" type="password" autocomplete="off" placeholder="${escapeHtml(proxyPlaceholder)}" value="${escapeHtml(item.proxyUrl || '')}">
                <label class="inline-field" style="padding:8px 10px;">
                    <input class="city-proxy-enabled" type="checkbox" ${item.enabled === false ? '' : 'checked'}>
                    <span>启用</span>
                </label>
                <button class="btn btn-secondary city-proxy-remove" type="button">删除</button>
            `;
            row.querySelector('.city-proxy-remove')?.addEventListener('click', () => {
                row.remove();
                const remaining = container.querySelectorAll('.proxy-pool-row');
                if (remaining.length === 0) {
                    appendCityProxyRow();
                }
            });
            container.appendChild(row);
        }

        function collectCityProxyPoolFromRows() {
            return Array.from(documentRef.querySelectorAll('#cityProxyPoolRows .proxy-pool-row'))
                .map(row => {
                    const proxyUrl = row.querySelector('.city-proxy-url')?.value?.trim() || '';
                    return {
                        id: row.dataset.proxyId || '',
                        enabled: Boolean(row.querySelector('.city-proxy-enabled')?.checked),
                        province: row.querySelector('.city-proxy-province')?.value?.trim() || '',
                        city: row.querySelector('.city-proxy-city')?.value?.trim() || '',
                        proxyUrl,
                        keepProxyUrl: !proxyUrl && row.dataset.keepProxyUrl === 'true'
                    };
                })
                .filter(item => item.province || item.city || item.proxyUrl || item.keepProxyUrl);
        }

        return {
            appendCityProxyRow,
            collectCityProxyPoolFromRows,
            collectSettings,
            renderCityProxyPool,
            renderSettings
        };
    }

    global.NetworkSettingsControl = { createController };
})(window);
