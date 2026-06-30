class TeldRuntimeParser {
    extractStations(payload, meta = {}) {
        const parsedPayload = this.parsePayload(payload);
        const candidates = [];
        this.walkPayload(parsedPayload, '$', 0, candidates);

        const stations = [];
        const seen = new Set();

        for (const candidate of candidates) {
            const station = this.normalizeStation(candidate.item, meta, candidate.path);
            if (!station) {
                continue;
            }

            const key = [
                station.stationId || '',
                station.stationName || '',
                station.latitude || '',
                station.longitude || ''
            ].join('|');

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            stations.push(station);
        }

        return stations;
    }

    parsePayload(payload) {
        if (typeof payload === 'string') {
            try {
                return JSON.parse(payload);
            } catch (error) {
                return payload;
            }
        }

        return payload;
    }

    walkPayload(node, pathKey, depth, candidates) {
        if (!node || depth > 8) {
            return;
        }

        if (Array.isArray(node)) {
            const stationItems = node.filter(item => this.scoreStationCandidate(item) >= 3);
            if (stationItems.length > 0) {
                node.forEach((item, index) => {
                    if (this.scoreStationCandidate(item) >= 3) {
                        candidates.push({ item, path: `${pathKey}[${index}]` });
                    }
                });
            }

            node.forEach((item, index) => this.walkPayload(item, `${pathKey}[${index}]`, depth + 1, candidates));
            return;
        }

        if (typeof node !== 'object') {
            return;
        }

        Object.entries(node).forEach(([key, value]) => {
            this.walkPayload(value, `${pathKey}.${key}`, depth + 1, candidates);
        });
    }

    scoreStationCandidate(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return 0;
        }

        let score = 0;
        if (this.getFirstDefined(item, ['StationID', 'stationId', 'stationCode', 'id'])) score += 1;
        if (this.getFirstDefined(item, ['StationName', 'stationName', 'name', 'title'])) score += 1;
        if (this.getFirstDefined(item, ['Address', 'address', 'stationAddress'])) score += 1;
        if (this.pickNumber(item, ['StationLat', 'lat', 'latitude'])) score += 1;
        if (this.pickNumber(item, ['StationLng', 'lng', 'longitude'])) score += 1;

        const keys = Object.keys(item);
        if (keys.some(key => /station|price|terminal|charge|gun|fast|slow/i.test(key))) {
            score += 1;
        }

        return score;
    }

    normalizeStation(item, meta, pathKey) {
        const stationId = this.getFirstDefined(item, ['StationID', 'stationId', 'stationCode', 'id']);
        const stationName = this.getFirstDefined(item, ['StationName', 'stationName', 'name', 'title']);
        const latitude = this.pickNumber(item, ['StationLat', 'lat', 'latitude']);
        const longitude = this.pickNumber(item, ['StationLng', 'lng', 'longitude']);

        if (!stationId && !stationName) {
            return null;
        }

        const terminalStats = this.extractTerminalStats(item);
        const fastIdlePorts = this.firstNonNull([
            this.sumNumbers(item, ['FastAvailableNum', 'FastIdleNum', 'DcIdleNum', 'DirectIdleNum']),
            terminalStats.fastIdlePorts
        ]) || 0;
        const slowIdlePorts = this.firstNonNull([
            this.sumNumbers(item, ['SlowAvailableNum', 'SlowIdleNum', 'AcIdleNum', 'AlternateIdleNum']),
            terminalStats.slowIdlePorts
        ]) || 0;
        const superIdlePorts = this.firstNonNull([
            this.sumNumbers(item, ['SuperAvailableNum', 'SuperIdleNum']),
            terminalStats.superIdlePorts
        ]) || 0;
        const fastTotalPorts = this.firstNonNull([
            this.sumNumbers(item, ['FastNum', 'DcNum', 'DirectNum']),
            terminalStats.fastTotalPorts
        ]) || 0;
        const slowTotalPorts = this.firstNonNull([
            this.sumNumbers(item, ['SlowNum', 'AcNum', 'AlternateNum']),
            terminalStats.slowTotalPorts
        ]) || 0;
        const superTotalPorts = this.firstNonNull([
            this.sumNumbers(item, ['SuperNum']),
            terminalStats.superTotalPorts
        ]) || 0;
        const onlineFastPorts = this.firstNonNull([
            this.sumNumbers(item, ['FastAvailableNum', 'FastIdleNum', 'DcIdleNum', 'DirectIdleNum', 'SuperIdleNum']),
            terminalStats.onlineFastPorts,
            fastIdlePorts + superIdlePorts
        ]);
        const onlineSlowPorts = this.firstNonNull([
            this.sumNumbers(item, ['SlowAvailableNum', 'SlowIdleNum', 'AcIdleNum', 'AlternateIdleNum']),
            terminalStats.onlineSlowPorts,
            slowIdlePorts
        ]);
        const totalPorts = this.firstNonNull([
            this.sumNumbers(item, ['TotalNum', 'FastNum', 'SlowNum', 'SuperNum', 'DirectNum', 'AlternateNum']),
            terminalStats.totalPorts,
            fastTotalPorts + slowTotalPorts + superTotalPorts
        ]);
        const availablePorts = this.firstNonNull([
            this.pickNumber(item, ['AvailableNum', 'IdleNum']),
            fastIdlePorts + slowIdlePorts + superIdlePorts
        ]);

        return {
            platform: 'teld',
            stationId: stationId || null,
            stationName: stationName || null,
            address: this.getFirstDefined(item, ['Address', 'address', 'stationAddress']) || null,
            latitude,
            longitude,
            priceFast: this.pickNumber(item, ['FastPrice', 'fastPrice', 'DcPrice', 'DirectPrice', 'Price.Fast']),
            priceSlow: this.pickNumber(item, ['SlowPrice', 'slowPrice', 'AcPrice', 'AlternatePrice', 'Price.Slow']),
            priceService: this.pickNumber(item, ['ServicePrice', 'servicePrice', 'ServiceFee', 'Price.Service']),
            fastIdlePorts: this.toNonNegativeInt(fastIdlePorts),
            fastTotalPorts: this.toNonNegativeInt(fastTotalPorts),
            slowIdlePorts: this.toNonNegativeInt(slowIdlePorts),
            slowTotalPorts: this.toNonNegativeInt(slowTotalPorts),
            superIdlePorts: this.toNonNegativeInt(superIdlePorts),
            superTotalPorts: this.toNonNegativeInt(superTotalPorts),
            availablePorts,
            totalPorts,
            onlineFastPorts,
            onlineSlowPorts,
            raw: {
                meta,
                path: pathKey,
                item
            }
        };
    }

    extractTerminalStats(item) {
        const terminalList = this.getFirstDefined(item, ['TerminalList', 'terminalList', 'Terminals', 'terminals']);
        if (!Array.isArray(terminalList)) {
            return {
                onlineFastPorts: null,
                onlineSlowPorts: null,
                totalPorts: null,
                fastIdlePorts: null,
                slowIdlePorts: null,
                superIdlePorts: null,
                fastTotalPorts: null,
                slowTotalPorts: null,
                superTotalPorts: null
            };
        }

        let onlineFastPorts = 0;
        let onlineSlowPorts = 0;
        let totalPorts = 0;
        let fastIdlePorts = 0;
        let slowIdlePorts = 0;
        let superIdlePorts = 0;
        let fastTotalPorts = 0;
        let slowTotalPorts = 0;
        let superTotalPorts = 0;

        for (const terminal of terminalList) {
            totalPorts++;
            const type = this.getTerminalType(terminal);
            const isOnline = this.looksLikeOnlineTerminal(terminal);

            if (type === 'super') {
                superTotalPorts++;
                if (isOnline) {
                    superIdlePorts++;
                    onlineFastPorts++;
                }
            } else if (type === 'fast') {
                fastTotalPorts++;
                if (isOnline) {
                    fastIdlePorts++;
                    onlineFastPorts++;
                }
            } else {
                slowTotalPorts++;
                if (isOnline) {
                    slowIdlePorts++;
                    onlineSlowPorts++;
                }
            }
        }

        return {
            onlineFastPorts,
            onlineSlowPorts,
            totalPorts,
            fastIdlePorts,
            slowIdlePorts,
            superIdlePorts,
            fastTotalPorts,
            slowTotalPorts,
            superTotalPorts
        };
    }

    getTerminalType(terminal) {
        const rawType = String(this.getFirstDefined(terminal, ['TerminalType', 'terminalType', 'Type', 'type', 'ChargeType']) || '').toLowerCase();
        if (/super|ultra|hpc|超/.test(rawType)) {
            return 'super';
        }
        if (/fast|dc|direct|快/.test(rawType)) {
            return 'fast';
        }
        return 'slow';
    }

    looksLikeOnlineTerminal(terminal) {
        const availability = this.getFirstDefined(terminal, ['IsAvailable', 'isAvailable', 'Idle', 'idle', 'IsIdle', 'isIdle']);
        if (availability !== null) {
            return ['1', 'true', 'yes'].includes(String(availability).toLowerCase());
        }

        const status = String(this.getFirstDefined(terminal, ['Status', 'status', 'TerminalStatus', 'terminalStatus']) || '').toLowerCase();
        if (!status) {
            return false;
        }

        return /idle|free|available|online|空闲|可用|正常/.test(status);
    }

    getFirstDefined(obj, paths) {
        for (const pathKey of paths) {
            const value = pathKey.split('.').reduce((acc, key) => {
                if (acc === undefined || acc === null) {
                    return undefined;
                }
                return acc[key];
            }, obj);

            if (value !== undefined && value !== null && value !== '') {
                return value;
            }
        }

        return null;
    }

    pickNumber(obj, paths) {
        const value = this.getFirstDefined(obj, paths);
        if (value === null) {
            return null;
        }

        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    sumNumbers(obj, paths) {
        const values = paths
            .map(pathKey => this.pickNumber(obj, [pathKey]))
            .filter(value => value !== null);

        if (values.length === 0) {
            return null;
        }

        return values.reduce((sum, value) => sum + value, 0);
    }

    firstNonNull(values) {
        for (const value of values) {
            if (value !== null && value !== undefined) {
                return value;
            }
        }

        return null;
    }

    toNonNegativeInt(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) {
            return 0;
        }
        return Math.max(0, Math.round(num));
    }
}

module.exports = TeldRuntimeParser;
