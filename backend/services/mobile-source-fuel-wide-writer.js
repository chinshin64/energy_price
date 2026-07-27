'use strict';

const { buildWideUpsertSql } = require('./mobile-source-fuel-wide-sql');

class MobileSourceFuelWideWriter {
    constructor(options = {}) {
        this.snapshotTable = options.snapshotTable || 'mobile_ocr_station_snapshots';
        this.requireFuelStationType = options.requireFuelStationType !== false;
    }

    async upsertSourceRecord(connection, sourceRecordId) {
        if (!connection || typeof connection.execute !== 'function') {
            throw new TypeError('fuel wide writer requires the ingest transaction connection');
        }
        const normalizedId = Number(sourceRecordId);
        if (!Number.isSafeInteger(normalizedId) || normalizedId <= 0) {
            throw new TypeError('fuel wide writer requires a positive source record id');
        }
        const statement = buildWideUpsertSql({
            snapshotTable: this.snapshotTable,
            requireFuelStationType: this.requireFuelStationType,
            sourceRecordId: normalizedId,
        });
        const [result] = await connection.execute(statement.sql, statement.parameters);
        return {
            affectedRows: Number(result?.affectedRows) || 0,
            sourceRecordId: normalizedId,
        };
    }
}

module.exports = {
    MobileSourceFuelWideWriter,
};
