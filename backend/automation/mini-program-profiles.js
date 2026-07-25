const DEFAULT_SCROLL_PROFILE = {
    profileId: 'default',
    label: '通用列表页',
    contentLeftRatio: 0.24,
    contentRightRatio: 0.9,
    laneRatios: [0.72, 0.6, 0.82, 0.68],
    focusTap: {
        xRatio: 0.74,
        yRatio: 0.58,
        repeat: 1,
        delayMs: 250,
        jitterX: 8,
        jitterY: 8
    },
    backButton: {
        xRatio: 0.08,
        yRatio: 0.07,
        jitterX: 6,
        jitterY: 6,
        delayMs: 800
    },
    initialTaps: [],
    perScrollTaps: [],
    startYRatio: 0.82,
    endYRatio: 0.28,
    startYJitter: 12,
    endYJitter: 16,
    laneJitter: 16,
    dragStepsBase: 22,
    dragStepsVariance: 4,
    citySearch: {
        enabled: false,
        settleMs: 1200,
        steps: []
    },
    detailProbe: {
        enabled: false,
        batchScrollCount: 4,
        openDelayMs: 1300,
        returnDelayMs: 900
    },
    dismissActions: [
        { type: 'tap', states: ['marketing', 'popup'], xRatio: 0.84, yRatio: 0.34, delayMs: 350, label: 'close-popup-top-right', jitterX: 8, jitterY: 8 },
        { type: 'tap', states: ['marketing', 'station-detail'], xRatio: 0.08, yRatio: 0.07, delayMs: 650, label: 'close-page-back', jitterX: 6, jitterY: 6 },
        { type: 'commandBack', states: ['marketing', 'station-detail', 'popup'], delayMs: 650, label: 'close-page-command-back' },
        { type: 'keyCode', keyCode: 53, states: ['marketing', 'popup'], delayMs: 450, label: 'close-page-escape' },
        { type: 'tap', states: ['login-prompt', 'popup'], xRatio: 0.5, yRatio: 0.62, delayMs: 450, label: 'close-popup-primary', jitterX: 18, jitterY: 10 },
        { type: 'tap', states: ['login-prompt'], xRatio: 0.5, yRatio: 0.82, delayMs: 450, label: 'close-login-later-bottom', jitterX: 24, jitterY: 10 },
        { type: 'tap', states: ['login-prompt'], xRatio: 0.08, yRatio: 0.07, delayMs: 650, label: 'close-login-back', jitterX: 6, jitterY: 6 },
        { type: 'tap', states: ['location-home', 'popup'], xRatio: 0.5, yRatio: 0.72, delayMs: 450, label: 'close-popup-secondary', jitterX: 18, jitterY: 10 }
    ]
};

function buildCommonCitySteps(overrides = {}) {
    const steps = [
        { type: 'tap', xRatio: 0.16, yRatio: 0.1, delayMs: 1200, label: 'open-city-entry' },
        { type: 'tap', xRatio: 0.52, yRatio: 0.15, delayMs: 250, label: 'focus-city-search' },
        { type: 'selectAll', delayMs: 100 },
        { type: 'keyCode', keyCode: 51, repeat: 1, delayMs: 120 },
        { type: 'pasteText', valueFrom: 'cityName', delayMs: 650 },
        { type: 'tap', xRatio: 0.5, yRatio: 0.28, delayMs: 1500, label: 'pick-first-city' }
    ];

    Object.entries(overrides).forEach(([index, partial]) => {
        const targetIndex = Number(index);
        if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= steps.length) {
            return;
        }

        steps[targetIndex] = {
            ...steps[targetIndex],
            ...partial
        };
    });

    return steps;
}

