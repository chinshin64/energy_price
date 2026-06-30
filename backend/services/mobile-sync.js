class MobileSyncService {
    constructor(options = {}) {
        this.parsers = options.parsers || {};
        this.defaultParser = options.defaultParser || null;
        this.supportedPlatforms = new Set(options.supportedPlatforms || []);
        this.insertStations = options.insertStations;
    }

    getClientConfig() {
        return {
            supportedPlatforms: Array.from(this.supportedPlatforms),
            endpoints: {
                ocr: '/api/mobile-sync/ocr',
                stations: '/api/mobile-sync/stations',
                supervisor: '/api/mobile-sync/supervisor'
            },
            payloadVersion: 1,
            capabilities: [
                'android-accessibility-scroll',
                'android-mediaprojection-screenshot',
                'mobile-ocr-upload',
                'direct-station-upload',
                'ai-supervised-recovery',
                'test-run-evidence'
            ]
        };
    }

    ingestOcrPayload(payload = {}) {
        const platform = this.normalizePlatform(payload.platform);
        const parser = this.parsers[platform] || this.defaultParser;
        if (!parser || typeof parser.extractStations !== 'function') {
            throw new Error(`未找到手机 OCR 解析器: ${platform}`);
        }

        const ocrRows = this.normalizeOcrRows(payload.ocrRows || payload.rows || payload.textBlocks);
        if (ocrRows.length === 0) {
            throw new Error('ocrRows required');
        }

        const meta = this.buildMeta(payload, platform);
        const stations = parser.extractStations(ocrRows, meta)
            .map(station => this.enrichStation(station, payload, meta))
            .filter(station => station && station.platform);

        const dbResult = stations.length > 0 && typeof this.insertStations === 'function'
            ? this.insertStations(stations)
            : { successCount: 0, skipCount: 0 };

        return {
            platform,
            sessionId: meta.sessionId,
            pageIndex: meta.pageIndex,
            rowCount: ocrRows.length,
            stationCount: stations.length,
            insertedCount: dbResult.successCount || 0,
            skippedCount: dbResult.skipCount || 0,
            stations
        };
    }

    ingestStationPayload(payload = {}) {
        const platform = this.normalizePlatform(payload.platform);
        const rawStations = Array.isArray(payload.stations) ? payload.stations : [];
        if (rawStations.length === 0) {
            throw new Error('stations required');
        }

        const meta = this.buildMeta(payload, platform);
        const stations = rawStations
            .map(station => this.normalizeStation(station, platform, payload, meta))
            .filter(station => station && station.platform);

        const dbResult = stations.length > 0 && typeof this.insertStations === 'function'
            ? this.insertStations(stations)
            : { successCount: 0, skipCount: 0 };

        return {
            platform,
            sessionId: meta.sessionId,
            stationCount: stations.length,
            insertedCount: dbResult.successCount || 0,
            skippedCount: dbResult.skipCount || 0,
            stations
        };
    }

    normalizePlatform(value) {
        const platform = String(value || '').trim();
        if (!platform) {
            throw new Error('platform required');
        }
        if (this.supportedPlatforms.size > 0 && !this.supportedPlatforms.has(platform)) {
            throw new Error(`unsupported platform: ${platform}`);
        }
        return platform;
    }

    buildMeta(payload, platform) {
        return {
            source: 'mobile-ocr',
            sourceType: 'mobile-ocr',
            sourceStage: payload.stage || payload.sourceStage || 'phone-auto-scroll',
            platform,
            sessionId: this.cleanText(payload.sessionId) || this.generateSessionId(payload),
            deviceId: this.cleanText(payload.deviceId) || null,
            appPackage: this.cleanText(payload.appPackage) || null,
            city: this.cleanText(payload.city) || null,
            keyword: this.cleanText(payload.keyword) || null,
            pageIndex: this.toNonNegativeInt(payload.pageIndex, 0),
            scrollIndex: this.toNonNegativeInt(payload.scrollIndex, 0),
            screenshotHash: this.cleanText(payload.screenshotHash) || null,
            capturedAt: payload.capturedAt || new Date().toISOString()
        };
    }

    generateSessionId(payload) {
        const devicePart = this.cleanText(payload.deviceId) || 'phone';
        return `${devicePart}-${Date.now()}`;
    }

    normalizeOcrRows(rows) {
        if (!Array.isArray(rows)) {
            return [];
        }

        return rows
            .map((row, index) => this.normalizeOcrRow(row, index))
            .filter(row => row && row.text);
    }

    normalizeOcrRow(row, index) {
        if (typeof row === 'string') {
            return {
                text: row.trim(),
                confidence: 1,
                boundingBox: { x: 0, y: 0, width: 0, height: 0 },
                index
            };
        }

        if (!row || typeof row !== 'object') {
            return null;
        }

        const box = row.boundingBox || row.bounds || {};
        const x = this.pickNumber(row.x, box.x, box.left, 0);
        const y = this.pickNumber(row.y, box.y, box.top, 0);
        const width = this.pickNumber(row.width, box.width, box.right !== undefined ? Number(box.right) - Number(box.left || 0) : 0);
        const height = this.pickNumber(row.height, box.height, box.bottom !== undefined ? Number(box.bottom) - Number(box.top || 0) : 0);

        return {
            text: this.cleanText(row.text || row.content || row.value),
            confidence: this.pickNumber(row.confidence, row.score, 1),
            x,
            y,
            width,
            height,
            boundingBox: { x, y, width, height },
            index: row.index ?? index
        };
    }

    normalizeStation(station, platform, payload, meta) {
        if (!station || typeof station !== 'object') {
            return null;
        }

        const normalized = {
            ...station,
            platform: station.platform || platform,
            stationId: station.stationId || station.station_id || null,
            stationName: station.stationName || station.station_name || station.name || null,
            address: station.address || station.addr || null,
            latitude: this.pickNullableNumber(station.latitude, station.lat),
            longitude: this.pickNullableNumber(station.longitude, station.lng, station.lon),
            sourceType: station.sourceType || 'mobile-ocr',
            sourceStage: station.sourceStage || meta.sourceStage,
            snapshotAt: station.snapshotAt || station.snapshot_at || station.capturedAt || meta.capturedAt,
            collectedAt: station.collectedAt || station.collected_at || station.capturedAt || meta.capturedAt,
            snapshotMode: station.snapshotMode || 'append',
            raw: {
                ...(station.raw || {}),
                snapshotMode: station.snapshotMode || 'append',
                mobileSync: {
                    meta,
                    originalStation: station,
                    clientVersion: payload.clientVersion || null
                }
            }
        };

        if (this.isTargetCityMismatch(normalized, meta)) {
            return null;
        }

        return normalized;
    }

    enrichStation(station, payload, meta) {
        const normalized = this.normalizeStation(station, station.platform || meta.platform, payload, meta);
        if (!normalized) {
            return null;
        }

        normalized.sourceType = 'mobile-ocr';
        normalized.sourceStage = meta.sourceStage;
        normalized.snapshotAt = station.snapshotAt || station.snapshot_at || station.capturedAt || meta.capturedAt;
        normalized.collectedAt = station.collectedAt || station.collected_at || station.capturedAt || meta.capturedAt;
        normalized.snapshotMode = station.snapshotMode || 'append';
        normalized.raw = {
            ...(station.raw || {}),
            snapshotMode: station.snapshotMode || 'append',
            mobileSync: {
                meta,
                clientVersion: payload.clientVersion || null
            }
        };
        return normalized;
    }

    cleanText(value) {
        return String(value || '').trim();
    }

    pickNumber(...values) {
        for (const value of values) {
            const number = Number(value);
            if (Number.isFinite(number)) {
                return number;
            }
        }
        return 0;
    }

    pickNullableNumber(...values) {
        for (const value of values) {
            if (value === null || value === undefined || value === '') {
                continue;
            }
            const number = Number(value);
            if (Number.isFinite(number)) {
                return number;
            }
        }
        return null;
    }

    toNonNegativeInt(value, fallback = 0) {
        const number = Math.floor(Number(value));
        return Number.isFinite(number) && number >= 0 ? number : fallback;
    }

    isTargetCityMismatch(station, meta = {}) {
        const targetCity = this.normalizeLocationToken(meta.city);
        if (!targetCity) {
            return false;
        }

        const rawOcrTexts = Array.isArray(station.raw?.ocrTexts) ? station.raw.ocrTexts : [];
        const rawOcrRows = Array.isArray(station.raw?.ocrRows) ? station.raw.ocrRows : [];
        const text = [
            station.stationName,
            station.address,
            ...rawOcrTexts,
            ...rawOcrRows.map(row => row?.text)
        ].filter(Boolean).join(' ').replace(/\s+/g, '');
        if (!text) {
            return false;
        }

        const targetTokens = new Set([targetCity, ...(CITY_PROVINCE_MAP[targetCity] || [])]);
        const detected = this.detectKnownLocationTokens(text);
        if (detected.length === 0) {
            return false;
        }
        return detected.some(token => !targetTokens.has(token));
    }

    detectKnownLocationTokens(text) {
        const result = [];
        for (const [canonical, aliases] of Object.entries(CITY_LOCATION_ALIASES)) {
            if (aliases.some(alias => text.includes(alias))) {
                result.push(canonical);
            }
        }
        for (const token of KNOWN_LOCATION_TOKENS) {
            if (token.length <= 2 && !text.includes(`${token}省`) && !text.includes(`${token}市`)) {
                continue;
            }
            if (token.length > 2 && !text.includes(`${token}市`)) {
                continue;
            }
            if (text.includes(token)) {
                result.push(token);
            }
        }
        return result;
    }

    normalizeLocationToken(value) {
        return String(value || '')
            .replace(/\s+/g, '')
            .replace(/省|市|自治区|特别行政区/g, '');
    }

}

