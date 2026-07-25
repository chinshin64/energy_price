
// ============ 智能爬虫功能 ============

let crawlerHarFile = null;
let learnedPatterns = [];
let selectedPattern = null;
let generatedCoordinates = [];

function formatCrawlerRequestBudget(requestBudget) {
    if (!requestBudget) {
        return '';
    }

    const suffix = requestBudget.exhausted ? '，已达上限' : '';
    return `请求保护 ${requestBudget.used}/${requestBudget.limit}${suffix}`;
}

function buildCrawlerTargetLocation(centerLat, centerLng) {
    const keyword = document.getElementById('crawlerPresetCity')?.value?.trim() || '';
    return {
        keyword,
        name: keyword,
        lat: Number.isFinite(centerLat) ? centerLat : null,
        lng: Number.isFinite(centerLng) ? centerLng : null
    };
}

function getScopeBadge(scope) {
    const value = scope === 'detail' ? 'detail' : 'list';
    const label = value === 'detail' ? '详情材料' : '列表材料';
    return `<span class="scope-badge ${value}">${label}</span>`;
}

function setupCrawlerListeners() {
    if (typeof setupCityPresetInput === 'function') {
        setupCityPresetInput({
            inputId: 'crawlerPresetCity',
            datalistId: 'crawlerPresetCityList',
            latId: 'centerLat',
            lngId: 'centerLng',
            metaId: 'crawlerPresetCityMeta'
        });
    }
    document.getElementById('crawlerHarInput').addEventListener('change', handleCrawlerHarSelect);
    document.getElementById('learnApiBtn').addEventListener('click', learnApiPatterns);
    document.getElementById('saveAllTemplatesBtn').addEventListener('click', saveAllTemplates);
    document.getElementById('showLearnTab').addEventListener('click', showLearnArea);
    document.getElementById('showTemplatesTab').addEventListener('click', showTemplatesArea);
    document.getElementById('dedupeTemplatesBtn').addEventListener('click', deduplicateTemplates);
    document.getElementById('refreshTemplatesBtn').addEventListener('click', loadTemplates);
    document.getElementById('generateGridBtn').addEventListener('click', generateGridCoordinates);
    document.getElementById('startCrawlBtn').addEventListener('click', startCrawling);
    
    // 默认加载已有请求材料
    loadTemplates();
}

function handleCrawlerHarSelect(event) {
    const file = event.target.files[0];
    
    if (!file) return;
    
    crawlerHarFile = file;
    document.getElementById('learnedFileName').textContent = `已选择: ${file.name}`;
    document.getElementById('learnApiBtn').style.display = 'inline-block';
    
    addCrawlerLog(`已选择文件: ${file.name}`, 'info');
}

async function learnApiPatterns() {
    if (!crawlerHarFile) {
        alert('请先选择历史请求记录文件');
        return;
    }
    
    const learnBtn = document.getElementById('learnApiBtn');
    learnBtn.disabled = true;
    learnBtn.textContent = '识别中...';
    
    addCrawlerLog(`开始分析历史请求记录：${crawlerHarFile.name}`, 'info');
    
    try {
        // 读取文件内容
        const content = await readFileAsText(crawlerHarFile);
        
        // 发送到后端识别请求材料
        const res = await fetch(`${SERVICE_BASE}/crawler/learn-upload`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filename: crawlerHarFile.name,
                content: content
            })
        });
        
        const result = await res.json();
        
        if (result.success) {
            learnedPatterns = result.patterns;
            addCrawlerLog(`识别成功，沉淀 ${learnedPatterns.length} 份请求材料`, 'success');
            
            // 显示请求材料列表
            renderApiPatterns(learnedPatterns);
            document.getElementById('apiPatternSection').style.display = 'block';
            // 显示保存按钮
            document.getElementById('saveAllTemplatesBtn').style.display = 'inline-block';
        } else {
            addCrawlerLog(`识别失败，请检查文件格式`, 'error');
        }
    } catch (error) {
        addCrawlerLog(`识别失败，请重试`, 'error');
    } finally {
        learnBtn.disabled = false;
        learnBtn.textContent = '开始识别';
    }
}