const MINI_PROGRAM_PROFILES = {
    'didi-charging': {
        profileId: 'didi-charging',
        label: '滴滴充电列表模板',
        contentLeftRatio: 0.28,
        contentRightRatio: 0.89,
        laneRatios: [0.56, 0.68, 0.8],
        // 滴滴列表卡片容易误触进详情，默认不做聚焦点击，只执行滑动。
        focusTap: null,
        initialTaps: [],
        perScrollTaps: [],
        inputMode: 'wheel',
        wheelDeltaY: -680,
        wheelRepeat: 4,
        startYRatio: 0.58,
        endYRatio: 0.24,
        startYJitter: 8,
        endYJitter: 10,
        citySearch: {
            enabled: true,
            settleMs: 1400,
            steps: buildCommonCitySteps({
                0: { xRatio: 0.5, yRatio: 0.1, label: 'open-didi-search-entry' },
                1: { xRatio: 0.52, yRatio: 0.15, label: 'focus-didi-search-box' },
                5: { xRatio: 0.42, yRatio: 0.28, label: 'pick-didi-first-result' }
            })
        },
        detailProbe: {
            enabled: false  // 禁用详情探测，避免跳转
        },
        dismissActions: [
            { type: 'tap', states: ['login-prompt'], xRatio: 0.5, yRatio: 0.62, delayMs: 600, label: 'dismiss-login-later', jitterX: 30, jitterY: 12 },
            { type: 'tap', states: ['login-prompt'], xRatio: 0.5, yRatio: 0.82, delayMs: 650, label: 'dismiss-login-bottom-later', jitterX: 30, jitterY: 12 },
            { type: 'tap', states: ['login-prompt'], xRatio: 0.08, yRatio: 0.07, delayMs: 800, label: 'dismiss-login-back', jitterX: 8, jitterY: 8 },
            { type: 'tap', states: ['login-prompt'], xRatio: 0.88, yRatio: 0.12, delayMs: 600, label: 'dismiss-login-close', jitterX: 10, jitterY: 10 },
            { type: 'tap', states: ['marketing', 'popup'], xRatio: 0.92, yRatio: 0.1, delayMs: 550, label: 'dismiss-page-top-right-close', jitterX: 10, jitterY: 10 },
            { type: 'tap', states: ['marketing', 'popup'], xRatio: 0.86, yRatio: 0.34, delayMs: 450, label: 'dismiss-popup-close', jitterX: 10, jitterY: 10 },
            { type: 'tap', states: ['marketing', 'station-detail'], xRatio: 0.08, yRatio: 0.07, delayMs: 800, label: 'dismiss-page-back', jitterX: 8, jitterY: 8 },
            { type: 'commandBack', states: ['marketing', 'station-detail', 'popup'], delayMs: 650, label: 'dismiss-command-back' },
            { type: 'keyCode', keyCode: 53, states: ['marketing', 'popup'], delayMs: 450, label: 'dismiss-escape' },
            { type: 'tap', states: ['location-home', 'popup'], xRatio: 0.5, yRatio: 0.72, delayMs: 450, label: 'dismiss-popup-cancel', jitterX: 24, jitterY: 10 }
        ]
    },
    teld: {
        profileId: 'teld',
        label: '特来电列表模板',
        contentLeftRatio: 0.26,
        contentRightRatio: 0.9,
        laneRatios: [0.58, 0.7, 0.82],
        focusTap: { xRatio: 0.68, yRatio: 0.62, repeat: 2, delayMs: 180, jitterX: 12, jitterY: 10 },
        initialTaps: [
            { type: 'tap', xRatio: 0.68, yRatio: 0.62, delayMs: 240, label: 'focus-station-list' }
        ],
        perScrollTaps: [
            { every: 3, xRatio: 0.7, yRatio: 0.64, delayMs: 100, label: 'dismiss-overlay' }
        ],
        startYRatio: 0.83,
        endYRatio: 0.29,
        citySearch: {
            enabled: true,
            settleMs: 1200,
            steps: buildCommonCitySteps({
                0: { xRatio: 0.14, yRatio: 0.1 },
                1: { xRatio: 0.5, yRatio: 0.145 },
                5: { xRatio: 0.5, yRatio: 0.255 }
            })
        },
        dismissActions: [
            { type: 'tap', states: ['marketing', 'popup'], xRatio: 0.84, yRatio: 0.33, delayMs: 450, label: 'dismiss-teld-ad', jitterX: 10, jitterY: 10 },
            { type: 'tap', states: ['location-home', 'popup'], xRatio: 0.5, yRatio: 0.72, delayMs: 450, label: 'dismiss-teld-popup', jitterX: 22, jitterY: 10 }
        ]
    },
    'star-charge': {
        profileId: 'star-charge',
        label: '星星充电列表模板',
        contentLeftRatio: 0.24,
        contentRightRatio: 0.88,
        laneRatios: [0.54, 0.66, 0.78],
        focusTap: { xRatio: 0.62, yRatio: 0.61, repeat: 2, delayMs: 180, jitterX: 10, jitterY: 10 },
        initialTaps: [
            { type: 'tap', xRatio: 0.62, yRatio: 0.61, delayMs: 220, label: 'focus-station-list' }
        ],
        perScrollTaps: [
            { every: 2, xRatio: 0.62, yRatio: 0.64, delayMs: 80, label: 'recover-scroll-area' }
        ],
        startYRatio: 0.84,
        endYRatio: 0.3,
        citySearch: {
            enabled: true,
            settleMs: 1200,
            steps: buildCommonCitySteps({
                0: { xRatio: 0.16, yRatio: 0.11 },
                1: { xRatio: 0.52, yRatio: 0.15 },
                5: { xRatio: 0.5, yRatio: 0.31 }
            })
        },
        dismissActions: [
            { type: 'tap', states: ['location-home', 'popup'], xRatio: 0.5, yRatio: 0.62, delayMs: 500, label: 'dismiss-location-auth', jitterX: 28, jitterY: 10 },
            { type: 'tap', states: ['marketing', 'popup'], xRatio: 0.85, yRatio: 0.34, delayMs: 450, label: 'dismiss-star-popup', jitterX: 10, jitterY: 10 }
        ]
    },
    ykc: {
        profileId: 'ykc',
        label: '云快充列表模板',
        contentLeftRatio: 0.23,
        contentRightRatio: 0.89,
        laneRatios: [0.56, 0.68, 0.8],
        focusTap: { xRatio: 0.64, yRatio: 0.62, repeat: 2, delayMs: 180, jitterX: 12, jitterY: 12 },
        initialTaps: [
            { type: 'tap', xRatio: 0.64, yRatio: 0.62, delayMs: 200, label: 'focus-station-list' }
        ],
        perScrollTaps: [
            { every: 2, xRatio: 0.64, yRatio: 0.64, delayMs: 100, label: 'recover-scroll-area' }
        ],
        startYRatio: 0.84,
        endYRatio: 0.29,
        citySearch: {
            enabled: true,
            settleMs: 1000,
            steps: buildCommonCitySteps({
                0: { xRatio: 0.16, yRatio: 0.1 },
                1: { xRatio: 0.5, yRatio: 0.15 },
                5: { xRatio: 0.5, yRatio: 0.28 }
            })
        }
    },
    tuanyou: {
        profileId: 'tuanyou',
        label: '团油油站列表模板',
        contentLeftRatio: 0.22,
        contentRightRatio: 0.86,
        laneRatios: [0.52, 0.64, 0.76],
        focusTap: { xRatio: 0.58, yRatio: 0.65, repeat: 2, delayMs: 200, jitterX: 10, jitterY: 12 },
        initialTaps: [
            { type: 'tap', xRatio: 0.58, yRatio: 0.65, delayMs: 220, label: 'focus-station-list' }
        ],
        perScrollTaps: [
            { every: 2, xRatio: 0.58, yRatio: 0.66, delayMs: 120, label: 'recover-list-focus' }
        ],
        startYRatio: 0.85,
        endYRatio: 0.32,
        citySearch: {
            enabled: true,
            settleMs: 1300,
            steps: buildCommonCitySteps({
                0: { xRatio: 0.13, yRatio: 0.105 },
                1: { xRatio: 0.5, yRatio: 0.152 },
                5: { xRatio: 0.5, yRatio: 0.3 }
            })
        }
    },
    kuaidian: {
        profileId: 'kuaidian',
        label: '快电列表模板',
        contentLeftRatio: 0.25,
        contentRightRatio: 0.88,
        laneRatios: [0.55, 0.67, 0.79],
        focusTap: { xRatio: 0.63, yRatio: 0.63, repeat: 2, delayMs: 180, jitterX: 10, jitterY: 10 },
        initialTaps: [
            { type: 'tap', xRatio: 0.63, yRatio: 0.63, delayMs: 220, label: 'focus-station-list' }
        ],
        perScrollTaps: [
            { every: 2, xRatio: 0.63, yRatio: 0.65, delayMs: 80, label: 'recover-scroll-area' }
        ],
        startYRatio: 0.84,
        endYRatio: 0.3,
        citySearch: {
            enabled: true,
            settleMs: 1100,
            steps: buildCommonCitySteps({
                0: { xRatio: 0.16, yRatio: 0.105 },
                1: { xRatio: 0.52, yRatio: 0.15 },
                5: { xRatio: 0.5, yRatio: 0.29 }
            })
        }
    }
};

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeProfile(base, override) {
    if (Array.isArray(base) && Array.isArray(override)) {
        return override.map(item => (isObject(item) ? mergeProfile({}, item) : item));
    }

    if (!isObject(base) || !isObject(override)) {
        return override === undefined ? base : override;
    }

    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
        const baseValue = result[key];
        if (Array.isArray(value)) {
            result[key] = value.map(item => (isObject(item) ? mergeProfile({}, item) : item));
        } else if (isObject(value) && isObject(baseValue)) {
            result[key] = mergeProfile(baseValue, value);
        } else if (isObject(value)) {
            result[key] = mergeProfile({}, value);
        } else if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

function resolveMiniProgramProfile(miniProgram = {}) {
    const profileId = String(
        miniProgram.automationProfileId
        || miniProgram.scrollProfileId
        || miniProgram.id
        || DEFAULT_SCROLL_PROFILE.profileId
    ).trim();
    const platformProfile = MINI_PROGRAM_PROFILES[profileId] || {};
    const customProfile = isObject(miniProgram.scrollProfile) ? miniProgram.scrollProfile : {};

    return mergeProfile(
        DEFAULT_SCROLL_PROFILE,
        mergeProfile(platformProfile, customProfile)
    );
}

module.exports = {
    DEFAULT_SCROLL_PROFILE,
    MINI_PROGRAM_PROFILES,
    resolveMiniProgramProfile
};
