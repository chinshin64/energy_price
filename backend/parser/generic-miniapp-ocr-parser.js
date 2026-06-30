class GenericMiniAppOCRParser {
    extractStations(ocrRows, meta = {}) {
        const rows = this.normalizeRows(ocrRows);
        const profile = this.resolveProfile(meta.platform);
        const titleRows = rows
            .filter(row => this.isStationTitle(row.text, profile))
            .sort((a, b) => b.y - a.y);

        const stations = [];
        const seenKeys = new Set();

        for (let index = 0; index < titleRows.length; index++) {
            const titleRow = titleRows[index];
            const nextTitleRow = titleRows[index + 1] || null;
            const topY = Math.min(1, titleRow.y + 0.06);
            const bottomY = nextTitleRow ? nextTitleRow.y + 0.02 : 0;

            const bandRows = rows
                .filter(row => row.y <= topY && row.y > bottomY)
                .sort((a, b) => {
                    if (Math.abs(a.y - b.y) > 0.01) {
                        return b.y - a.y;
                    }
                    return a.x - b.x;
                });

            const station = this.extractStationFromBand(titleRow, bandRows, meta, profile);
            if (!station || !station.stationName) {
                continue;
            }

            const key = `${station.platform}|${station.stationName}|${station.address || ''}`;
            if (seenKeys.has(key)) {
                continue;
            }

            seenKeys.add(key);
            stations.push(station);
        }

        return stations;
    }

    resolveProfile(platform) {
        return platform === 'tuanyou' ? 'fuel' : 'charge';
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

    isStationTitle(text, profile) {
        const compact = String(text || '').replace(/\s+/g, '');
        if (!compact || compact.length < 4 || compact.length > 40) {
            return false;
        }

        if (profile === 'fuel') {
            return /(加油站|油站)/.test(compact) && !/(评价|详情|导航|筛选|油号|今日油价)/.test(compact);
        }

        return /(充电站|充电中心|充电广场|充电桩)/.test(compact) && !/(目的地|附近充电站|筛选|评价|详情)/.test(compact);
    }

    extractStationFromBand(titleRow, rows, meta, profile) {
        const stationName = this.cleanStationName(titleRow.text);
        if (!stationName) {
            return null;
        }

        const address = this.extractAddress(rows, stationName, profile);

        if (profile === 'fuel') {
            const fuelSummary = this.extractFuelSummary(rows);
            return {
                platform: meta.platform || 'tuanyou',
                stationId: null,
                stationName,
                address,
                latitude: null,
                longitude: null,
                priceFast: null,
                priceSlow: null,
                priceSuper: null,
                priceService: null,
                availablePorts: null,
                totalPorts: null,
                onlineFastPorts: 0,
                onlineSlowPorts: 0,
                fastIdlePorts: 0,
                fastTotalPorts: 0,
                slowIdlePorts: 0,
                slowTotalPorts: 0,
                superIdlePorts: 0,
                superTotalPorts: 0,
                fuel92Price: fuelSummary.fuel92Price ?? null,
                fuel95Price: fuelSummary.fuel95Price ?? null,
                fuel98Price: fuelSummary.fuel98Price ?? null,
                fuelDieselPrice: fuelSummary.fuelDieselPrice ?? null,
                fuel92Count: fuelSummary.fuel92Count ?? null,
                fuel95Count: fuelSummary.fuel95Count ?? null,
                fuel98Count: fuelSummary.fuel98Count ?? null,
                fuelDieselCount: fuelSummary.fuelDieselCount ?? null,
                sourceType: 'page-ocr',
                sourceStage: meta.stage || null,
                raw: {
                    meta,
                    source: 'page-ocr',
                    rows: this.simplifyRows(rows)
                }
            };
        }

        const prices = this.extractChargePrices(rows);
        const counts = this.extractChargeCounts(rows);
        const totalPorts = this.sumNullable([
            counts.fast?.total ?? null,
            counts.slow?.total ?? null,
            counts.super?.total ?? null
        ]);
        const availablePorts = this.sumNullable([
            counts.fast?.idle ?? null,
            counts.slow?.idle ?? null,
            counts.super?.idle ?? null
        ]);

        return {
            platform: meta.platform || 'unknown',
            stationId: null,
            stationName,
            address,
            latitude: null,
            longitude: null,
            priceFast: prices.fast ?? prices.fallback ?? null,
            priceSlow: prices.slow ?? null,
            priceSuper: prices.super ?? null,
            priceService: prices.service ?? null,
            availablePorts,
            totalPorts,
            onlineFastPorts: this.sumNullable([
                counts.fast?.idle ?? null,
                counts.super?.idle ?? null
            ]),
            onlineSlowPorts: counts.slow?.idle ?? null,
            fastIdlePorts: counts.fast?.idle ?? 0,
            fastTotalPorts: counts.fast?.total ?? 0,
            slowIdlePorts: counts.slow?.idle ?? 0,
            slowTotalPorts: counts.slow?.total ?? 0,
            superIdlePorts: counts.super?.idle ?? 0,
            superTotalPorts: counts.super?.total ?? 0,
            fuel92Price: null,
            fuel95Price: null,
            fuel98Price: null,
            fuelDieselPrice: null,
            fuel92Count: null,
            fuel95Count: null,
            fuel98Count: null,
            fuelDieselCount: null,
            sourceType: 'page-ocr',
            sourceStage: meta.stage || null,
            raw: {
                meta,
                source: 'page-ocr',
                rows: this.simplifyRows(rows)
            }
        };
    }

    extractAddress(rows, stationName, profile) {
        const candidates = rows
            .filter(row => row.text !== stationName)
            .filter(row => !this.looksLikePriceOrCount(row.text, profile))
            .filter(row => this.looksLikeAddress(row.text))
            .sort((a, b) => {
                if (Math.abs(a.y - b.y) > 0.01) {
                    return b.y - a.y;
                }
                return b.text.length - a.text.length;
            });

        return candidates[0]?.text || null;
    }

    extractChargePrices(rows) {
        const result = { fast: null, slow: null, super: null, service: null, fallback: null };
        const fallbackPrices = [];

        for (const row of rows) {
            const compact = row.text.replace(/\s+/g, '');
            const labeledMatchers = [
                { key: 'fast', regex: /(快充|快)\D{0,8}[¥￥]?(\d+(?:\.\d{1,4})?)/ },
                { key: 'slow', regex: /(慢充|慢|漫充|漫)\D{0,8}[¥￥]?(\d+(?:\.\d{1,4})?)/ },
                { key: 'super', regex: /(超充|超)\D{0,8}[¥￥]?(\d+(?:\.\d{1,4})?)/ },
                { key: 'service', regex: /服务费\D{0,8}[¥￥]?(\d+(?:\.\d{1,4})?)/ }
            ];

            for (const matcher of labeledMatchers) {
                const match = compact.match(matcher.regex);
                if (!match) {
                    continue;
                }

                const rawValue = matcher.key === 'service' ? match[1] : match[2];
                const value = Number(rawValue);
                if (Number.isFinite(value)) {
                    result[matcher.key] = value;
                }
            }

            const currencyMatches = compact.match(/[¥￥](\d+(?:\.\d{1,4})?)/g) || [];
            for (const match of currencyMatches) {
                const value = Number(match.replace(/[¥￥]/g, ''));
                if (Number.isFinite(value)) {
                    fallbackPrices.push(value);
                }
            }
        }

        if (result.fast === null && fallbackPrices.length > 0) {
            result.fallback = fallbackPrices[0];
        }

        return result;
    }

    extractChargeCounts(rows) {
        const result = { fast: null, slow: null, super: null };
        const unlabeled = [];

        for (const row of rows) {
            const compact = row.text.replace(/\s+/g, '');
            const match = compact.match(/(快充|慢充|漫充|超充|快|慢|漫|超)?[^0-9]{0,6}(?:空闲)?(\d+)\s*\/\s*(\d+)/);
            if (!match) {
                continue;
            }

            const rawLabel = match[1] || '';
            const label = /慢|漫/.test(rawLabel)
                ? 'slow'
                : /超/.test(rawLabel)
                    ? 'super'
                    : /快/.test(rawLabel)
                        ? 'fast'
                        : null;
            const candidate = {
                idle: Number(match[2]),
                total: Number(match[3]),
                x: row.x
            };

            if (label) {
                result[label] = candidate;
            } else {
                unlabeled.push(candidate);
            }
        }

        if (unlabeled.length === 1 && !result.fast) {
            result.fast = unlabeled[0];
        }

        return result;
    }

    extractFuelSummary(rows) {
        const result = {};

        for (const row of rows) {
            const compact = row.text.replace(/\s+/g, '');
            const labels = ['92', '95', '98', 'diesel'];

            for (const label of labels) {
                const labelPattern = label === 'diesel' ? '(柴油|0#|Diesel)' : `${label}`;
                const priceMatch = compact.match(new RegExp(`${labelPattern}[^0-9]{0,8}(\\d+(?:\\.\\d{1,4})?)`, 'i'));
                if (priceMatch) {
                    const value = Number(priceMatch[2] || priceMatch[1]);
                    if (Number.isFinite(value)) {
                        result[this.getFuelPriceKey(label)] = value;
                    }
                }

                const countMatch = compact.match(new RegExp(`${labelPattern}[^0-9]{0,8}(\\d+)(枪|个|支)`, 'i'));
                if (countMatch) {
                    const value = Number(countMatch[1]);
                    if (Number.isFinite(value)) {
                        result[this.getFuelCountKey(label)] = value;
                    }
                }
            }
        }

        return result;
    }

    getFuelPriceKey(label) {
        if (label === '92') return 'fuel92Price';
        if (label === '95') return 'fuel95Price';
        if (label === '98') return 'fuel98Price';
        return 'fuelDieselPrice';
    }

    getFuelCountKey(label) {
        if (label === '92') return 'fuel92Count';
        if (label === '95') return 'fuel95Count';
        if (label === '98') return 'fuel98Count';
        return 'fuelDieselCount';
    }

    looksLikePriceOrCount(text, profile) {
        const compact = String(text || '').replace(/\s+/g, '');
        if (profile === 'fuel') {
            return /(92|95|98|柴油|0#).*(\d+(?:\.\d+)?)/.test(compact);
        }
        return /([¥￥]\d+|\d+\/\d+|快充|慢充|超充|服务费)/.test(compact);
    }

    looksLikeAddress(text) {
        const compact = String(text || '').replace(/\s+/g, '');
        if (compact.length < 6 || compact.length > 60) {
            return false;
        }

        return /(省|市|区|县|镇|乡|街|路|号|大道|广场|停车场|大厦|园|桥|村|口)/.test(compact);
    }

    cleanStationName(text) {
        return String(text || '')
            .replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '')
            .replace(/[^\u4e00-\u9fa5A-Za-z0-9（）()·\-#]+$/g, '')
            .trim();
    }

    simplifyRows(rows) {
        return rows.map(row => ({
            text: row.text,
            confidence: row.confidence,
            x: row.x,
            y: row.y
        }));
    }

    sumNullable(values) {
        const numbers = values.filter(value => value !== null && value !== undefined);
        if (numbers.length === 0) {
            return null;
        }

        return numbers.reduce((sum, value) => sum + value, 0);
    }
}

module.exports = GenericMiniAppOCRParser;
