(function attachWorkflowStatusControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Workflow status dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const formatUserReason = requireDependency(deps, 'formatUserReason');
        const setElementText = requireDependency(deps, 'setElementText');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');
        const requestRecordEngineKey = deps.requestRecordEngineKey || 'mitmdump';

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function firstTextValue(...values) {
            for (const value of values) {
                if (Array.isArray(value)) {
                    const list = value.map(item => String(item || '').trim()).filter(Boolean);
                    if (list.length) return list.join('、');
                    continue;
                }
                const text = String(value ?? '').trim();
                if (text) return text;
            }
            return '';
        }

        function formatRuntimeCheck(check = {}) {
            if (!check || typeof check !== 'object') return '未检测';
            const statusMap = {
                ready: '可用',
                running: '运行中',
                configured: '已配置',
                unknown: '未知',
                unavailable: '不可用',
                failed: '失败'
            };
            const status = statusMap[check.status] || (check.available === true ? '可用' : check.available === false ? '不可用' : '未知');
            return check.reason ? `${status} / ${formatUserReason(check.reason, { includeTech: false })}` : status;
        }

        function normalizeWorkflowReason(value) {
            if (!value) return '';
            if (typeof value === 'string') return formatUserReason(value, { includeTech: false });
            if (typeof value === 'object') {
                return firstTextValue(value.message, value.label, value.reason, value.code);
            }
            return String(value);
        }

        function normalizeStatusPayload(payload = {}) {
            if (payload?.data && typeof payload.data === 'object') {
                const data = payload.data;
                if (data.workflow || data.checks || Object.prototype.hasOwnProperty.call(data, 'available') || data.reason) {
                    return { ...payload, ...data, success: data.success ?? payload.success };
                }
            }
            return payload || {};
        }

        function buildWorkflowSteps(defaultSteps = [], workflow = {}, activeIndex = 0, blocked = false) {
            const rawSteps = Array.isArray(workflow.steps) ? workflow.steps : [];
            if (rawSteps.length) {
                return rawSteps.map((step, index) => {
                    const status = step.status || step.state || (index < activeIndex ? 'done' : index === activeIndex ? (blocked ? 'blocked' : 'active') : 'pending');
                    return {
                        label: step.label || step.name || defaultSteps[index]?.label || `步骤 ${index + 1}`,
                        hint: normalizeWorkflowReason(step.hint || step.summary || step.reason || defaultSteps[index]?.hint || ''),
                        status
                    };
                });
            }
            return defaultSteps.map((step, index) => ({
                ...step,
                status: index < activeIndex ? 'done' : index === activeIndex ? (blocked ? 'blocked' : 'active') : 'pending'
            }));
        }

        function renderWorkflowPanel(prefix, view = {}) {
            const statusEl = byId(`${prefix}WorkflowStatus`);
            const stepsEl = byId(`${prefix}WorkflowSteps`);
            const readinessEl = byId(`${prefix}WorkflowReadiness`);
            const nextActionEl = byId(`${prefix}WorkflowNextAction`);
            const blockingEl = byId(`${prefix}WorkflowBlockingReason`);
            if (!statusEl || !stepsEl) return;

            const tone = view.tone || 'warn';
            statusEl.className = `workflow-status ${tone}`;
            statusEl.textContent = view.statusLabel || '等待检测';
            stepsEl.innerHTML = (view.steps || []).map(step => `
                <div class="workflow-step ${escapeHtml(step.status || '')}">
                    <strong>${escapeHtml(step.label || '-')}</strong>
                    <span>${escapeHtml(step.hint || '')}</span>
                </div>
            `).join('');
            if (readinessEl) readinessEl.textContent = view.readiness || '等待检查';
            if (nextActionEl) nextActionEl.textContent = view.nextAction || '按当前按钮继续';
            if (blockingEl) blockingEl.textContent = view.blockingReason || '暂无';
        }

        function getWorkflowActiveIndex(workflow = {}, fallback = 0) {
            const raw = workflow.stage || workflow.phase || workflow.currentStage || workflow.currentStep;
            const stage = String(raw || '').toLowerCase();
            const indexMap = {
                prepare: 0,
                readiness: 0,
                check: 0,
                environment: 0,
                execute: 1,
                running: 1,
                capture: 1,
                record: 1,
                recording: 1,
                operate: 2,
                manual: 2,
                evidence: 2,
                analyze: 3,
                analysis: 3,
                next: 3,
                done: 3,
                complete: 3,
                completed: 3
            };
            return Number.isInteger(indexMap[stage]) ? indexMap[stage] : fallback;
        }

        function derivePageCollectionWorkflowView(result = {}) {
            const workflow = result.workflow || result;
            const available = Boolean(workflow.available ?? result.available);
            const success = Boolean(workflow.success ?? result.success);
            const reason = workflow.reason || result.reason || workflow.blockingReason || result.blockingReason;
            const blockingReason = normalizeWorkflowReason(workflow.blockingReason || result.blockingReason || (!available ? reason : ''));
            const nextAction = firstTextValue(
                workflow.nextAction?.label,
                workflow.nextAction?.message,
                workflow.nextAction,
                result.nextAction?.label,
                result.nextAction?.message,
                available ? '执行快速验证、识别当前页面或智能浏览验证' : '按阻塞原因处理后重新检查页面环境'
            );
            const readiness = firstTextValue(
                workflow.readiness?.label,
                workflow.readiness?.message,
                workflow.readiness,
                available ? '页面采集环境已准备好' : normalizeWorkflowReason(reason || 'unknown_error')
            );
            const activeIndex = getWorkflowActiveIndex(workflow, available ? 1 : 0);
            const steps = buildWorkflowSteps([
                { label: '准备', hint: '确认微信、小程序窗口、截图和页面识别能力' },
                { label: '执行', hint: '打开小程序、识别页面、下滑或智能浏览' },
                { label: '证据', hint: '保留操作前后截图、页面识别结果和执行过程' },
                { label: '下一步', hint: '按页面状态继续验证或处理阻塞' }
            ], workflow, activeIndex, Boolean(blockingReason));
            return {
                statusLabel: available ? (success ? '已准备' : '可执行') : '存在阻塞',
                tone: available ? 'ready' : (blockingReason ? 'blocked' : 'warn'),
                readiness,
                nextAction,
                blockingReason: blockingReason || '暂无',
                steps
            };
        }

        function deriveRequestCollectionWorkflowView(result = {}) {
            const workflow = result.workflow || result;
            const available = Boolean(workflow.available ?? result.available);
            const recorder = workflow.checks?.recorder || result.checks?.recorder || result.recorder || {};
            const recorderRunning = recorder.status === 'running' || Boolean(workflow.activeSession || result.activeSession || result.session?.active);
            const reason = workflow.reason || result.reason || workflow.blockingReason || result.blockingReason;
            const blockingReason = normalizeWorkflowReason(workflow.blockingReason || result.blockingReason || (!available && !recorderRunning ? reason : ''));
            const nextAction = firstTextValue(
                workflow.nextAction?.label,
                workflow.nextAction?.message,
                workflow.nextAction,
                result.nextAction?.label,
                result.nextAction?.message,
                recorderRunning
                    ? '请在电脑端小程序完成搜索、进入列表、打开详情页；完成后点击“停止并生成摘要”'
                    : available
                        ? '点击“开始请求采集”，随后手动操作电脑端小程序；也可以直接点击“自动采集并入库”'
                        : '先检查请求采集环境，按当前阻塞处理网络出口、证书或记录服务'
            );
            const readiness = firstTextValue(
                workflow.readiness?.label,
                workflow.readiness?.message,
                workflow.readiness,
                recorderRunning ? '请求采集进行中，等待用户操作小程序' : available ? '请求采集环境已准备好' : normalizeWorkflowReason(reason || 'unknown_error')
            );
            const activeIndex = recorderRunning ? 2 : getWorkflowActiveIndex(workflow, available ? 1 : 0);
            const steps = buildWorkflowSteps([
                { label: '检查环境', hint: '确认记录服务、网络出口、证书和保存目录' },
                { label: '开始采集', hint: '启动授权范围内的小程序请求记录' },
                { label: '用户操作', hint: '在电脑端小程序完成搜索、列表、详情操作' },
                { label: '完成分析', hint: '停止记录并生成脱敏业务摘要' }
            ], workflow, activeIndex, Boolean(blockingReason));
            return {
                statusLabel: recorderRunning ? '等待操作' : available ? '可开始采集' : '存在阻塞',
                tone: recorderRunning ? 'running' : available ? 'ready' : (blockingReason ? 'blocked' : 'warn'),
                readiness,
                nextAction,
                blockingReason: blockingReason || '暂无',
                steps
            };
        }

        function renderRequestCollectionStatus(result = {}) {
            const status = normalizeStatusPayload(result);
            const checks = status.checks || {};
            setElementText('method2MitmdumpStatus', formatRuntimeCheck(checks[requestRecordEngineKey] || status[requestRecordEngineKey]));
            setElementText('method2RecorderStatus', formatRuntimeCheck(checks.recorder || status.recorder));
            setElementText('method2ProxyStatus', formatRuntimeCheck(checks.proxy || status.proxy));
            setElementText('method2HarStatus', formatRuntimeCheck(checks.harOutput || status.harOutput));
            renderWorkflowPanel('method2', deriveRequestCollectionWorkflowView(status));
            const banner = byId('method2ReasonBanner');
            if (banner) {
                const tone = status.available ? 'success' : 'warn';
                setStatusBannerState(banner, `请求采集状态：${formatUserReason(status.reason || 'unknown_error', { includeTech: false })}`, tone);
            }
        }

        function renderAccessValidationStatus(result = {}) {
            const checks = result.checks || {};
            setElementText('method3TemplateStatus', formatRuntimeCheck(checks.templates));
            setElementText('method3CorpusStatus', formatRuntimeCheck(checks.corpus));
            setElementText('method3ProxyStatus', formatRuntimeCheck(checks.outboundProxy));
            const banner = byId('method3ReasonBanner');
            if (banner) {
                setStatusBannerState(
                    banner,
                    `小规模访问验证状态：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`,
                    result.available ? 'success' : 'warn'
                );
            }
        }

        function formatPageCollectionCheck(check = {}) {
            const status = check.status === 'ready' ? '可用' : '不可用';
            return check.reason ? `${status} / ${formatUserReason(check.reason, { includeTech: false })}` : status;
        }

        function renderPageCollectionResult(result = {}) {
            const status = normalizeStatusPayload(result);
            const checks = status.checks || {};
            setElementText('method1WechatWindowStatus', formatPageCollectionCheck(checks.wechatWindow));
            setElementText('method1TargetWindowStatus', formatPageCollectionCheck(checks.targetWindow));
            setElementText('method1ScreenshotStatus', formatPageCollectionCheck(checks.screenshot));
            setElementText('method1OcrStatus', formatPageCollectionCheck(checks.ocr));
            setElementText('method1ScrollStatus', status.scroll ? formatPageCollectionCheck(status.scroll) : '未执行');
            renderWorkflowPanel('method1', derivePageCollectionWorkflowView(status));

            const banner = byId('method1ReasonBanner');
            if (banner) {
                const tone = status.available ? 'success' : 'error';
                const message = status.available
                    ? `页面验证可用：${formatUserReason(status.reason || 'ready', { includeTech: false })}`
                    : `页面验证不可用：${formatUserReason(status.reason || 'unknown_error', { includeTech: false })}${status.error ? `；${status.error}` : ''}`;
                setStatusBannerState(banner, message, tone);
            }

            const beforeText = byId('method1BeforeText');
            const afterText = byId('method1AfterText');
            if (beforeText && status.before) {
                beforeText.value = status.before.text || (Array.isArray(status.before.textLines) ? status.before.textLines.join('\n') : '');
            } else if (beforeText && !status.before) {
                beforeText.value = '';
            }
            if (afterText && status.after) {
                afterText.value = status.after.text || (Array.isArray(status.after.textLines) ? status.after.textLines.join('\n') : '');
            } else if (afterText && !status.after) {
                afterText.value = '';
            }
        }

        return {
            buildWorkflowSteps,
            derivePageCollectionWorkflowView,
            deriveRequestCollectionWorkflowView,
            firstTextValue,
            formatPageCollectionCheck,
            formatRuntimeCheck,
            getWorkflowActiveIndex,
            normalizeStatusPayload,
            normalizeWorkflowReason,
            renderAccessValidationStatus,
            renderPageCollectionResult,
            renderRequestCollectionStatus,
            renderWorkflowPanel
        };
    }

    global.WorkflowStatusControl = { createController };
})(window);
