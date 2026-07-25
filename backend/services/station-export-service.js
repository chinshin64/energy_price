'use strict';

const CSV_COLUMNS = Object.freeze([
    ['Platform', 'platform'],
    ['Station ID', 'station_id'],
    ['Station Name', 'station_name'],
    ['Address', 'address'],
    ['Available Ports', 'available_ports'],
    ['Busy Ports', 'busy_ports'],
    ['Total Ports', 'total_ports'],
    ['Port Semantics', 'port_semantics'],
    ['Missing Fields', 'missing_fields'],
    ['Quality Status', 'quality_status'],
    ['Price Fast', 'price_fast'],
    ['Price Slow', 'price_slow'],
    ['Price Super', 'price_super'],
    ['Price Service', 'price_service'],
    ['Online Fast Ports', 'online_fast_ports'],
    ['Online Slow Ports', 'online_slow_ports'],
    ['Fast Idle', 'fast_idle_ports'],
    ['Fast Total', 'fast_total_ports'],
    ['Slow Idle', 'slow_idle_ports'],
    ['Slow Total', 'slow_total_ports'],
    ['Super Idle', 'super_idle_ports'],
    ['Super Total', 'super_total_ports'],
    ['Fuel92 Price', 'fuel_92_price'],
    ['Fuel95 Price', 'fuel_95_price'],
    ['Fuel98 Price', 'fuel_98_price'],
    ['FuelDiesel Price', 'fuel_diesel_price'],
    ['Fuel92 Count', 'fuel_92_count'],
    ['Fuel95 Count', 'fuel_95_count'],
    ['Fuel98 Count', 'fuel_98_count'],
    ['FuelDiesel Count', 'fuel_diesel_count'],
    ['Source Type', 'source_type'],
    ['Source Stage', 'source_stage'],
    ['Source Agent', 'source_agent'],
    ['Source Node', 'source_node'],
    ['Source Record ID', 'source_record_id'],
    ['Price/Gun Snapshot At', 'price_gun_snapshot_at'],
    ['Collected At', 'collected_at'],
]);

const FUEL_CSV_COLUMNS = Object.freeze([
    ['Platform', 'platform'],
    ['Station ID', 'station_id'],
    ['Station Name', 'station_name'],
    ['Address', 'address'],
    ['Available Ports', 'available_ports'],
    ['Busy Ports', 'busy_ports'],
    ['Total Ports', 'total_ports'],
    ['Port Semantics', 'port_semantics'],
    ['Missing Fields', 'missing_fields'],
    ['Quality Status', 'quality_status'],
    ['Provider Name', 'provider_name'],
    ['Fuel Offers', 'fuel_offers_json'],
    ['Fuel Quotes', 'fuel_quotes_json'],
    ['Source Type', 'source_type'],
    ['Source Stage', 'source_stage'],
    ['Source Agent', 'source_agent'],
    ['Source Node', 'source_node'],
    ['Source Record ID', 'source_record_id'],
    ['Snapshot At', 'snapshot_at'],
    ['Collected At', 'collected_at'],
]);

function exportError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = 400;
    return error;
}

function escapeCsvCell(value) {
    if (value === null || value === undefined) return '';
    let text = String(value);
    if (/^[\t\r ]*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
    if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
    return text;
}

class StationExportService {
    constructor(options = {}) {
        this.stationModel = options.stationModel;
        this.maxRows = Math.max(1, Math.min(100000, Number(options.maxRows) || 50000));
        if (!this.stationModel) throw new TypeError('stationModel is required');
    }

    prepare(options = {}) {
        const platform = this.normalizePlatform(options.platform);
        const limit = this.normalizeLimit(options.limit);
        const totalRows = this.stationModel.countSnapshotsForExport(platform);
        const exportRows = Math.min(totalRows, limit);
        const platformPart = platform || 'all';
        return {
            filename: `stations-${platformPart}-${new Date().toISOString().slice(0, 10)}.csv`,
            totalRows,
            exportRows,
            truncated: totalRows > limit,
            lines: this.generateLines(platform, limit),
        };
    }

    prepareFuelExtended(options = {}) {
        if (typeof this.stationModel.countFuelSnapshotsForExport !== 'function'
                || typeof this.stationModel.iterateFuelSnapshotsForExport !== 'function') {
            throw new TypeError('stationModel fuel export methods are required');
        }
        const platform = this.normalizePlatform(options.platform);
        const limit = this.normalizeLimit(options.limit);
        const totalRows = this.stationModel.countFuelSnapshotsForExport(platform);
        const exportRows = Math.min(totalRows, limit);
        const platformPart = platform || 'all';
        return {
            filename: `fuel-stations-${platformPart}-${new Date().toISOString().slice(0, 10)}.csv`,
            totalRows,
            exportRows,
            truncated: totalRows > limit,
            lines: this.generateFuelExtendedLines(platform, limit),
        };
    }

    *generateLines(platform, limit) {
        yield `\uFEFF${CSV_COLUMNS.map(([label]) => escapeCsvCell(label)).join(',')}\r\n`;
        const rows = this.stationModel.iterateSnapshotsForExport(platform, limit);
        for (const row of rows) {
            const normalized = {
                ...row,
                price_gun_snapshot_at: row.snapshot_at || row.collected_at || '',
            };
            yield `${CSV_COLUMNS.map(([, field]) => escapeCsvCell(normalized[field])).join(',')}\r\n`;
        }
    }

    *generateFuelExtendedLines(platform, limit) {
        yield `\uFEFF${FUEL_CSV_COLUMNS.map(([label]) => escapeCsvCell(label)).join(',')}\r\n`;
        const rows = this.stationModel.iterateFuelSnapshotsForExport(platform, limit);
        for (const row of rows) {
            yield `${FUEL_CSV_COLUMNS.map(([, field]) => escapeCsvCell(row[field])).join(',')}\r\n`;
        }
    }

    normalizePlatform(value) {
        if (value === undefined || value === null || value === '') return null;
        const platform = String(value).trim();
        if (!/^[a-z0-9._-]{1,64}$/i.test(platform)) {
            throw exportError('export_platform_invalid', 'platform is invalid');
        }
        return platform;
    }

    normalizeLimit(value) {
        if (value === undefined || value === null || value === '') return this.maxRows;
        const limit = Number(value);
        if (!Number.isSafeInteger(limit) || limit <= 0 || limit > this.maxRows) {
            throw exportError('export_limit_invalid', `limit must be an integer between 1 and ${this.maxRows}`);
        }
        return limit;
    }
}

module.exports = {
    CSV_COLUMNS,
    FUEL_CSV_COLUMNS,
    StationExportService,
    escapeCsvCell,
};
