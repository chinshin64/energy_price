(function attachNavigationControl(global) {
    'use strict';

    const DEFAULT_TOPBAR_EXPAND_BEFORE_Y = 24;
    const DEFAULT_TOPBAR_COLLAPSE_AFTER_Y = 96;
    const DEFAULT_TOPBAR_LAYOUT_SETTLE_MS = 360;

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const windowRef = deps.window || global;
        const validationTabs = new Set(deps.validationTabs || ['overview', 'frontend', 'capture', 'crawler']);
        const primaryTabBySection = deps.primaryTabBySection || {
            overview: 'overview',
            frontend: 'overview',
            capture: 'overview',
            crawler: 'overview',
            'capture-center': 'capture-center',
            'agent-workbench': 'agent-workbench',
            'mobile-control': 'mobile-control',
            settings: 'settings'
        };
        const topbarExpandBeforeY = Number(deps.topbarExpandBeforeY) || DEFAULT_TOPBAR_EXPAND_BEFORE_Y;
        const topbarCollapseAfterY = Number(deps.topbarCollapseAfterY) || DEFAULT_TOPBAR_COLLAPSE_AFTER_Y;
        const topbarLayoutSettleMs = Number(deps.topbarLayoutSettleMs) || DEFAULT_TOPBAR_LAYOUT_SETTLE_MS;
        const refreshOverview = deps.refreshOverview || function noop() {};
        const refreshCaptureCenter = deps.refreshCaptureCenter || function noop() {};
        let keepTopbarCollapsedAfterNavClick = false;
        let topbarCollapsedAfterScroll = false;
        let topbarNavCollapseLockAt = 0;
        let scheduleTopbarAutoCollapseState = null;
        let topbarAutoCollapseInitialized = false;

        function scrollActiveNavIntoView(targetNav) {
            const navList = targetNav?.closest('.top-nav');
            if (!navList) {
                return;
            }

            const navRect = navList.getBoundingClientRect();
            const targetRect = targetNav.getBoundingClientRect();
            let nextScrollLeft = navList.scrollLeft;

            if (targetRect.left < navRect.left) {
                nextScrollLeft -= navRect.left - targetRect.left;
            } else if (targetRect.right > navRect.right) {
                nextScrollLeft += targetRect.right - navRect.right;
            }

            if (Math.round(nextScrollLeft) === Math.round(navList.scrollLeft)) {
                return;
            }

            if (typeof navList.scrollTo === 'function') {
                navList.scrollTo({
                    left: nextScrollLeft,
                    behavior: 'smooth'
                });
            } else {
                navList.scrollLeft = nextScrollLeft;
            }
        }

        function preserveCollapsedTopbarForNavClick() {
            const topbar = documentRef.querySelector('.topbar');
            const isCurrentlyCollapsed = keepTopbarCollapsedAfterNavClick
                || documentRef.body.classList.contains('topbar-collapsed')
                || topbar?.dataset.collapsed === 'true';
            const scrollY = Math.max(0, windowRef.scrollY || windowRef.pageYOffset || 0);
            const shouldKeepCollapsedFromPriorScroll = topbarCollapsedAfterScroll && scrollY <= topbarExpandBeforeY;

            if (!isCurrentlyCollapsed && scrollY <= topbarExpandBeforeY && !shouldKeepCollapsedFromPriorScroll) {
                return;
            }

            keepTopbarCollapsedAfterNavClick = true;
            topbarNavCollapseLockAt = Date.now();
            documentRef.body.classList.add('topbar-collapsed');

            if (topbar) {
                topbar.dataset.collapsed = 'true';
            }

            if (typeof scheduleTopbarAutoCollapseState === 'function') {
                scheduleTopbarAutoCollapseState();
            }
        }

        function resetDocumentScroll() {
            const previousScrollBehavior = documentRef.documentElement.style.scrollBehavior;
            documentRef.documentElement.style.scrollBehavior = 'auto';
            windowRef.scrollTo(0, 0);
            documentRef.body.scrollTop = 0;
            documentRef.documentElement.scrollTop = 0;
            documentRef.scrollingElement?.scrollTo?.(0, 0);
            documentRef.documentElement.style.scrollBehavior = previousScrollBehavior;
        }

        function setActiveTab(targetId, options = {}) {
            const shouldRefreshData = options.refreshData === true;
            const shouldPreserveCollapsedTopbar = options.preserveCollapsedTopbar === true;
            const legacyTarget = targetId === 'data' ? 'overview' : targetId;
            const normalizedTargetId = legacyTarget === 'ai-center' ? 'agent-workbench' : legacyTarget;
            const targetSection = documentRef.getElementById(normalizedTargetId);
            const primaryTabId = primaryTabBySection[normalizedTargetId] || normalizedTargetId;
            const targetNav = documentRef.querySelector(`.nav-item[data-tab="${primaryTabId}"]`);

            if (!targetSection || !targetNav) {
                return;
            }

            if (shouldPreserveCollapsedTopbar) {
                preserveCollapsedTopbarForNavClick();
            }

            documentRef.querySelectorAll('.nav-item').forEach(tab => tab.classList.remove('active'));
            documentRef.querySelectorAll('.subnav-item').forEach(tab => tab.classList.remove('active'));
            documentRef.querySelectorAll('.section').forEach(section => section.classList.remove('active'));

            targetNav.classList.add('active');
            targetSection.classList.add('active');
            documentRef.querySelector(`.subnav-item[data-tab="${normalizedTargetId}"]`)?.classList.add('active');

            const validationSubnav = documentRef.getElementById('validationSubnav');
            validationSubnav?.classList.toggle('is-hidden', !validationTabs.has(normalizedTargetId));
            documentRef.body.classList.toggle('agent-view-active', normalizedTargetId === 'agent-workbench');

            resetDocumentScroll();
            if (normalizedTargetId === 'agent-workbench') {
                windowRef.requestAnimationFrame(resetDocumentScroll);
            }

            scrollActiveNavIntoView(targetNav);

            if (windowRef.location.hash !== `#${normalizedTargetId}`) {
                windowRef.history.replaceState(null, '', `#${normalizedTargetId}`);
            }

            if (shouldRefreshData && normalizedTargetId === 'overview') {
                refreshOverview();
            }
            if (shouldRefreshData && normalizedTargetId === 'capture-center') {
                refreshCaptureCenter();
            }
        }

        function initTabs() {
            documentRef.querySelectorAll('.nav-item, .subnav-item').forEach(tab => {
                tab.addEventListener('click', () => {
                    setActiveTab(tab.dataset.tab, { refreshData: true });
                });
            });

            const initialTab = windowRef.location.hash ? windowRef.location.hash.slice(1) : 'overview';
            setActiveTab(initialTab, { refreshData: false });
        }

        function initTopbarAutoCollapse() {
            if (topbarAutoCollapseInitialized) {
                return;
            }
            const topbar = documentRef.querySelector('.topbar');
            if (!topbar) {
                return;
            }
            topbarAutoCollapseInitialized = true;

            let framePending = false;
            let userTopReturnIntent = false;
            let lastScrollY = Math.max(0, windowRef.scrollY || windowRef.pageYOffset || 0);
            let lastCollapseStateChangeAt = 0;
            let lastTouchY = null;
            let scrollCollapseActive = documentRef.body.classList.contains('topbar-collapsed') || topbar.dataset.collapsed === 'true';

            const getScrollY = () => Math.max(0, windowRef.scrollY || windowRef.pageYOffset || 0);

            const shouldCollapseForScroll = () => {
                const scrollY = getScrollY();
                if (!scrollCollapseActive) {
                    return scrollY >= topbarCollapseAfterY;
                }
                if (scrollY > topbarExpandBeforeY) {
                    return true;
                }
                return !userTopReturnIntent;
            };

            const scheduleApplyState = () => {
                if (framePending) {
                    return;
                }
                framePending = true;
                windowRef.requestAnimationFrame(applyState);
            };

            const releaseNavClickCollapseLock = () => {
                if (!keepTopbarCollapsedAfterNavClick) {
                    scheduleApplyState();
                    return;
                }

                keepTopbarCollapsedAfterNavClick = false;
                topbarCollapsedAfterScroll = false;
                topbarNavCollapseLockAt = 0;
                scrollCollapseActive = false;
                scheduleApplyState();
            };

            const markUserTopReturnIntent = () => {
                userTopReturnIntent = true;
                if (getScrollY() <= topbarExpandBeforeY) {
                    releaseNavClickCollapseLock();
                    return;
                }
                scheduleApplyState();
            };

            const applyState = () => {
                framePending = false;
                const scrollY = getScrollY();
                const isAtTop = scrollY <= topbarExpandBeforeY;

                if (isAtTop && userTopReturnIntent && !keepTopbarCollapsedAfterNavClick) {
                    keepTopbarCollapsedAfterNavClick = false;
                    topbarCollapsedAfterScroll = false;
                    topbarNavCollapseLockAt = 0;
                    scrollCollapseActive = false;
                }

                const wasScrollCollapseActive = scrollCollapseActive;
                const scrollCollapsed = keepTopbarCollapsedAfterNavClick || shouldCollapseForScroll();
                if (scrollCollapsed !== wasScrollCollapseActive) {
                    lastCollapseStateChangeAt = Date.now();
                }
                scrollCollapseActive = scrollCollapsed;

                if (scrollCollapsed && scrollY > topbarExpandBeforeY) {
                    topbarCollapsedAfterScroll = true;
                } else if (!scrollCollapsed && isAtTop) {
                    topbarCollapsedAfterScroll = false;
                }

                documentRef.body.classList.toggle('topbar-collapsed', scrollCollapsed);
                topbar.dataset.collapsed = scrollCollapsed ? 'true' : 'false';

                if (isAtTop && userTopReturnIntent) {
                    userTopReturnIntent = false;
                }
            };

            scheduleTopbarAutoCollapseState = scheduleApplyState;

            windowRef.addEventListener('scroll', () => {
                const scrollY = getScrollY();
                const now = Date.now();
                const canInferUserScrollUp = now - lastCollapseStateChangeAt > topbarLayoutSettleMs
                    && now - topbarNavCollapseLockAt > topbarLayoutSettleMs;

                if (scrollY < lastScrollY && canInferUserScrollUp && !keepTopbarCollapsedAfterNavClick) {
                    userTopReturnIntent = true;
                }

                lastScrollY = scrollY;
                scheduleTopbarAutoCollapseState();
            }, { passive: true });
            windowRef.addEventListener('resize', scheduleTopbarAutoCollapseState, { passive: true });
            windowRef.addEventListener('wheel', event => {
                if (event.deltaY < 0) {
                    markUserTopReturnIntent();
                }
            }, { passive: true });
            windowRef.addEventListener('keydown', event => {
                if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
                    markUserTopReturnIntent();
                }
            });
            windowRef.addEventListener('touchstart', event => {
                lastTouchY = event.touches?.[0]?.clientY ?? null;
            }, { passive: true });
            windowRef.addEventListener('touchmove', event => {
                const nextTouchY = event.touches?.[0]?.clientY ?? null;
                const isPullingDown = lastTouchY !== null
                    && nextTouchY !== null
                    && nextTouchY > lastTouchY;
                lastTouchY = nextTouchY;

                if (isPullingDown) {
                    markUserTopReturnIntent();
                }
            }, { passive: true });

            applyState();
        }

        return {
            initTabs,
            initTopbarAutoCollapse,
            preserveCollapsedTopbarForNavClick,
            resetDocumentScroll,
            scrollActiveNavIntoView,
            setActiveTab
        };
    }

    global.NavigationControl = { createController };
})(window);
