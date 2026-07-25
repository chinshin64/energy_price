(function attachPageCollectionControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Page collection dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchFn = deps.fetch || global.fetch;
        const serviceBase = requireDependency(deps, 'serviceBase');
        const defaultPlatformId = requireDependency(deps, 'defaultPlatformId');
        const ensureSelectedPlatforms = requireDependency(deps, 'ensureSelectedPlatforms');
        const fetchJsonOrThrow = requireDependency(deps, 'fetchJsonOrThrow');
        const formatUserReason = requireDependency(deps, 'formatUserReason');
        const renderPageCollectionResult = requireDependency(deps, 'renderPageCollectionResult');
        const setPageCollectionTrace = requireDependency(deps, 'setPageCollectionTrace');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');
        const addLog = deps.addLog || (() => {});
        const alertFn = deps.alert || global.alert || (() => {});

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function getPlatform() {
            ensureSelectedPlatforms();
            const selectedPlatforms = Array.isArray(deps.getSelectedPlatforms?.())
                ? deps.getSelectedPlatforms()
                : [];
            return selectedPlatforms[0] || defaultPlatformId;
        }

        function setBanner(message, tone = 'info') {
            const banner = byId('method1ReasonBanner');
            if (banner) {
                setStatusBannerState(banner, message, tone);
            }
        }

        function formatReason(reason) {
            return formatUserReason(reason || 'unknown_error', { includeTech: false });
        }

        async function refreshStatus() {
            const platform = getPlatform();
            setBanner('正在检查页面验证环境...', 'info');

            try {
                let result;
                try {
                    result = await fetchJsonOrThrow(`${serviceBase}/method1/workflow?platform=${encodeURIComponent(platform)}`);
                } catch {
                    result = await fetchJsonOrThrow(`${serviceBase}/method1/status?platform=${encodeURIComponent(platform)}`);
                }
                renderPageCollectionResult(result);
                return result;
            } catch (error) {
                const fallback = {
                    success: true,
                    available: false,
                    reason: 'unknown_error',
                    error: error.message,
                    checks: {}
                };
                renderPageCollectionResult(fallback);
                return fallback;
            }
        }

        async function runBasicCheck() {
            const platform = getPlatform();
            setBanner('正在快速验证页面能力...', 'info');

            try {
                const res = await fetchFn(`${serviceBase}/method1/run-basic-check`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ platform })
                });
                const result = await res.json();
                renderPageCollectionResult(result);
                if (result.available) {
                    addLog('✅ 页面快速验证完成', 'success');
                } else {
                    addLog(`❌ 页面快速验证未通过：${formatReason(result.reason)}`, 'error');
                }
                return result;
            } catch (error) {
                const fallback = {
                    success: true,
                    available: false,
                    reason: 'unknown_error',
                    error: error.message,
                    checks: {}
                };
                renderPageCollectionResult(fallback);
                addLog(`❌ 页面快速验证请求失败：${error.message}`, 'error');
                return fallback;
            }
        }

        async function postAction(path, payload = {}, runningMessage = '') {
            const platform = getPlatform();
            if (runningMessage) {
                setBanner(runningMessage, 'info');
            }
            const res = await fetchFn(`${serviceBase}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ platform, ...payload })
            });
            const result = await res.json();
            setPageCollectionTrace(result);
            if (result.capture || result.observation || result.before || result.after || result.status) {
                renderPageCollectionResult(result.status || result);
            }
            const ok = result.success && result.available !== false;
            setBanner(
                ok ? `页面动作完成：${formatReason(result.reason || 'success')}` : `页面动作失败：${formatReason(result.reason)}`,
                ok ? 'success' : 'warn'
            );
            addLog(
                ok ? `✅ 页面动作完成：${path}` : `⚠️ 页面动作失败：${formatReason(result.reason)}`,
                ok ? 'success' : 'warn'
            );
            return result;
        }

        function openMiniapp() {
            return postAction('/method1/open-miniapp', {}, '正在尝试打开电脑端微信小程序...');
        }

        function observePage() {
            return postAction('/method1/actions/observe', {}, '正在观察当前页面...');
        }

        function scrollOnce() {
            return postAction('/method1/actions/scroll', {}, '正在执行下滑...');
        }

        function backOnce() {
            return postAction('/method1/actions/back', {}, '正在执行返回...');
        }

        function switchCity() {
            const city = String(byId('method1CityInput')?.value || '').trim();
            if (!city) {
                alertFn('请输入目标城市');
                return null;
            }
            return postAction('/method1/actions/switch-city', { city }, `正在切换城市：${city}`);
        }

        function tapByText() {
            const text = String(byId('method1TapTextInput')?.value || '').trim();
            if (!text) {
                alertFn('请输入要点击的文字');
                return null;
            }
            return postAction('/method1/actions/tap-by-text', { text }, `正在按文字点击：${text}`);
        }

        function runAdaptive() {
            return postAction('/method1/actions/run-adaptive', {
                goal: 'station_list_scroll',
                limits: { maxSteps: 20, maxScrolls: 5, maxDurationSeconds: 180 }
            }, '正在智能浏览并判断下一步操作...');
        }

        return {
            backOnce,
            getPlatform,
            observePage,
            openMiniapp,
            postAction,
            refreshStatus,
            runAdaptive,
            runBasicCheck,
            scrollOnce,
            switchCity,
            tapByText
        };
    }

    global.PageCollectionControl = { createController };
})(window);
