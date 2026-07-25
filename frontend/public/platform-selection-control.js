(function attachPlatformSelectionControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Platform selection dependency missing: ${name}`);
        }
        return value;
    }

    function normalizePlatformList(value) {
        return Array.isArray(value) ? value : [];
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const getPlatformName = requireDependency(deps, 'getPlatformName');
        const getSelectedPlatforms = requireDependency(deps, 'getSelectedPlatforms');
        const setSelectedPlatforms = requireDependency(deps, 'setSelectedPlatforms');
        const defaultPlatformId = deps.defaultPlatformId || 'didi-charging';
        const getConfiguredPlatforms = deps.getConfiguredPlatforms || function emptyPlatforms() { return []; };

        function selected() {
            return normalizePlatformList(getSelectedPlatforms()).filter(Boolean);
        }

        function setSelected(next) {
            const normalized = Array.from(new Set(normalizePlatformList(next).filter(Boolean)));
            setSelectedPlatforms(normalized);
            return normalized;
        }

        function getAvailablePlatformIds(platforms = null) {
            const source = Array.isArray(platforms) ? platforms : normalizePlatformList(getConfiguredPlatforms());
            const ids = source.map(item => item?.id).filter(Boolean);
            if (ids.length > 0) {
                return ids;
            }
            return Array.from(documentRef.querySelectorAll('.platform-card[data-id]'))
                .map(card => card.dataset.id)
                .filter(Boolean);
        }

        function updateSelectedPlatformSummary() {
            const current = selected();
            const selectedNames = current.length > 0
                ? current.map(getPlatformName).join('、')
                : '未选择';

            documentRef.querySelectorAll('[data-selected-platform-summary]').forEach(element => {
                element.textContent = selectedNames;
            });
            documentRef.querySelectorAll('[data-selected-platform-count]').forEach(element => {
                element.textContent = String(current.length);
            });
        }

        function syncPlatformCardSelection() {
            const current = selected();
            documentRef.querySelectorAll('.platform-card').forEach(card => {
                const id = card.dataset.id;
                const isSelected = current.includes(id);
                card.classList.toggle('selected', isSelected);
                const statusEl = card.querySelector('.status');
                if (statusEl) {
                    statusEl.textContent = isSelected ? '已选中' : '点击选择';
                }
            });

            updateSelectedPlatformSummary();
        }

        function ensureSelectedPlatforms(options = {}) {
            const availableIds = getAvailablePlatformIds(options.platforms);
            const validIds = new Set(availableIds);
            const selectedCardIds = Array.from(documentRef.querySelectorAll('.platform-card.selected[data-id]'))
                .map(card => card.dataset.id)
                .filter(Boolean);
            let merged = []
                .concat(selected())
                .concat(selectedCardIds)
                .filter(Boolean)
                .filter(id => validIds.size === 0 || validIds.has(id));

            merged = Array.from(new Set(merged));

            if (merged.length === 0) {
                if (validIds.has(defaultPlatformId)) {
                    merged = [defaultPlatformId];
                } else if (availableIds.length > 0) {
                    merged = [availableIds[0]];
                } else {
                    merged = [defaultPlatformId];
                }
            }

            const normalized = setSelected(merged);

            if (options.sync !== false) {
                syncPlatformCardSelection();
            } else {
                updateSelectedPlatformSummary();
            }

            return normalized;
        }

        function renderPlatforms(platforms) {
            const list = normalizePlatformList(platforms);
            const current = ensureSelectedPlatforms({ platforms: list, sync: false });

            const containers = Array.from(documentRef.querySelectorAll('[data-platform-list], #platformList'));
            containers.forEach(container => {
                container.innerHTML = list.map(platform => {
                    const id = platform?.id || '';
                    const isSelected = current.includes(id);
                    return `
                        <div class="platform-card ${isSelected ? 'selected' : ''}" data-id="${escapeHtml(id)}">
                            <h3>${escapeHtml(platform?.name || id)}</h3>
                            <div class="status">${isSelected ? '已选中' : '点击选择'}</div>
                        </div>
                    `;
                }).join('');
            });

            documentRef.querySelectorAll('.platform-card').forEach(card => {
                card.addEventListener('click', () => {
                    const id = card.dataset.id;
                    const currentSelected = selected();
                    if (currentSelected.includes(id)) {
                        setSelected(currentSelected.filter(platform => platform !== id));
                    } else {
                        setSelected(currentSelected.concat(id));
                    }
                    syncPlatformCardSelection();
                });
            });

            syncPlatformCardSelection();
        }

        function renderPlatformFilter(platforms) {
            const select = documentRef.getElementById('platformFilter');
            if (!select) {
                return;
            }
            select.innerHTML = '<option value="">所有平台</option>' +
                normalizePlatformList(platforms)
                    .map(platform => `<option value="${escapeHtml(platform?.id || '')}">${escapeHtml(platform?.name || platform?.id || '')}</option>`)
                    .join('');
        }

        return {
            ensureSelectedPlatforms,
            getAvailablePlatformIds,
            renderPlatformFilter,
            renderPlatforms,
            syncPlatformCardSelection,
            updateSelectedPlatformSummary
        };
    }

    global.PlatformSelectionControl = { createController };
})(window);
