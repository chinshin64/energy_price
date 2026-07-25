'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const VIEWPORTS = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'mobile', width: 390, height: 844 },
];
const PRIMARY_TABS = ['overview', 'capture-center', 'agent-workbench', 'mobile-control', 'settings'];
const REQUIRED_MODELS = ['glm-5.1', 'glm-5.2', 'deepseek-v4-flash', 'deepseek-ve-pro'];

function configureIsolatedRuntime(tempRoot) {
    process.env.PORT = '0';
    process.env.HOST = '127.0.0.1';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_MODE = 'disabled';
    process.env.DATABASE_PATH = path.join(tempRoot, 'frontend-check.db');
    process.env.DATA_ROOT = path.join(tempRoot, 'data');
    process.env.AI_FEATURES_ENABLED = 'false';
    process.env.SYNC_AUTH_REQUIRED = 'false';
    process.env.MOBILE_SYNC_AUTH_REQUIRED = 'false';
}

function browserLaunchOptions() {
    const executablePath = String(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '').trim();
    const channel = String(process.env.PLAYWRIGHT_BROWSER_CHANNEL || '').trim();
    return {
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        ...(!executablePath && channel ? { channel } : {}),
    };
}

async function inspectLayout(page) {
    return page.evaluate(() => {
        const isVisible = element => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const clippedControls = [...document.querySelectorAll('button, select, input, .nav-item, .subnav-item')]
            .filter(isVisible)
            .filter(element => element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2)
            .map(element => ({
                id: element.id || '',
                text: (element.textContent || element.value || '').trim().slice(0, 80),
            }));
        const rect = selector => {
            const box = document.querySelector(selector)?.getBoundingClientRect();
            return box && box.width > 0 && box.height > 0
                ? { top: box.top, right: box.right, bottom: box.bottom, left: box.left }
                : null;
        };
        return {
            scrollY: window.scrollY,
            viewportWidth: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            bodyWidth: document.body.scrollWidth,
            activeSection: document.querySelector('.section.active')?.id || '',
            activePrimaryTab: document.querySelector('.nav-item.active')?.dataset.tab || '',
            topbarCollapseState: document.querySelector('.topbar')?.dataset.collapsed,
            legacyAiCenterPresent: Boolean(document.querySelector('#ai-center')),
            legacyMobileAuthCopyPresent: document.body.innerText.includes(['已关闭', '访问凭证校验'].join('')),
            epochPlaceholderPresent: document.body.innerText.includes('1970/1/1'),
            clippedControls,
            navigationControllerLoaded: Boolean(window.NavigationControl?.createController),
            userReasonControllerLoaded: Boolean(window.UserReasonControl?.createFormatter),
            platformSelectionControllerLoaded: Boolean(window.PlatformSelectionControl?.createController),
            scheduleControllerLoaded: Boolean(window.ScheduleControl?.createController),
            templateApiProgressControllerLoaded: Boolean(window.TemplateApiProgressControl?.createController),
            coordinateCrawlControllerLoaded: Boolean(window.CoordinateCrawlControl?.createController),
            workflowStatusControllerLoaded: Boolean(window.WorkflowStatusControl?.createController),
            collectionFlowControllerLoaded: Boolean(window.CollectionFlowControl?.createController),
            collectionResultControllerLoaded: Boolean(window.CollectionResultControl?.createController),
            collectionSessionControllerLoaded: Boolean(window.CollectionSessionControl?.createController),
            pageCollectionControllerLoaded: Boolean(window.PageCollectionControl?.createController),
            pageOcrControllerLoaded: Boolean(window.PageOcrControl?.createController),
            requestCollectionControllerLoaded: Boolean(window.RequestCollectionControl?.createController),
            smartCollectionControllerLoaded: Boolean(window.SmartCollectionControl?.createController),
            method1RefreshButton: rect('#method1RefreshStatus'),
            method1RunButton: rect('#method1RunBasicCheck'),
            pageOcrPreflightButton: rect('#preflightPageOcrCollect'),
            pageOcrStartButton: rect('#startPageOcrCollect'),
            method2RefreshButton: rect('#method2RefreshStatus'),
            method2StartButton: rect('#method2StartCapture'),
            cityLocationControllerLoaded: Boolean(window.CityLocationControl?.createController),
            networkSettingsControllerLoaded: Boolean(window.NetworkSettingsControl?.createController),
            harUploadControllerLoaded: Boolean(window.HarUploadControl?.createController),
            stationPresentationControllerLoaded: Boolean(window.StationPresentationControl?.createController),
            dataDashboardControllerLoaded: Boolean(window.DataDashboardControl?.createController),
            crawlerRunQuotaControllerLoaded: Boolean(window.CrawlerRunQuotaControl?.createController),
            accessValidationControllerLoaded: Boolean(window.AccessValidationControl?.createController),
            crawlerRunLimitInput: rect('#crawlerRunLimitInput'),
            crawlerRunQuotaStats: rect('#crawlerRunQuotaStats'),
            method3PreflightButton: rect('#method3Preflight'),
            method3RunButton: rect('#method3RunBasic'),
            captureEvidenceControllerLoaded: Boolean(window.CaptureEvidenceControl?.createController),
            captureRecorderControllerLoaded: Boolean(window.CaptureRecorderControl?.createController),
            securityReportControllerLoaded: Boolean(window.SecurityReportControl?.createController),
            ocrQualityControllerLoaded: Boolean(window.OcrQualityControl?.createController),
            selfHealSettingsControllerLoaded: Boolean(window.SelfHealSettingsControl?.createController),
            selfHealOperationsControllerLoaded: Boolean(window.SelfHealOperationsControl?.createController),
            aiAgentDashboardControllerLoaded: Boolean(window.AiAgentDashboardControl?.createController),
            aiAgentSettingsControllerLoaded: Boolean(window.AiAgentSettingsControl?.createController),
            agentHeader: rect('.agent-desktop-header'),
            agentComposer: rect('.agent-desktop-composer'),
            agentWorkbenchControllerLoaded: Boolean(window.AgentWorkbenchControl?.createController),
            mobileMockMap: rect('#mobileMockMap'),
            mobileMockLat: rect('#mobileMockLat'),
            mobileMockLng: rect('#mobileMockLng'),
            mobileMockApply: rect('#applyMobileMockLocationBtn'),
            mobileMockControllerLoaded: Boolean(window.MobileMockLocationControl?.createController),
            mobileControlBoardLoaded: Boolean(window.MobileControlBoard?.createController),
            mobileIntentChatControllerLoaded: Boolean(window.MobileIntentChatControl?.createController),
            syncNodeControllerLoaded: Boolean(window.SyncNodeControl?.createController),
            operationsGovernanceControllerLoaded: Boolean(window.OperationsGovernanceControl?.createController),
            ocrQualityStatus: rect('#ocrQualityStatus'),
            ocrReviewTable: rect('#ocrReviewTableBody'),
            syncNodeStatus: rect('#syncNodeStatus'),
            syncNodeTable: rect('#syncNodeTableBody'),
            platformHealthStatus: rect('#platformHealthStatus'),
            platformHealthTable: rect('#platformHealthTableBody'),
            auditEventStatus: rect('#auditEventStatus'),
            auditEventTable: rect('#auditEventTableBody'),
            selfHealStatus: rect('#selfHealStatus'),
            selfHealScenario: rect('#selfHealScenario'),
            selfHealSaveButton: rect('#saveSelfHealSettingsBtn'),
        };
    });
}

