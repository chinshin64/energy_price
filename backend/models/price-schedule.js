const db = require('../database/init');

class PriceScheduleModel {
    static buildInsertStatement() {
        return db.prepare(`
            INSERT INTO price_schedules (
                station_id, platform, schedule_type, start_time, end_time,
                price, service_fee, weekday_mask, source_type, source_stage, raw_data
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
    }

    static insertOne(stmt, item) {
        stmt.run(
            item.station_id,
            item.platform,
            item.schedule_type || null,
            item.start_time || null,
            item.end_time || null,
            item.price ?? null,
            item.service_fee ?? null,
            item.weekday_mask || null,
            item.source_type || null,
            item.source_stage || null,
            item.raw_data ? JSON.stringify(item.raw_data) : null
        );
    }

    /**
     * 批量插入分时价格
     */
    static insertBatch(schedules) {
        if (!Array.isArray(schedules) || schedules.length === 0) {
            return { successCount: 0, skipCount: 0 };
        }

        const insert = db.transaction((items) => {
            let successCount = 0;
            let skipCount = 0;
            const stmt = this.buildInsertStatement();

            for (const item of items) {
                if (!item.station_id || !item.platform) {
                    skipCount++;
                    continue;
                }

                try {
                    this.insertOne(stmt, item);
                    successCount++;
                } catch (error) {
                    console.warn('插入分时价格失败:', error.message);
                    skipCount++;
                }
            }

            return { successCount, skipCount };
        });

        return insert(schedules);
    }

    /**
     * 根据场站 ID 获取分时价格
     */
    static getByStationId(stationId) {
        return db.prepare(`
            SELECT * FROM price_schedules
            WHERE station_id = ?
            ORDER BY schedule_type, start_time
        `).all(stationId);
    }

    /**
     * 根据平台获取分时价格
     */
    static getByPlatform(platform, limit = 1000) {
        return db.prepare(`
            SELECT ps.*, s.station_name, s.address
            FROM price_schedules ps
            LEFT JOIN stations s ON ps.station_id = s.id
            WHERE ps.platform = ?
            ORDER BY ps.created_at DESC
            LIMIT ?
        `).all(platform, limit);
    }

    static getSummaryMapByStationIds(stationIds = []) {
        const normalizedIds = Array.from(new Set(
            (Array.isArray(stationIds) ? stationIds : [])
                .map(value => Number(value))
                .filter(Number.isInteger)
                .filter(value => value > 0)
        ));

        if (normalizedIds.length === 0) {
            return new Map();
        }

        const placeholders = normalizedIds.map(() => '?').join(', ');
        const rows = db.prepare(`
            SELECT
                station_id,
                COUNT(*) AS count,
                GROUP_CONCAT(DISTINCT COALESCE(schedule_type, 'timeslots')) AS schedule_types,
                MIN(price) AS min_price,
                MAX(price) AS max_price,
                MIN(service_fee) AS min_service_fee,
                MAX(service_fee) AS max_service_fee
            FROM price_schedules
            WHERE station_id IN (${placeholders})
            GROUP BY station_id
        `).all(...normalizedIds);

        return new Map(rows.map(row => [
            Number(row.station_id),
            {
                hasPriceSchedule: Number(row.count) > 0,
                count: Number(row.count) || 0,
                types: String(row.schedule_types || '')
                    .split(',')
                    .map(value => String(value || '').trim())
                    .filter(Boolean),
                minPrice: Number.isFinite(Number(row.min_price)) ? Number(row.min_price) : null,
                maxPrice: Number.isFinite(Number(row.max_price)) ? Number(row.max_price) : null,
                minServiceFee: Number.isFinite(Number(row.min_service_fee)) ? Number(row.min_service_fee) : null,
                maxServiceFee: Number.isFinite(Number(row.max_service_fee)) ? Number(row.max_service_fee) : null
            }
        ]));
    }

    /**
     * 删除场站的所有分时价格
     */
    static deleteByStationId(stationId) {
        return db.prepare('DELETE FROM price_schedules WHERE station_id = ?').run(stationId);
    }

    static backfillFromStations(options = {}) {
        const params = [];
        let query = `
            SELECT id, platform, raw_data, source_type, source_stage
            FROM stations
            WHERE raw_data IS NOT NULL
              AND raw_data != ''
        `;

        if (options.platform) {
            query += ' AND platform = ?';
            params.push(String(options.platform));
        }

        query += ' ORDER BY id ASC';

        const limit = Number(options.limit);
        if (Number.isInteger(limit) && limit > 0) {
            query += ' LIMIT ?';
            params.push(limit);
        }

        const rows = db.prepare(query).all(...params);
        const resetExisting = options.resetExisting !== false;

        const backfill = db.transaction((stationRows) => {
            const insertStmt = this.buildInsertStatement();
            const deleteStmt = db.prepare('DELETE FROM price_schedules WHERE station_id = ?');
            let stationCount = 0;
            let scheduleCount = 0;
            let skipStationCount = 0;
            let errorStationCount = 0;

            for (const row of stationRows) {
                if (resetExisting) {
                    deleteStmt.run(row.id);
                }

                let raw = null;
                try {
                    raw = JSON.parse(row.raw_data);
                } catch (error) {
                    errorStationCount++;
                    continue;
                }

                const schedules = this.extractFromRawData(
                    raw,
                    row.platform,
                    row.id,
                    row.source_type,
                    row.source_stage
                );

                if (schedules.length === 0) {
                    skipStationCount++;
                    continue;
                }

                stationCount++;
                for (const schedule of schedules) {
                    try {
                        this.insertOne(insertStmt, schedule);
                        scheduleCount++;
                    } catch (error) {
                        console.warn(`回填分时价格失败 station_id=${row.id}:`, error.message);
                    }
                }
            }

            return {
                scannedStations: stationRows.length,
                stationCount,
                scheduleCount,
                skipStationCount,
                errorStationCount,
                resetExisting
            };
        });

        return backfill(rows);
    }

    /**
     * 从原始数据中提取分时价格
     * 支持多种数据结构
     */
    static extractFromRawData(rawData, platform, stationId, sourceType = null, sourceStage = null) {
        if (!rawData || typeof rawData !== 'object') {
            return [];
        }

        const schedules = [];
        const seen = new Set();

        // 递归查找分时价格数组
        const findScheduleArrays = (node, path = '', depth = 0) => {
            if (!node || depth > 6) return;

            if (Array.isArray(node)) {
                // 检查是否像分时价格数组
                if (node.length > 0 && this.looksLikeScheduleEntry(node[0])) {
                    const scheduleType = this.inferScheduleType(path);
                    for (const entry of node) {
                        const schedule = this.parseScheduleEntry(entry, platform, stationId, scheduleType, sourceType, sourceStage);
                        if (schedule && this.isUnique(schedule, seen)) {
                            schedules.push(schedule);
                        }
                    }
                }
                // 继续递归
                for (const item of node) {
                    findScheduleArrays(item, path, depth + 1);
                }
                return;
            }

            if (typeof node === 'object') {
                for (const [key, value] of Object.entries(node)) {
                    findScheduleArrays(value, path ? `${path}.${key}` : key, depth + 1);
                }
            }
        };

        findScheduleArrays(rawData);
        return schedules;
    }

    /**
     * 判断是否为分时价格条目
     */
    static looksLikeScheduleEntry(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return false;
        }

        const keys = Object.keys(item);
        const hasTimeField = keys.some(key => /(start|end|time|period|hour|startTime|endTime)/i.test(key));
        const hasPriceField = keys.some(key => /(price|fee|amount|elePrice|servicePrice)/i.test(key));
        const hasNestedFeeInfo = [
            item.originFeeInfo,
            item.memberFeeInfo,
            item.commonActFeeInfo
        ].some(value => value && typeof value === 'object');

        return hasTimeField && (hasPriceField || hasNestedFeeInfo);
    }

    /**
     * 根据路径推断价格类型
     */
    static inferScheduleType(path) {
        const lowerPath = String(path || '').toLowerCase();
        if (lowerPath.includes('fast') || lowerPath.includes('dc') || lowerPath.includes('direct')) {
            return 'fast';
        }
        if (lowerPath.includes('slow') || lowerPath.includes('ac') || lowerPath.includes('alternate')) {
            return 'slow';
        }
        if (lowerPath.includes('super')) {
            return 'super';
        }
        if (lowerPath.includes('service')) {
            return 'service';
        }
        return null;
    }

    /**
     * 解析单个分时价格条目
     */
    static parseScheduleEntry(entry, platform, stationId, scheduleType, sourceType, sourceStage) {
        const timeInfo = this.parseTimeRange(entry);
        const priceInfo = this.parsePriceInfo(entry);

        if (!timeInfo || (!priceInfo.price && !priceInfo.serviceFee)) {
            return null;
        }

        return {
            station_id: stationId,
            platform,
            schedule_type: scheduleType || priceInfo.type || null,
            start_time: timeInfo.start,
            end_time: timeInfo.end,
            price: priceInfo.price ?? null,
            service_fee: priceInfo.serviceFee ?? null,
            weekday_mask: timeInfo.weekdayMask || null,
            source_type: sourceType,
            source_stage: sourceStage,
            raw_data: entry
        };
    }

    /**
     * 解析时间范围
     */
    static parseTimeRange(entry) {
        const rangeText = this.getTimeRangeText(entry);
        const parsedRange = this.parseCompactRange(rangeText);

        // 尝试多种时间字段组合
        const startCandidates = [
            entry.startTime || entry.start_time || entry.start || entry.beginTime || entry.begin,
            entry.hour, // 某些结构只有小时
            parsedRange?.start,
        ].filter(v => v !== undefined && v !== null);

        const endCandidates = [
            entry.endTime || entry.end_time || entry.end || entry.closeTime || entry.close,
            parsedRange?.end,
        ].filter(v => v !== undefined && v !== null);

        if (startCandidates.length === 0) {
            return null;
        }

        const start = this.normalizeTime(startCandidates[0]);
        const end = endCandidates.length > 0 ? this.normalizeTime(endCandidates[0]) : null;

        // 解析星期掩码
        let weekdayMask = null;
        if (entry.weekday || entry.weekdays || entry.week || entry.dayOfWeek) {
            weekdayMask = this.parseWeekdayMask(entry.weekday || entry.weekdays || entry.week || entry.dayOfWeek);
        }

        return { start, end, weekdayMask };
    }

    static getTimeRangeText(entry = {}) {
        return entry.currentTime
            || entry.time
            || entry.period
            || entry.timeRange
            || null;
    }

    static parseCompactRange(value) {
        if (value === null || value === undefined) {
            return null;
        }

        const text = String(value).trim();
        const match = text.match(/(\d{1,2}:\d{2})(?:\s*[-~至]+\s*)(\d{1,2}:\d{2})/);
        if (!match) {
            return null;
        }

        return {
            start: match[1],
            end: match[2]
        };
    }

    /**
     * 标准化时间格式为 HH:mm
     */
    static normalizeTime(value) {
        if (value === null || value === undefined) return null;

        // 如果是数字，假设是小时
        if (typeof value === 'number') {
            const hour = Math.floor(value);
            return `${String(hour).padStart(2, '0')}:00`;
        }

        const str = String(value).trim();

        // 已经是 HH:mm 格式
        if (/^\d{1,2}:\d{2}$/.test(str)) {
            const [h, m] = str.split(':');
            return `${h.padStart(2, '0')}:${m}`;
        }

        // HH:mm:ss 格式
        if (/^\d{1,2}:\d{2}:\d{2}$/.test(str)) {
            const [h, m] = str.split(':');
            return `${h.padStart(2, '0')}:${m}`;
        }

        // 中文时间格式：早8点、下午3点
        const chineseMatch = str.match(/(早|上午|下午|晚|傍晚)?(\d{1,2})(点|时)/);
        if (chineseMatch) {
            let hour = parseInt(chineseMatch[2], 10);
            const period = chineseMatch[1];
            if ((period === '下午' || period === '晚' || period === '傍晚') && hour < 12) {
                hour += 12;
            }
            return `${String(hour).padStart(2, '0')}:00`;
        }

        return str;
    }

    /**
     * 解析星期掩码
     */
    static parseWeekdayMask(value) {
        if (value === null || value === undefined) return null;

        // 如果是数组
        if (Array.isArray(value)) {
            return value.map(v => String(v)).join(',');
        }

        // 如果是逗号分隔的字符串
        if (typeof value === 'string' && value.includes(',')) {
            return value;
        }

        // 如果是数字（位掩码）
        if (typeof value === 'number') {
            const days = [];
            for (let i = 0; i < 7; i++) {
                if (value & (1 << i)) {
                    days.push(String(i));
                }
            }
            return days.length > 0 ? days.join(',') : null;
        }

        return String(value);
    }

    /**
     * 解析价格信息
     */
    static parsePriceInfo(entry) {
        let price = null;
        let serviceFee = null;
        let type = null;
        const nestedFeeInfos = [
            entry.originFeeInfo,
            entry.memberFeeInfo,
            entry.commonActFeeInfo
        ].filter(value => value && typeof value === 'object');

        // 电费/价格
        const priceCandidates = [
            entry.price || entry.elePrice || entry.ele_price || entry.electricityPrice,
            entry.totalPrice || entry.total_price,
            entry.fee || entry.amount,
            ...nestedFeeInfos.map(item => item.eleAmount ?? item.electricityPrice ?? item.price ?? item.fee),
        ];
        for (const candidate of priceCandidates) {
            const num = Number(candidate);
            if (Number.isFinite(num) && num > 0) {
                price = num;
                break;
            }
        }

        // 服务费
        const serviceCandidates = [
            entry.serviceFee || entry.service_fee || entry.servicePrice || entry.service_price,
            entry.serviceAmount || entry.service_amount,
            ...nestedFeeInfos.map(item => item.serviceAmount ?? item.serviceFee ?? item.service_price),
        ];
        for (const candidate of serviceCandidates) {
            const num = Number(candidate);
            if (Number.isFinite(num) && num > 0) {
                serviceFee = num;
                break;
            }
        }

        // 类型推断
        if (entry.type !== undefined) {
            const typeVal = String(entry.type).toLowerCase();
            if (typeVal.includes('fast') || typeVal.includes('dc') || typeVal === '1') {
                type = 'fast';
            } else if (typeVal.includes('slow') || typeVal.includes('ac') || typeVal === '2') {
                type = 'slow';
            } else if (typeVal.includes('super') || typeVal === '3') {
                type = 'super';
            }
        }

        return { price, serviceFee, type };
    }

    /**
     * 检查是否唯一（避免重复）
     */
    static isUnique(schedule, seen) {
        const key = [
            schedule.station_id,
            schedule.schedule_type,
            schedule.start_time,
            schedule.end_time,
            schedule.price
        ].join('|');

        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    }

    /**
     * 获取统计信息
     */
    static getStatistics() {
        return db.prepare(`
            SELECT
                platform,
                schedule_type,
                COUNT(*) as count
            FROM price_schedules
            GROUP BY platform, schedule_type
            ORDER BY platform, schedule_type
        `).all();
    }

    /**
     * 清理过期的分时价格（超过指定天数）
     */
    static cleanupOld(days = 30) {
        return db.prepare(`
            DELETE FROM price_schedules
            WHERE datetime(created_at) < datetime('now', '-' || ? || ' days', 'localtime')
        `).run(days);
    }
}

module.exports = PriceScheduleModel;