function renderApiPatterns(patterns) {
    const container = document.getElementById('apiPatternList');
    
    if (patterns.length === 0) {
        container.innerHTML = '<p style="color: #999;">未找到可用于访问验证的请求材料</p>';
        return;
    }
    
    container.innerHTML = patterns.map((p, index) => {
        const variableParamKeys = Object.keys(p.variableParams || {});
        const hasVariableParams = variableParamKeys.length > 0;
        
        // 统计所有参数
        const bodyParamCount = Object.keys(p.bodyParams || {}).length;
        const queryParamCount = Object.keys(p.queryParams || {}).length;
        const totalParams = bodyParamCount + queryParamCount;
        
        return `
        <div class="api-pattern-card" data-index="${index}">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:8px;">
                <h4 style="margin:0;">${p.platform.toUpperCase()} 请求材料</h4>
                ${getScopeBadge(p.templateScope)}
            </div>
            <p><strong>访问方式:</strong> ${p.method}</p>
            <p><strong>业务请求:</strong> 请求材料 #${index + 1}</p>
            <p><strong>可调整参数:</strong> ${hasVariableParams ? variableParamKeys.join(', ') : '<span style="color: #ff9800;">无自动识别</span>'}</p>
            <p style="font-size: 12px; color: #666;">
                <strong>参数统计:</strong> 请求参数 ${bodyParamCount + queryParamCount} 个
                ${!hasVariableParams && totalParams > 0 ? ' | <span style="color: #ff9800;">点击查看所有参数</span>' : ''}
            </p>
        </div>
    `}).join('');
    
    // 添加点击事件
    container.querySelectorAll('.api-pattern-card').forEach(card => {
        card.addEventListener('click', () => {
            // 移除其他选中状态
            container.querySelectorAll('.api-pattern-card').forEach(c => c.classList.remove('selected'));
            // 选中当前
            card.classList.add('selected');
            
            const index = parseInt(card.dataset.index);
            selectedPattern = patterns[index];
            
            addCrawlerLog(`已选择 ${selectedPattern.platform} 请求材料`, 'info');
            
            // 显示参数详情
            showPatternDetails(selectedPattern);
            
            // 显示配置区域
            document.getElementById('crawlConfigSection').style.display = 'block';
        });
    });
}

