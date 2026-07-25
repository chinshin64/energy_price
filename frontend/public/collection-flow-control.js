(function attachCollectionFlowControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Collection flow dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function splitTargets(raw) {
            return Array.from(new Set(
                String(raw || '')
                    .split(/[\n,，;；|]/)
                    .map(item => item.trim())
                    .filter(Boolean)
            ));
        }

        function collectTargets(primaryInputId, presetInputId = 'collectPresetCity') {
            const raw = [
                byId(primaryInputId)?.value || '',
                byId(presetInputId)?.value || ''
            ]
                .filter(Boolean)
                .join('\n');
            return splitTargets(raw);
        }

        function getAutomationCities() {
            return collectTargets('automationCities');
        }

        function getPageOcrCities() {
            return collectTargets('pageOcrCities');
        }

        function getPageOcrScrollOptions() {
            return {
                scrollMode: 'count',
                scrollCount: parseInt(byId('pageOcrScrollCount')?.value, 10) || 10,
                scrollIntervalMin: parseInt(byId('pageOcrIntervalMin')?.value, 10) || 3000,
                scrollIntervalMax: parseInt(byId('pageOcrIntervalMax')?.value, 10) || 5000,
                pageCaptureBatchSize: 1
            };
        }

        function setButtonGroupRunning(startId, finishId, cancelId, running) {
            const startButton = byId(startId);
            const finishButton = byId(finishId);
            const cancelButton = byId(cancelId);

            if (startButton) startButton.style.display = running ? 'none' : 'inline-block';
            if (finishButton) finishButton.style.display = running ? 'inline-block' : 'none';
            if (cancelButton) cancelButton.style.display = running ? 'inline-block' : 'none';
        }

        function setPageOcrButtons(running) {
            setButtonGroupRunning('startPageOcrCollect', 'finishPageOcrCollect', 'cancelPageOcrCollect', running);
        }

        function setCaptureCollectButtons(running) {
            setButtonGroupRunning('startCollect', 'finishCollect', 'cancelCollect', running);
        }

        function renderPageCollectionModes(modes = []) {
            const container = byId('pageCollectionModes');
            if (!container) {
                return;
            }

            container.innerHTML = modes.map((mode) => `
                <div class="mode-option ${mode.recommended ? 'recommended' : ''}">
                    <strong>${escapeHtml(mode.name)}${mode.recommended ? '（推荐）' : ''}</strong>
                </div>
            `).join('');
        }

        function updatePageCollectionModeHint() {
            const select = byId('pageCollectionMode');
            const banner = byId('pageModeStatus');
            if (!select || !banner) {
                return;
            }

            if (select.value === 'page-assisted') {
                setStatusBannerState(banner, '人工辅助', 'warn');
            } else {
                setStatusBannerState(banner, '自动下滑识别', 'success');
            }
        }

        function updateScrollModeStyle(mode) {
            documentRef.querySelectorAll('input[name="scrollMode"]').forEach(radio => {
                const label = radio.closest('label');
                const text = label?.querySelector('span');
                if (!label) {
                    return;
                }
                if (radio.value === mode) {
                    label.style.background = '#e8f4fd';
                    label.style.border = '2px solid #3b82f6';
                    if (text) text.style.color = '#1d4ed8';
                } else {
                    label.style.background = '#f8fafc';
                    label.style.border = '2px solid transparent';
                    if (text) text.style.color = '';
                }
            });
        }

        function applyScrollMode(mode) {
            const isCountMode = mode === 'count';
            const countSection = byId('scrollCountSection');
            const durationSection = byId('scrollDurationSection');
            if (countSection) countSection.style.display = isCountMode ? 'flex' : 'none';
            if (durationSection) durationSection.style.display = isCountMode ? 'none' : 'flex';
            updateScrollModeStyle(mode);
        }

        function initScrollModeControl() {
            const checkedMode = documentRef.querySelector('input[name="scrollMode"]:checked')?.value || 'duration';
            applyScrollMode(checkedMode);
            documentRef.querySelectorAll('input[name="scrollMode"]').forEach(radio => {
                radio.addEventListener('change', event => {
                    applyScrollMode(event.target.value);
                });
            });
        }

        return {
            getAutomationCities,
            getPageOcrCities,
            getPageOcrScrollOptions,
            initScrollModeControl,
            renderPageCollectionModes,
            setCaptureCollectButtons,
            setPageOcrButtons,
            splitTargets,
            updatePageCollectionModeHint
        };
    }

    global.CollectionFlowControl = { createController };
})(window);