const CITY_PROVINCE_MAP = {
    上海: ['上海'],
    北京: ['北京'],
    深圳: ['广东', '深圳'],
    广州: ['广东', '广州'],
    武汉: ['湖北', '武汉'],
    青岛: ['山东', '青岛'],
    西安: ['陕西', '西安'],
    杭州: ['浙江', '杭州'],
    南京: ['江苏', '南京'],
    苏州: ['江苏', '苏州'],
    成都: ['四川', '成都'],
    重庆: ['重庆'],
    天津: ['天津'],
    郑州: ['河南', '郑州'],
    长沙: ['湖南', '长沙'],
    合肥: ['安徽', '合肥'],
    宁波: ['浙江', '宁波'],
    厦门: ['福建', '厦门'],
    福州: ['福建', '福州'],
    济南: ['山东', '济南']
};

const CITY_LOCATION_ALIASES = {
    上海: ['上海市', '黄浦区', '静安区', '徐汇区', '长宁区', '虹口区', '杨浦区', '浦东新区', '普陀区', '闵行区'],
    北京: ['北京市', '朝阳区', '东城区', '西城区', '海淀区', '丰台区', '石景山区', '通州区'],
    深圳: ['深圳市', '福田区', '南山区', '罗湖区', '宝安区', '龙华区', '龙岗区'],
    广州: ['广州市', '越秀区', '天河区', '海珠区', '荔湾区', '白云区', '番禺区'],
    武汉: ['武汉市', '江汉区', '江岸区', '武昌区', '洪山区', '汉阳区', '硚口区', '青山区'],
    青岛: ['青岛市', '市南区', '市北区', '崂山区', '李沧区', '黄岛区'],
    西安: ['西安市', '碑林区', '雁塔区', '莲湖区', '新城区', '未央区', '曲江新区'],
    杭州: ['杭州市', '浙江省', '余杭区', '西湖区', '拱墅区', '上城区', '滨江区', '萧山区', '临平区', '钱塘区', '西溪']
};

const KNOWN_LOCATION_TOKENS = Array.from(new Set(Object.entries(CITY_PROVINCE_MAP).flatMap(([city, tokens]) => [city, ...tokens])))
    .sort((a, b) => b.length - a.length);

module.exports = MobileSyncService;