function showPatternDetails(pattern) {
    const variableParams = pattern.variableParams || {};
    const bodyParams = pattern.bodyParams || {};
    const queryParams = pattern.queryParams || {};
    
    let detailsHtml = '<div style="margin-top: 15px; padding: 15px; background: #f8f9ff; border-radius: 8px; border: 1px solid #e0e0e0;">';
    detailsHtml += '<h4 style="margin-bottom: 10px;">请求材料参数详情</h4>';
    detailsHtml += `<div style="margin-bottom: 12px;">材料类型: ${getScopeBadge(pattern.templateScope)}</div>`;
    
    // 显示可变参数
    if (Object.keys(variableParams).length > 0) {
        detailsHtml += '<div style="margin-bottom: 10px;"><strong>已识别的可调整参数:</strong></div>';
        detailsHtml += '<table style="width: 100%; font-size: 12px; margin-bottom: 15px;">';
        detailsHtml += '<tr style="background: #667eea; color: white;"><th style="padding: 5px;">参数名</th><th>参数位置</th><th>值类型</th><th>示例值</th></tr>';
        
        for (const [key, info] of Object.entries(variableParams)) {
            detailsHtml += `<tr style="border-bottom: 1px solid #ddd;">
                <td style="padding: 5px;"><code>${key}</code></td>
                <td>${info.location}</td>
                <td>${info.type}</td>
                <td style="max-width: 150px; overflow: hidden; text-overflow: ellipsis;">${info.sample}</td>
            </tr>`;
        }
        detailsHtml += '</table>';
    } else {
        detailsHtml += '<div style="color: #ff9800; margin-bottom: 10px;"><strong>未自动识别到可调整参数</strong></div>';
        detailsHtml += '<p style="font-size: 12px; color: #666; margin-bottom: 10px;">这可能意味着：</p>';
        detailsHtml += '<ul style="font-size: 12px; color: #666; margin-left: 20px; margin-bottom: 10px;">';
        detailsHtml += '<li>该业务请求不适合批量访问验证（如配置、静态数据类请求）</li>';
        detailsHtml += '<li>参数名不常见，未被识别规则匹配</li>';
        detailsHtml += '<li>需要手动配置参数</li>';
        detailsHtml += '</ul>';
    }
    
    // 显示所有 Body 参数
    if (Object.keys(bodyParams).length > 0) {
        detailsHtml += '<div style="margin-bottom: 10px;"><strong>请求体参数:</strong></div>';
        detailsHtml += '<div style="background: white; padding: 10px; border-radius: 5px; font-size: 12px;">';
        detailsHtml += Object.keys(bodyParams).join(', ') || '无';
        detailsHtml += '</div>';
    }
    
    // 显示所有 Query 参数
    if (Object.keys(queryParams).length > 0) {
        detailsHtml += '<div style="margin-top: 10px; margin-bottom: 10px;"><strong>查询参数:</strong></div>';
        detailsHtml += '<div style="background: white; padding: 10px; border-radius: 5px; font-size: 12px;">';
        detailsHtml += Object.keys(queryParams).join(', ') || '无';
        detailsHtml += '</div>';
    }
    
    detailsHtml += '</div>';
    
    // 插入到配置区域之前
    const configSection = document.getElementById('crawlConfigSection');
    let existingDetails = document.getElementById('patternDetails');
    
    if (existingDetails) {
        existingDetails.innerHTML = detailsHtml;
    } else {
        const detailsDiv = document.createElement('div');
        detailsDiv.id = 'patternDetails';
        detailsDiv.innerHTML = detailsHtml;
        configSection.parentNode.insertBefore(detailsDiv, configSection);
    }
    
    addCrawlerLog('参数详情已显示，请查看上方', 'info');
}

async function generateGridCoordinates() {
    const centerLat = parseFloat(document.getElementById('centerLat').value);
    const centerLng = parseFloat(document.getElementById('centerLng').value);
    const radius = parseFloat(document.getElementById('crawlRadius').value) || 10;
    const gridSize = parseFloat(document.getElementById('gridSize').value) || 2;
    
    if (!centerLat || !centerLng) {
        alert('请输入中心坐标');
        return;
    }
    
    addCrawlerLog(`生成网格坐标: 中心 (${centerLat}, ${centerLng}), 半径 ${radius}km, 网格 ${gridSize}km`, 'info');
    
    try {
        const res = await fetch(`${SERVICE_BASE}/crawler/generate-grid`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                centerLat,
                centerLng,
                radius,
                gridSize
            })
        });
        
        const result = await res.json();
        
        if (result.success) {
            generatedCoordinates = result.coordinates;
            document.getElementById('gridInfo').textContent = `已生成 ${result.count} 个坐标点`;
            addCrawlerLog(`生成 ${result.count} 个网格坐标`, 'success');
        } else {
            addCrawlerLog(`生成失败，请检查参数`, 'error');
        }
    } catch (error) {
        addCrawlerLog(`生成失败，请重试`, 'error');
    }
}