function collectLayoutFailures(viewport, tab, layout) {
    const failures = [];
    if (layout.activeSection !== tab || layout.activePrimaryTab !== tab) {
        failures.push(`active route mismatch: expected ${tab}, got ${layout.activeSection}/${layout.activePrimaryTab}`);
    }
    if (layout.documentWidth > viewport.width + 1 || layout.bodyWidth > viewport.width + 1) {
        failures.push(`horizontal overflow: document=${layout.documentWidth}, body=${layout.bodyWidth}`);
    }
    if (layout.clippedControls.length > 0) {
        failures.push(`clipped controls: ${JSON.stringify(layout.clippedControls)}`);
    }
    if (layout.legacyAiCenterPresent) {
        failures.push('legacy ai-center section is still present');
    }
    if (layout.legacyMobileAuthCopyPresent) {
        failures.push('legacy mobile auth-disabled copy is still present');
    }
    if (layout.epochPlaceholderPresent) {
        failures.push('empty timestamps are rendered as Unix epoch');
    }
    if (!layout.navigationControllerLoaded) {
        failures.push('navigation controller script is not loaded');
    }
    if (!['true', 'false'].includes(layout.topbarCollapseState)) {
        failures.push(`topbar auto-collapse state was not initialized: ${layout.topbarCollapseState}`);
    }
    if (!layout.userReasonControllerLoaded) {
        failures.push('user reason controller script is not loaded');
    }
    if (!layout.platformSelectionControllerLoaded) {
        failures.push('platform selection controller script is not loaded');
    }
    if (!layout.scheduleControllerLoaded) {
        failures.push('schedule controller script is not loaded');
    }
    if (!layout.templateApiProgressControllerLoaded) {
        failures.push('template API progress controller script is not loaded');
    }
    if (!layout.coordinateCrawlControllerLoaded) {
        failures.push('coordinate crawl controller script is not loaded');
    }
    if (!layout.cityLocationControllerLoaded) {
        failures.push('city location controller script is not loaded');
    }
    if (!layout.networkSettingsControllerLoaded) {
        failures.push('network settings controller script is not loaded');
    }
    if (!layout.harUploadControllerLoaded) {
        failures.push('HAR upload controller script is not loaded');
    }
    if (!layout.stationPresentationControllerLoaded) {
        failures.push('station presentation controller script is not loaded');
    }
    if (!layout.dataDashboardControllerLoaded) {
        failures.push('data dashboard controller script is not loaded');
    }
    if (!layout.captureEvidenceControllerLoaded) {
        failures.push('capture evidence controller script is not loaded');
    }
    if (!layout.captureRecorderControllerLoaded) {
        failures.push('capture recorder controller script is not loaded');
    }
    if (!layout.securityReportControllerLoaded) {
        failures.push('security report controller script is not loaded');
    }
    if (!layout.ocrQualityControllerLoaded) {
        failures.push('OCR quality controller script is not loaded');
    }
    if (!layout.selfHealSettingsControllerLoaded) {
        failures.push('self-heal settings controller script is not loaded');
    }
    if (!layout.selfHealOperationsControllerLoaded) {
        failures.push('self-heal operations controller script is not loaded');
    }
    if (!layout.aiAgentDashboardControllerLoaded) {
        failures.push('AI agent dashboard controller script is not loaded');
    }
    if (!layout.aiAgentSettingsControllerLoaded) {
        failures.push('AI agent settings controller script is not loaded');
    }
    if (!layout.syncNodeControllerLoaded) {
        failures.push('sync node controller script is not loaded');
    }
    if (!layout.operationsGovernanceControllerLoaded) {
        failures.push('operations governance controller script is not loaded');
    }
    if (!layout.workflowStatusControllerLoaded) {
        failures.push('workflow status controller script is not loaded');
    }
    if (!layout.collectionFlowControllerLoaded) {
        failures.push('collection flow controller script is not loaded');
    }
    if (!layout.collectionResultControllerLoaded) {
        failures.push('collection result controller script is not loaded');
    }
    if (!layout.collectionSessionControllerLoaded) {
        failures.push('collection session controller script is not loaded');
    }
    if (!layout.pageCollectionControllerLoaded) {
        failures.push('page collection controller script is not loaded');
    }
    if (!layout.pageOcrControllerLoaded) {
        failures.push('page OCR controller script is not loaded');
    }
    if (!layout.requestCollectionControllerLoaded) {
        failures.push('request collection controller script is not loaded');
    }
    if (!layout.smartCollectionControllerLoaded) {
        failures.push('smart collection controller script is not loaded');
    }
    if (tab === 'frontend') {
        if (!layout.method1RefreshButton || !layout.method1RunButton) {
            failures.push('method1 page collection controls are not visible');
        }
        if (!layout.pageOcrPreflightButton || !layout.pageOcrStartButton) {
            failures.push('page OCR collection controls are not visible');
        }
    }
    if (tab === 'capture') {
        if (!layout.method2RefreshButton || !layout.method2StartButton) {
            failures.push('method2 request collection controls are not visible');
        }
    }
    if (tab === 'agent-workbench') {
        if (layout.scrollY > 1) {
            failures.push(`Agent did not reset document scroll: ${layout.scrollY}px`);
        }
        if (!layout.agentHeader || layout.agentHeader.top < -1 || layout.agentHeader.bottom <= 0) {
            failures.push(`Agent header is outside the viewport: ${JSON.stringify(layout.agentHeader)}`);
        }
        if (!layout.agentWorkbenchControllerLoaded) {
            failures.push('Agent workbench controller script is not loaded');
        }
        if (!layout.agentComposer
            || layout.agentComposer.left < -1
            || layout.agentComposer.right > viewport.width + 1
            || layout.agentComposer.bottom > viewport.height + 1
            || (layout.agentHeader && layout.agentComposer.top < layout.agentHeader.bottom)) {
            failures.push(`Agent composer is outside its usable viewport: ${JSON.stringify(layout.agentComposer)}`);
        }
    }
    if (!layout.crawlerRunQuotaControllerLoaded) {
        failures.push('crawler run quota controller script is not loaded');
    }
    if (!layout.accessValidationControllerLoaded) {
        failures.push('access validation controller script is not loaded');
    }
    if (tab === 'crawler') {
        if (!layout.crawlerRunLimitInput || !layout.crawlerRunQuotaStats) {
            failures.push('crawler run quota controls are not visible');
        }
        if (!layout.method3PreflightButton || !layout.method3RunButton) {
            failures.push('method3 access validation controls are not visible');
        }
    }
    if (tab === 'mobile-control') {
        if (!layout.mobileMockMap) {
            failures.push('mobile mock location map is not visible');
        }
        if (!layout.mobileMockLat || !layout.mobileMockLng || !layout.mobileMockApply) {
            failures.push('mobile mock location controls are not visible');
        }
        if (!layout.mobileMockControllerLoaded) {
            failures.push('mobile mock location controller script is not loaded');
        }
        if (!layout.mobileControlBoardLoaded) {
            failures.push('mobile control board script is not loaded');
        }
        if (!layout.mobileIntentChatControllerLoaded) {
            failures.push('mobile intent chat controller script is not loaded');
        }
        if (!layout.syncNodeStatus || !layout.syncNodeTable) {
            failures.push('sync node controls are not visible');
        }
    }
    if (tab === 'capture-center' && (!layout.ocrQualityStatus || !layout.ocrReviewTable)) {
        failures.push('OCR quality controls are not visible');
    }
    if (tab === 'settings') {
        if (!layout.selfHealStatus || !layout.selfHealScenario || !layout.selfHealSaveButton) {
            failures.push('self-heal settings controls are not visible in system settings');
        }
        if (!layout.platformHealthStatus || !layout.platformHealthTable || !layout.auditEventStatus || !layout.auditEventTable) {
            failures.push('platform health or audit controls are not visible in system settings');
        }
    }
    return failures;
}

