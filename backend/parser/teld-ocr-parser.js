class TeldOCRParser {
    extractStations(ocrRows, meta = {}) {
        const rows = this.normalizeRows(ocrRows);
        const titleRows = rows
            .filter(row => this.isStationTitle(row.text))
            .sort((a, b) => b.y - a.y);

        const stations = [];
        const seenNames = new Set();

        for (let index = 0; index < titleRows.length; index++) {
            const titleRow = titleRows[index];
            const nextTitleRow = titleRows[index + 1] || null;
            const topY = Math.min(1, titleRow.y + 0.05);
            const bottomY = nextTitleRow ? nextTitleRow.y + 0.02 : 0;

            const bandRows = rows
                .filter(row => row.y <= topY && row.y > bottomY)
                .sort((a, b) => {
                    if (Math.abs(a.y - b.y) > 0.01) {
                        return b.y - a.y;
                    }
                    return a.x - b.x;
                });

            const station = this.extractStationFromBand(titleRow, bandRows, meta);
            if (!station || !station.stationName) {
                continue;
            }

            if (seenNames.has(station.stationName)) {
                continue;
            }

            seenNames.add(station.stationName);
            stations.push(station);
        }

        return stations;
    }

    normalizeRows(rows) {
        if (!Array.isArray(rows)) {
            return [];
        }

        return rows
            .map(row => ({
                text: String(row.text || '').trim(),
                confidence: Number(row.confidence || 0),
                x: Number(row.boundingBox?.x || 0),
                y: Number(row.boundingBox?.y || 0),
                width: Number(row.boundingBox?.width || 0),
                height: Number(row.boundingBox?.height || 0)
            }))
            .filter(row => row.text);
    }

    isStationTitle(text) {
        return /充电站/.test(text) && !/目的地|充电站、|附近充电站/.test(text);
    }

    extractStationFromBand(titleRow, rows, meta) {
        const stationName = this.cleanStationName(titleRow.text);
        if (!stationName) {
            return null;
        }

        const priceCandidates = rows
            .map(row => ({ row, value: this.parsePrice(row.text) }))
            .filter(item => item.value !== null)
            .sort((a, b) => a.row.x - b.row.x);

        const mainPrice = priceCandidates[0]?.value ?? null;
        const memberPrice = priceCandidates[1]?.value ?? null;

        const distance = this.extractDistance(rows);
        const counts = this.extractCounts(rows);
        const totalPorts = this.sumNullable([
            counts.fast?.total ?? null,
            counts.slow?.total ?? null,
            counts.super?.total ?? null
        ]);
        const availablePorts = this.sumNullable([
            counts.fast?.online ?? null,
            counts.slow?.online ?? null,
            counts.super?.online ?? null
        ]);

        return {
            platform: 'teld',
            stationId: null,
            stationName,
            address: null,
            latitude: null,
            longitude: null,
            priceFast: mainPrice,
            priceSlow: null,
            priceService: null,
            availablePorts,
            totalPorts,
            fastIdlePorts: counts.fast?.online ?? 0,
            fastTotalPorts: counts.fast?.total ?? 0,
            slowIdlePorts: counts.slow?.online ?? 0,
            slowTotalPorts: counts.slow?.total ?? 0,
            superIdlePorts: counts.super?.online ?? 0,
            superTotalPorts: counts.super?.total ?? 0,
            onlineFastPorts: this.sumNullable([
                counts.fast?.online ?? null,
                counts.super?.online ?? null
            ]),
            onlineSlowPorts: counts.slow?.online ?? null,
            raw: {
                meta,
                source: 'teld-ocr',
                stationTitle: stationName,
                distanceKm: distance,
                memberPrice,
                rows: rows.map(row => ({
                    text: row.text,
                    confidence: row.confidence,
                    x: row.x,
                    y: row.y
                }))
            }
        };
    }

    cleanStationName(text) {
        return text
            .replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '')
            .replace(/[^\u4e00-\u9fa5A-Za-z0-9（）()·\-]+$/g, '')
            .trim();
    }

    parsePrice(text) {
        const match = text.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
        if (!match) {
            return null;
        }

        const value = Number(match[1]);
        return Number.isFinite(value) ? value : null;
    }

    extractDistance(rows) {
        const candidates = rows
            .map(row => ({
                x: row.x,
                value: this.parseDistance(row.text)
            }))
            .filter(item => item.value !== null)
            .sort((a, b) => a.x - b.x);

        return candidates.length > 0 ? candidates[candidates.length - 1].value : null;
    }

    parseDistance(text) {
        const compact = text.replace(/\s+/g, '');
        const match = compact.match(/(\d+(?:\.\d+)?)km/i);
        if (!match) {
            return null;
        }

        let value = Number(match[1]);
        if (!Number.isFinite(value)) {
            return null;
        }

        // OCR 里蓝色定位箭头偶尔会被识别成前导数字，例如 2.8km -> 42.8km。
        if (value > 20) {
            const fallback = Number(match[1].slice(1));
            if (Number.isFinite(fallback) && fallback < 20) {
                value = fallback;
            }
        }

        return value;
    }

    extractCounts(rows) {
        const candidates = rows
            .map(row => this.parseCountRow(row))
            .filter(Boolean)
            .sort((a, b) => a.x - b.x);

        const result = { fast: null, slow: null, super: null };

        for (const candidate of candidates) {
            if (candidate.label === 'fast') {
                result.fast = candidate;
            } else if (candidate.label === 'slow') {
                result.slow = candidate;
            } else if (candidate.label === 'super') {
                result.super = candidate;
            }
        }

        if (candidates.length === 2) {
            if (!result.fast) {
                result.fast = candidates[0];
            }
            if (!result.slow) {
                result.slow = candidates[1];
            }
        } else if (candidates.length === 1) {
            const only = candidates[0];
            if (only.label === 'slow') {
                result.slow = only;
            } else if (only.label === 'super') {
                result.super = only;
            } else {
                result.fast = only;
            }
        }

        return result;
    }

    parseCountRow(row) {
        const compact = row.text.replace(/\s+/g, '');
        const match = compact.match(/([快慢漫超]?)闲(\d+)\/(\d+)/);
        if (!match) {
            return null;
        }

        const rawLabel = match[1];
        const label = /慢|漫/.test(rawLabel)
            ? 'slow'
            : /超/.test(rawLabel)
                ? 'super'
                : /快/.test(rawLabel)
                    ? 'fast'
                    : null;

        return {
            label,
            online: Number(match[2]),
            total: Number(match[3]),
            x: row.x,
            text: row.text
        };
    }

    sumNullable(values) {
        const numbers = values.filter(value => value !== null && value !== undefined);
        if (numbers.length === 0) {
            return null;
        }

        return numbers.reduce((sum, value) => sum + value, 0);
    }
}

module.exports = TeldOCRParser;