async function startCrawling() {
    if (!selectedPattern) {
        alert('请先选择请求材料');
        return;
    }
    
    if (generatedCoordinates.length === 0) {
        alert('请先生成网格坐标');
        return;
    }
    
    const pageSize = parseInt(document.getElementById('pageSize').value) || 20;
    const maxPages = parseInt(document.getElementById('maxPages').value) || 5;
    const centerLat = parseFloat(document.getElementById('centerLat').value);
    const centerLng = parseFloat(document.getElementById('centerLng').value);
    const radius = parseFloat(document.getElementById('crawlRadius').value) || 10;
    const gridSize = parseFloat(document.getElementById('gridSize').value) || 2;
    const crawlMode = document.getElementById('crawlerMode')?.value || 'both';
    const unlimited = Boolean(document.getElementById('crawlerUnlimitedRunInput')?.checked);
    const rawPerRunLimit = document.getElementById('crawlerRunLimitInput')?.value?.trim() || '';
    const perRunLimit = unlimited || !rawPerRunLimit ? null : (Number(rawPerRunLimit) || 100);
    const targetLocation = buildCrawlerTargetLocation(centerLat, centerLng);
    
    const startBtn = document.getElementById('startCrawlBtn');
    startBtn.disabled = true;
    startBtn.textContent = '验证中...';
    
    addCrawlerLog(`开始访问验证：${selectedPattern.platform}`, 'info');
    addCrawlerLog(`已生成 ${generatedCoordinates.length} 个坐标点`, 'info');
    
    try {
        let result;

        if (crawlMode !== 'list' || (selectedPattern.templateScope || 'list') === 'detail') {
            addCrawlerLog(`切换为平台级检索，使用 ${crawlMode} 模式执行 ${selectedPattern.platform}`, 'info');

            const res = await fetch(`${SERVICE_BASE}/crawler/crawl-platforms-with-coordinates`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    platforms: [selectedPattern.platform],
                    centerLat,
                    centerLng,
                    radius,
                    gridSize,
                    pageSize,
                    maxPages,
                    crawlMode,
                    perRunLimit,
                    perRunUnlimited: perRunLimit === null,
                    targetLocation
                })
            });

            result = await res.json();
        } else {
            const res = await fetch(`${SERVICE_BASE}/crawler/crawl`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    pattern: selectedPattern,
                    coordinates: generatedCoordinates,
                    pageSize,
                    maxPages,
                    perRunLimit,
                    perRunUnlimited: perRunLimit === null,
                    targetLocation
                })
            });

            result = await res.json();
        }
        
        if (result.success) {
            if (Array.isArray(result.summary)) {
                addCrawlerLog(`平台级访问验证完成，总解析 ${result.totalStations} 个场站`, 'success');
                result.summary.forEach(item => {
                    if (!item.success) {
                        const reasonMap = {
                            'run_request_limit_exceeded': '当次请求已达上限',
                            'signature_expired': '请求材料已过期',
                            'rate_limited': '请求过于频繁',
                            'network_error': '网络异常',
                            'auth_failed': '鉴权失败',
                            'server_error': '服务异常'
                        };
                        const reason = reasonMap[item.reason] || '执行异常，请稍后重试';
                        addCrawlerLog(`${item.platform}: ${reason}`, 'error');
                        return;
                    }

                    addCrawlerLog(
                        `${item.platform}: 列表 ${item.listStationCount}，详情 ${item.detailStationCount}，合并 ${item.stationCount}，入库 ${item.insertedCount}`,
                        'success'
                    );
                    if (item.requestBudget) {
                        addCrawlerLog(`${item.platform}: ${formatCrawlerRequestBudget(item.requestBudget)}`, item.requestBudget.exhausted ? 'info' : 'success');
                    }
                });
            } else {
                addCrawlerLog(`访问验证完成，获取 ${result.stationCount} 个场站`, 'success');
                if (result.requestBudget) {
                    addCrawlerLog(formatCrawlerRequestBudget(result.requestBudget), result.requestBudget.exhausted ? 'info' : 'success');
                }
            }
            addCrawlerLog(`数据已保存到数据库`, 'success');
            if (result.quotaStats) {
                addCrawlerLog(
                    `今日统计请求 ${result.quotaStats.totalRequests}，成功 ${result.quotaStats.successRequests}，材料校验失败 ${result.quotaStats.fail501Requests}`,
                    'info'
                );
            }
            if (result.runQuota) {
                const limitText = result.runQuota.unlimited || result.runQuota.limit === null ? '无上限' : result.runQuota.limit;
                addCrawlerLog(
                    `当次请求 ${result.runQuota.used}/${limitText}，成功 ${result.runQuota.success}，材料校验失败 ${result.runQuota.fail501}`,
                    result.runQuota.exhausted ? 'warn' : 'info'
                );
            }
            
            // 刷新数据列表
            loadStats();
            loadData();
        } else {
            addCrawlerLog(`访问验证失败，请检查网络出口配置`, 'error');
            if (result.quotaStats) {
                addCrawlerLog(
                    `今日统计请求 ${result.quotaStats.totalRequests}，成功 ${result.quotaStats.successRequests}，材料校验失败 ${result.quotaStats.fail501Requests}`,
                    'info'
                );
            }
            if (result.runQuota) {
                const limitText = result.runQuota.unlimited || result.runQuota.limit === null ? '无上限' : result.runQuota.limit;
                addCrawlerLog(
                    `当次请求 ${result.runQuota.used}/${limitText}，成功 ${result.runQuota.success}，材料校验失败 ${result.runQuota.fail501}`,
                    result.runQuota.exhausted ? 'warn' : 'info'
                );
            }
        }
    } catch (error) {
        addCrawlerLog(`访问验证失败，请重试`, 'error');
    } finally {
        if (typeof loadCrawlerRunQuota === 'function') {
            loadCrawlerRunQuota();
        }
        startBtn.disabled = false;
        startBtn.textContent = '开始访问验证';
    }
}