async function waitForListening(server) {
    if (server.listening) return;
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
}

async function validateViewport(browser, baseUrl, viewport, screenshotDir) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const runtimeErrors = [];
    page.on('console', message => {
        if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', error => runtimeErrors.push(`page: ${error.message}`));
    page.on('response', response => {
        if (response.status() >= 400) runtimeErrors.push(`http ${response.status()}: ${response.url()}`);
    });

    const failures = [];
    try {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);
        for (const tab of PRIMARY_TABS) {
            if (tab === 'agent-workbench') {
                await page.evaluate(() => window.scrollTo(0, 250));
            }
            await page.locator(`.nav-item[data-tab="${tab}"]`).click();
            await page.waitForTimeout(120);
            const layout = await inspectLayout(page);
            failures.push(...collectLayoutFailures(viewport, tab, layout));
            if (screenshotDir) {
                fs.mkdirSync(screenshotDir, { recursive: true });
                await page.screenshot({
                    path: path.join(screenshotDir, `${tab}-${viewport.name}.png`),
                    fullPage: true,
                });
            }
        }

        await page.locator('.nav-item[data-tab="agent-workbench"]').click();
        await page.waitForTimeout(400);
        const modelIds = await page.locator('#agentWorkbenchModelSelect option')
            .evaluateAll(options => options.map(option => option.value));
        const missingModels = REQUIRED_MODELS.filter(model => !modelIds.includes(model));
        if (missingModels.length > 0) failures.push(`missing models: ${missingModels.join(', ')}`);
        const selectedModel = await page.locator('#agentWorkbenchModelSelect').inputValue();
        if (selectedModel !== '') failures.push(`unconfigured model should remain blank, got: ${selectedModel}`);

        const prompt = page.locator('#agentWorkbenchPrompt');
        const sendButton = page.locator('#agentWorkbenchSendBtn');
        await prompt.fill('检查当前产品状态');
        if (!(await sendButton.isEnabled())) failures.push('send button remains disabled after valid input');
        await prompt.fill('');

        failures.push(...runtimeErrors);
        return { viewport: viewport.name, failures };
    } finally {
        await context.close();
    }
}

async function main() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-team-frontend-check-'));
    configureIsolatedRuntime(tempRoot);
    const { startServer, stopServer } = require('../index');
    const database = require('../database/init');
    const screenshotDir = String(process.env.FRONTEND_QA_SCREENSHOT_DIR || '').trim();
    let browser;
    try {
        const server = startServer();
        await waitForListening(server);
        const address = server.address();
        const baseUrl = `http://127.0.0.1:${address.port}`;
        browser = await chromium.launch(browserLaunchOptions());
        const results = [];
        for (const viewport of VIEWPORTS) {
            results.push(await validateViewport(browser, baseUrl, viewport, screenshotDir));
        }
        const failed = results.filter(result => result.failures.length > 0);
        if (failed.length > 0) {
            console.error(JSON.stringify(failed, null, 2));
            throw new Error(`Frontend browser check failed for ${failed.length} viewport(s)`);
        }
        console.log(`Frontend browser check passed for ${VIEWPORTS.length} viewports and ${PRIMARY_TABS.length} primary routes.`);
    } finally {
        if (browser) await browser.close();
        await stopServer();
        if (database.open) database.close();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
