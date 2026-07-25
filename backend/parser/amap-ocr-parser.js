'use strict';

class AmapOcrParser {
    extractStations(ocrRows, meta = {}) {
        const rows = this.normalizeRows(ocrRows)
            .sort((left, right) => left.y - right.y || left.x - right.x);
        const titles = rows.filter(row => this.isStationTitle(row.text));
        const stations = [];
        const seen = new Set();

        for (let index = 0; index < titles.length; index += 1) {
            const title = titles[index];
            const nextTitle = this.findNextTitleInColumn(titles, index, title);
            const band = this.stationBand(rows, title, nextTitle);
            const station = this.parseBand(title, band, meta);
            if (!station) continue;

            const key = `${station.stationName}|${station.address || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            stations.push(station);
        }

        return stations;
    }

    normalizeRows(rows) {
        if (!Array.isArray(rows)) return [];
        return rows.map(row => {
            const box = row?.boundingBox || row?.bounds || {};
            return {
                text: String(row?.text || '').trim(),
                confidence: Number(row?.confidence ?? row?.score ?? 1),
                x: this.number(row?.x, box.x, box.left),
                y: this.number(row?.y, box.y, box.top),
                width: this.number(row?.width, box.width),
                height: this.number(row?.height, box.height)
            };
        }).filter(row => row.text);
    }

    isStationTitle(text) {
        const value = this.compact(text);
        return value.length >= 5
            && value.length <= 64
            && /[\u4e00-\u9fa5]/.test(value)
            && /(充电站|超充站|快充站|极充站|充电中心|充电广场|充电桩)/.test(value)
            && !/(附近充电站|搜索充电站|充电站约\d+个地点)/.test(value);
    }

    findNextTitleInColumn(titles, currentIndex, title) {
        for (let index = currentIndex + 1; index < titles.length; index += 1) {
            const candidate = titles[index];
            if (candidate.y <= title.y + 0.012 || !this.isSameColumn(title, candidate)) continue;
            return candidate;
        }
        return null;
    }

    stationBand(rows, title, nextTitle) {
        let maxY = title.y + Math.max(0.22, title.height * 8);
        if (nextTitle) maxY = Math.min(maxY, nextTitle.y - 0.006);
        return rows.filter(row => row === title
                || (row.y > title.y && row.y < maxY && this.isSameColumn(title, row)))
            .sort((left, right) => left.y - right.y || left.x - right.x);
    }

    isSameColumn(title, row) {
        const titleCenter = title.x + title.width / 2;
        const rowCenter = row.x + row.width / 2;
        const titleIsGridCard = title.width > 0 && title.width < 0.58;
        const rowIsFullWidth = row.width >= 0.72;
        if (titleIsGridCard && !rowIsFullWidth) {
            return (titleCenter < 0.5) === (rowCenter < 0.5);
        }
        return Math.abs(titleCenter - rowCenter) <= 0.36;
    }

    parseBand(title, band, meta) {
        const stationName = this.mergeTitleLines(title, band);
        if (!stationName || /\.{3}|…/.test(stationName)) return null;

        const combined = band.map(row => this.compact(row.text)).join(' ');
        const price = this.extractPrice(combined);
        const ports = this.extractPorts(combined);
        if (price === null && ports.total === 0) return null;

        const distanceMeters = this.extractDistanceMeters(band);
        return {
            platform: 'amap-charging',
            stationId: null,
            stationName,
            address: this.extractAddress(band, stationName),
            latitude: null,
            longitude: null,
            priceFast: price,
            priceSlow: null,
            priceSuper: null,
            priceService: null,
            availablePorts: ports.total > 0 ? ports.idle : null,
            totalPorts: ports.total > 0 ? ports.total : null,
            onlineFastPorts: ports.idle,
            onlineSlowPorts: 0,
            fastIdlePorts: ports.idle,
            fastTotalPorts: ports.total,
            slowIdlePorts: 0,
            slowTotalPorts: 0,
            superIdlePorts: 0,
            superTotalPorts: 0,
            sourceType: meta.sourceType || 'mobile-ocr',
            sourceStage: meta.sourceStage || meta.stage || 'phone-auto-scroll',
            raw: {
                source: 'page-ocr',
                localParser: 'amap-server',
                distanceMeters,
                ocrTexts: band.map(row => row.text),
                ocrRows: band,
                meta
            }
        };
    }

    extractPrice(text) {
        const matches = text.matchAll(/[¥￥]\s*(\d+(?:\.\d{1,4})?)\s*(?:元)?\s*\/?\s*(?:度|千瓦时|kWh|KWH)/g);
        for (const match of matches) {
            const value = Number(match[1]);
            if (Number.isFinite(value) && value >= 0.2 && value <= 3.5) return value;
        }
        return null;
    }

    mergeTitleLines(title, band) {
        let name = this.cleanName(title.text);
        const opens = (name.match(/[（(]/g) || []).length;
        const closes = (name.match(/[）)]/g) || []).length;
        if (opens <= closes) return name;

        for (const row of band) {
            if (row === title || row.y <= title.y || row.y > title.y + 0.045) continue;
            const nextLine = this.cleanName(row.text);
            if (!nextLine || /[¥￥]|\/度|\d+\/\d+|充电站|充电桩/.test(nextLine)) continue;
            if ((name + nextLine).length > 64) break;
            name += nextLine;
            break;
        }
        return name;
    }

    extractPorts(text) {
        let idle = 0;
        let total = 0;
        for (const match of text.matchAll(/(?:快|慢|超)?\s*(?:空|空闲?)\s*(\d+)\s*\/\s*(\d+)/g)) {
            idle += Number(match[1]) || 0;
            total += Number(match[2]) || 0;
        }
        return { idle, total };
    }

    extractAddress(rows, stationName) {
        for (const row of rows) {
            const value = this.compact(row.text);
            if (value === this.compact(stationName) || value.length < 6 || value.length > 90) continue;
            if (!/(省|市|区|县|镇|路|街|道|号|栋|楼|大厦|广场|园|停车场|地下)/.test(value)) continue;
            if (/[¥￥]|\/度|\d+\/\d+|优惠|服务费/.test(value)) continue;
            return value.replace(/[·•．]?\d+(?:\.\d+)?(?:米|m|km|公里)$/i, '').trim() || null;
        }
        return null;
    }

    extractDistanceMeters(rows) {
        for (const row of rows) {
            const value = this.compact(row.text);
            const match = value.match(/(\d+(?:\.\d+)?)(米|m|km|公里)$/i);
            if (!match) continue;
            const distance = Number(match[1]);
            if (!Number.isFinite(distance)) continue;
            return /km|公里/i.test(match[2]) ? Math.round(distance * 1000) : Math.round(distance);
        }
        return null;
    }

    cleanName(text) {
        return this.compact(text)
            .replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '')
            .replace(/[|「」【】]+/g, '')
            .trim();
    }

    compact(text) {
        return String(text || '').replace(/\s+/g, '').trim();
    }

    number(...values) {
        for (const value of values) {
            const number = Number(value);
            if (Number.isFinite(number)) return number;
        }
        return 0;
    }
}

module.exports = AmapOcrParser;