function addCrawlerLog(message, type = 'info') {
    const logContainer = document.getElementById('crawlerLog');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `
        <div class="timestamp">${new Date().toLocaleTimeString()}</div>
        <div>${message}</div>
    `;
    logContainer.insertBefore(entry, logContainer.firstChild);
}

// 初始化时调用
document.addEventListener('DOMContentLoaded', () => {
    setupCrawlerListeners();
});

// ============ 请求材料管理功能 ============

function showLearnArea() {
    document.getElementById('learnArea').style.display = 'block';
    document.getElementById('templatesArea').style.display = 'none';
    document.getElementById('showLearnTab').style.background = '#667eea';
    document.getElementById('showLearnTab').style.color = 'white';
    document.getElementById('showTemplatesTab').style.background = '';
    document.getElementById('showTemplatesTab').style.color = '';
}

function showTemplatesArea() {
    document.getElementById('learnArea').style.display = 'none';
    document.getElementById('templatesArea').style.display = 'block';
    document.getElementById('showLearnTab').style.background = '';
    document.getElementById('showLearnTab').style.color = '';
    document.getElementById('showTemplatesTab').style.background = '#667eea';
    document.getElementById('showTemplatesTab').style.color = 'white';
    
    loadTemplates();
}

async function loadTemplates() {
    addCrawlerLog('加载已保存的请求材料...', 'info');
    
    try {
        const res = await fetch(`${SERVICE_BASE}/templates`);
        const result = await res.json();
        
        if (result.success) {
            renderTemplates(result.data);
            addCrawlerLog(`加载了 ${result.data.length} 份请求材料`, 'success');
        } else {
            addCrawlerLog(`加载请求材料失败，请刷新页面重试`, 'error');
        }
    } catch (error) {
        addCrawlerLog(`加载请求材料失败，请检查网络连接`, 'error');
    }
}

