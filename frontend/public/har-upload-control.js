(function attachHarUploadControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`HAR upload dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchRef = deps.fetch || global.fetch?.bind(global);
        const alertRef = deps.alert || global.alert?.bind(global) || function noop() {};
        const serviceBase = requireDependency(deps, 'serviceBase');
        const addParseLog = requireDependency(deps, 'addParseLog');
        const refreshData = requireDependency(deps, 'refreshData');
        let selectedFiles = [];

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function setParseButtonVisible(visible) {
            const button = byId('parseHarBtn');
            if (button) {
                button.style.display = visible ? 'inline-block' : 'none';
            }
        }

        function handleFileSelect(event) {
            const files = Array.from(event.target.files || []);
            if (files.length === 0) return;

            selectedFiles = files;
            renderFileList();
            setParseButtonVisible(true);
            addParseLog(`已选择 ${files.length} 个文件`, 'success');
        }

        function renderFileList() {
            const container = byId('uploadFileList');
            if (!container) {
                return;
            }
            container.innerHTML = '';

            selectedFiles.forEach((file, index) => {
                const item = documentRef.createElement('div');
                item.className = 'file-item';

                const detail = documentRef.createElement('div');
                const name = documentRef.createElement('div');
                name.className = 'file-name';
                name.textContent = `文件 ${file.name}`;
                const size = documentRef.createElement('div');
                size.className = 'file-size';
                size.textContent = formatFileSize(file.size);
                detail.appendChild(name);
                detail.appendChild(size);

                const remove = documentRef.createElement('button');
                remove.className = 'remove-btn';
                remove.type = 'button';
                remove.textContent = '移除';
                remove.addEventListener('click', () => removeFile(index));

                item.appendChild(detail);
                item.appendChild(remove);
                container.appendChild(item);
            });
        }

        function removeFile(index) {
            selectedFiles.splice(index, 1);
            renderFileList();

            if (selectedFiles.length === 0) {
                setParseButtonVisible(false);
            }

            addParseLog('已移除文件', 'info');
        }

        function formatFileSize(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
            return (bytes / 1024 / 1024).toFixed(2) + ' MB';
        }

        async function parseHarFiles() {
            if (selectedFiles.length === 0) {
                alertRef('请先选择文件');
                return;
            }

            const parseBtn = byId('parseHarBtn');
            if (parseBtn) {
                parseBtn.disabled = true;
                parseBtn.textContent = '解析中...';
            }

            addParseLog(`开始解析 ${selectedFiles.length} 个文件...`, 'info');

            let totalStations = 0;
            let successCount = 0;
            let failCount = 0;

            for (let i = 0; i < selectedFiles.length; i++) {
                const file = selectedFiles[i];

                try {
                    addParseLog(`[${i + 1}/${selectedFiles.length}] 正在解析: ${file.name}`, 'info');
                    const content = await readFileAsText(file);
                    const res = await fetchRef(`${serviceBase}/parse-har-upload`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            filename: file.name,
                            content
                        })
                    });

                    const result = await res.json();

                    if (result.success) {
                        successCount++;
                        totalStations += result.stationCount || 0;
                        addParseLog(`${file.name}: 解析成功，找到 ${result.stationCount} 个场站`, 'success');
                    } else {
                        failCount++;
                        addParseLog(`${file.name}: ${result.error}`, 'error');
                    }
                } catch (error) {
                    failCount++;
                    addParseLog(`${file.name}: ${error.message}`, 'error');
                }
            }

            addParseLog(`解析完成！成功: ${successCount}, 失败: ${failCount}, 总计场站: ${totalStations}`, 'success');

            if (parseBtn) {
                parseBtn.disabled = false;
                parseBtn.textContent = '开始解析';
            }

            selectedFiles = [];
            renderFileList();
            const input = byId('harFileInput');
            if (input) input.value = '';
            setParseButtonVisible(false);
            refreshData();
        }

        function readFileAsText(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = event => resolve(event.target.result);
                reader.onerror = () => reject(new Error('文件读取失败'));
                reader.readAsText(file);
            });
        }

        return {
            formatFileSize,
            handleFileSelect,
            parseHarFiles,
            readFileAsText,
            removeFile,
            renderFileList
        };
    }

    global.HarUploadControl = { createController };
})(window);