async function deduplicateTemplates() {
    if (!confirm('确认清理重复请求材料？系统会保留重复组里最新入库的一条，删除更早的重复样本。')) {
        return;
    }

    const btn = document.getElementById('dedupeTemplatesBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '清理中...';
    }

    addCrawlerLog('开始清理重复请求材料（保留最新样本）...', 'info');

    try {
        const res = await fetch(`${SERVICE_BASE}/templates/deduplicate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ dryRun: false })
        });
        const result = await res.json();

        if (!result.success) {
            addCrawlerLog(`清理失败，请稍后重试`, 'error');
            return;
        }

        const data = result.data || {};
        addCrawlerLog(
            `清理完成：删除 ${data.removedCount || 0} 条，重复组 ${data.duplicateGroupCount || 0} 个，当前请求材料 ${data.uniqueTemplates || 0} 条`,
            'success'
        );

        await loadTemplates();
    } catch (error) {
        addCrawlerLog(`清理失败，请检查网络连接`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '清理重复请求材料';
        }
    }
}

function renderTemplates(templates) {
    const container = document.getElementById('templateList');
    
    if (templates.length === 0) {
        container.innerHTML = '<p style="color: #999;">暂无保存的请求材料，请先导入历史请求记录</p>';
        return;
    }
    
    container.innerHTML = templates.map((t, index) => {
        const variableParamKeys = Object.keys(t.variableParams || {});
        const hasVariableParams = variableParamKeys.length > 0;
        const lastUsed = t.lastUsed ? new Date(t.lastUsed).toLocaleString('zh-CN') : '从未使用';
        
        return `
        <div class="api-pattern-card" data-template-id="${t.id}" style="cursor: pointer;">
            <div style="display: flex; justify-content: space-between; align-items: start;">
                <div style="flex: 1;">
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:8px;">
                        <h4 style="margin:0;">${t.name}</h4>
                        ${getScopeBadge(t.templateScope)}
                    </div>
                    <p><strong>平台:</strong> ${t.platform.toUpperCase()}</p>
                    <p><strong>材料编号:</strong> 请求材料 #${index + 1}</p>
                    <p><strong>可调整参数:</strong> ${hasVariableParams ? variableParamKeys.join(', ') : '<span style="color: #ff9800;">无</span>'}</p>
                    <p style="font-size: 12px; color: #999;">最后使用: ${lastUsed}</p>
                </div>
                <div style="display: flex; gap: 5px;">
                    <button class="btn btn-secondary" style="padding: 5px 10px; font-size: 12px;" onclick="event.stopPropagation(); deleteTemplate(${t.id})">
                        🗑️
                    </button>
                </div>
            </div>
        </div>
    `}).join('');
    
    // 添加点击事件
    container.querySelectorAll('.api-pattern-card').forEach(card => {
        card.addEventListener('click', () => {
            const templateId = parseInt(card.dataset.templateId);
            const template = templates.find(t => t.id === templateId);
            useTemplate(template);
        });
    });
}

function useTemplate(template) {
    selectedPattern = template;
    
    addCrawlerLog(`已选择请求材料：${template.name}`, 'success');
    
    // 显示参数详情
    showPatternDetails(template);
    
    // 显示配置区域
    document.getElementById('crawlConfigSection').style.display = 'block';
    
    // 滚动到配置区域
    document.getElementById('crawlConfigSection').scrollIntoView({ behavior: 'smooth' });
}

async function saveAllTemplates() {
    if (learnedPatterns.length === 0) {
        alert('没有可保存的请求材料');
        return;
    }
    
    const saveBtn = document.getElementById('saveAllTemplatesBtn');
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
    
    addCrawlerLog(`开始保存 ${learnedPatterns.length} 份请求材料...`, 'info');
    
    try {
        const res = await fetch(`${SERVICE_BASE}/templates/batch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                patterns: learnedPatterns
            })
        });
        
        const result = await res.json();
        
        if (result.success) {
            addCrawlerLog(`成功保存 ${result.count} 份请求材料`, 'success');
            addCrawlerLog(`提示：下次可以直接使用已有请求材料，无需重新导入历史记录`, 'info');
            
            // 刷新请求材料列表
            loadTemplates();
        } else {
            addCrawlerLog(`保存失败，请稍后重试`, 'error');
        }
    } catch (error) {
        addCrawlerLog(`保存失败，请检查网络连接`, 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存所有请求材料';
    }
}

async function deleteTemplate(templateId) {
    if (!confirm('确定要删除这份请求材料吗？')) {
        return;
    }
    
    addCrawlerLog(`正在删除请求材料...`, 'info');
    
    try {
        const res = await fetch(`${SERVICE_BASE}/templates/${templateId}`, {
            method: 'DELETE'
        });
        
        const result = await res.json();
        
        if (result.success) {
            addCrawlerLog(`请求材料已删除`, 'success');
            loadTemplates();
        } else {
            addCrawlerLog(`删除失败，请稍后重试`, 'error');
        }
    } catch (error) {
        addCrawlerLog(`删除失败，请检查网络连接`, 'error');
    }
}
