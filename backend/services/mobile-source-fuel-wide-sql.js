'use strict';

const ALLOWED_SNAPSHOT_TABLES = new Set([
    'mobile_ocr_station_snapshots',
    'mobile_ocr_fuel_snapshots',
]);

const WIDE_COLUMNS = Object.freeze([
    'wide_record_key',
    'record_kind',
    'source_record_id',
    'source_offer_id',
    'source_quote_id',
    'ingest_batch_id',
    'ingest_id',
    'idempotency_key',
    'source_node',
    'source_agent',
    'source_type',
    'client_version',
    'device_id',
    'agent_report_ip',
    'session_id',
    'page_index',
    'record_index',
    'channel',
    'platform',
    'city',
    'source_stage',
    'station_id',
    'station_name',
    'cp_name',
    'provider_evidence',
    'quality_status',
    'missing_fields',
    'needs_review',
    'fuel_type',
    'grade_code',
    'grade_label',
    'station_price',
    'list_price',
    'display_price',
    'discount_price',
    'national_price',
    'unclassified_price',
    'discount_kind',
    'currency',
    'unit',
    'selected_amount',
    'discount_amount',
    'service_fee',
    'net_discount',
    'payable_amount',
    'offer_index',
    'quote_observation_id',
    'quote_dedup_key',
    'quote_entry',
    'gun_code',
    'gun_label',
    'offer_evidence',
    'station_raw_data',
    'quote_raw_data',
    'captured_at',
    'received_at',
]);

function assertSnapshotTable(snapshotTable) {
    if (!ALLOWED_SNAPSHOT_TABLES.has(snapshotTable)) {
        throw new TypeError('unsupported fuel snapshot table');
    }
    return snapshotTable;
}

function providerEvidenceExpression() {
    return `COALESCE(
        JSON_EXTRACT(s.raw_data, '$.providerEvidence'),
        JSON_EXTRACT(s.raw_data, '$.fuelObservation.providerEvidence')
    )`;
}

function agentReportIpExpression() {
    return `CASE
        WHEN JSON_TYPE(JSON_EXTRACT(b.raw_meta, '$.agentReportIp')) = 'STRING'
        THEN NULLIF(JSON_UNQUOTE(JSON_EXTRACT(b.raw_meta, '$.agentReportIp')), '')
        ELSE NULL
    END`;
}

function quoteSelectExpressions() {
    return [
        `CONCAT('quote:', s.source_record_id, ':', q.quote_dedup_key)`,
        `IF(o.id IS NULL, 'quote-only', 'complete')`,
        's.source_record_id',
        'o.id',
        'q.id',
        's.ingest_batch_id',
        'b.ingest_id',
        'b.idempotency_key',
        's.source_node',
        's.source_agent',
        's.source_type',
        'b.client_version',
        'b.device_id',
        agentReportIpExpression(),
        'b.session_id',
        'b.page_index',
        's.record_index',
        'b.platform',
        'b.platform',
        'b.city',
        's.source_stage',
        's.station_id',
        's.station_name',
        's.provider_name',
        providerEvidenceExpression(),
        's.quality_status',
        's.missing_fields',
        `(q.needs_review = 1 OR (
            s.quality_status IS NOT NULL AND s.quality_status <> 'valid'
        ))`,
        'o.fuel_type',
        'COALESCE(q.grade_code, o.grade_code)',
        'COALESCE(q.grade_label, o.grade_label)',
        'o.station_price',
        'o.list_price',
        'o.display_price',
        'o.discount_price',
        'o.national_price',
        'o.unclassified_price',
        'o.discount_kind',
        'o.currency',
        'o.unit',
        'q.selected_amount',
        'q.gross_discount',
        'q.service_fee',
        'q.net_discount',
        'q.payable_amount',
        'o.offer_index',
        'q.quote_observation_id',
        'q.quote_dedup_key',
        'q.quote_entry',
        'q.gun_code',
        'q.gun_label',
        'o.evidence',
        's.raw_data',
        'q.raw_data',
        'COALESCE(q.captured_at, o.captured_at, s.captured_at)',
        'b.created_at',
    ];
}

function offerSelectExpressions() {
    return [
        `CONCAT('offer:', s.source_record_id, ':', o.offer_index)`,
        `'offer-only'`,
        's.source_record_id',
        'o.id',
        'NULL',
        's.ingest_batch_id',
        'b.ingest_id',
        'b.idempotency_key',
        's.source_node',
        's.source_agent',
        's.source_type',
        'b.client_version',
        'b.device_id',
        agentReportIpExpression(),
        'b.session_id',
        'b.page_index',
        's.record_index',
        'b.platform',
        'b.platform',
        'b.city',
        's.source_stage',
        's.station_id',
        's.station_name',
        's.provider_name',
        providerEvidenceExpression(),
        's.quality_status',
        's.missing_fields',
        `(s.quality_status IS NOT NULL AND s.quality_status <> 'valid')`,
        'o.fuel_type',
        'o.grade_code',
        'o.grade_label',
        'o.station_price',
        'o.list_price',
        'o.display_price',
        'o.discount_price',
        'o.national_price',
        'o.unclassified_price',
        'o.discount_kind',
        'o.currency',
        'o.unit',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'o.offer_index',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'o.evidence',
        's.raw_data',
        'NULL',
        'COALESCE(o.captured_at, s.captured_at)',
        'b.created_at',
    ];
}

function stationSelectExpressions() {
    return [
        `CONCAT('station:', s.source_record_id)`,
        `'station-only'`,
        's.source_record_id',
        'NULL',
        'NULL',
        's.ingest_batch_id',
        'b.ingest_id',
        'b.idempotency_key',
        's.source_node',
        's.source_agent',
        's.source_type',
        'b.client_version',
        'b.device_id',
        agentReportIpExpression(),
        'b.session_id',
        'b.page_index',
        's.record_index',
        'b.platform',
        'b.platform',
        'b.city',
        's.source_stage',
        's.station_id',
        's.station_name',
        's.provider_name',
        providerEvidenceExpression(),
        's.quality_status',
        's.missing_fields',
        `(s.quality_status IS NOT NULL AND s.quality_status <> 'valid')`,
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        'NULL',
        's.raw_data',
        'NULL',
        's.captured_at',
        'b.created_at',
    ];
}

function buildSourcePredicate(options, alias = 's') {
    const predicates = [];
    const parameters = [];
    if (options.requireFuelStationType) predicates.push(`${alias}.station_type = 'fuel'`);
    if (options.sourceRecordId !== undefined) {
        predicates.push(`${alias}.source_record_id = ?`);
        parameters.push(options.sourceRecordId);
    }
    return {
        sql: predicates.length > 0 ? predicates.join(' AND ') : '1 = 1',
        parameters,
    };
}

function selectedOfferJoin() {
    return `
        LEFT JOIN mobile_ocr_fuel_offers o
          ON o.id = (
              SELECT MIN(o2.id)
              FROM mobile_ocr_fuel_offers o2
              WHERE o2.source_record_id = q.source_record_id
                AND o2.grade_code = q.grade_code
          )
    `;
}

function unselectedOfferPredicate() {
    return `
        NOT EXISTS (
            SELECT 1
            FROM mobile_ocr_fuel_quotes q_match
            WHERE q_match.source_record_id = o.source_record_id
              AND q_match.grade_code = o.grade_code
              AND o.id = (
                  SELECT MIN(o2.id)
                  FROM mobile_ocr_fuel_offers o2
                  WHERE o2.source_record_id = q_match.source_record_id
                    AND o2.grade_code = q_match.grade_code
              )
        )
    `;
}

function selectList(expressions) {
    if (expressions.length !== WIDE_COLUMNS.length) {
        throw new Error('fuel wide select column count mismatch');
    }
    return expressions
        .map((expression, index) => `${expression} AS \`${WIDE_COLUMNS[index]}\``)
        .join(',\n            ');
}

function buildWideSelectSql(options = {}) {
    const snapshotTable = assertSnapshotTable(
        options.snapshotTable || 'mobile_ocr_station_snapshots'
    );
    const predicateOptions = {
        requireFuelStationType: options.requireFuelStationType !== false,
        sourceRecordId: options.sourceRecordId,
    };
    const quotePredicate = buildSourcePredicate(predicateOptions);
    const offerPredicate = buildSourcePredicate(predicateOptions);
    const stationPredicate = buildSourcePredicate(predicateOptions);
    const sql = `
        SELECT
            ${selectList(quoteSelectExpressions())}
        FROM ${snapshotTable} s
        INNER JOIN mobile_ocr_ingest_batches b ON b.id = s.ingest_batch_id
        INNER JOIN mobile_ocr_fuel_quotes q ON q.source_record_id = s.source_record_id
        ${selectedOfferJoin()}
        WHERE ${quotePredicate.sql}

        UNION ALL

        SELECT
            ${selectList(offerSelectExpressions())}
        FROM ${snapshotTable} s
        INNER JOIN mobile_ocr_ingest_batches b ON b.id = s.ingest_batch_id
        INNER JOIN mobile_ocr_fuel_offers o ON o.source_record_id = s.source_record_id
        WHERE ${offerPredicate.sql}
          AND ${unselectedOfferPredicate()}

        UNION ALL

        SELECT
            ${selectList(stationSelectExpressions())}
        FROM ${snapshotTable} s
        INNER JOIN mobile_ocr_ingest_batches b ON b.id = s.ingest_batch_id
        WHERE ${stationPredicate.sql}
          AND NOT EXISTS (
              SELECT 1 FROM mobile_ocr_fuel_offers o_none
              WHERE o_none.source_record_id = s.source_record_id
          )
          AND NOT EXISTS (
              SELECT 1 FROM mobile_ocr_fuel_quotes q_none
              WHERE q_none.source_record_id = s.source_record_id
          )
    `;
    return {
        sql,
        parameters: [
            ...quotePredicate.parameters,
            ...offerPredicate.parameters,
            ...stationPredicate.parameters,
        ],
    };
}

function buildWideUpsertSql(options = {}) {
    const selection = buildWideSelectSql(options);
    const mutableColumns = WIDE_COLUMNS.filter(column => column !== 'wide_record_key');
    const updateExpression = column => column === 'agent_report_ip'
        ? `${column} = COALESCE(VALUES(${column}), ${column})`
        : `${column} = VALUES(${column})`;
    return {
        sql: `
            INSERT INTO mobile_ocr_fuel_wide_records (
                ${WIDE_COLUMNS.join(', ')}
            )
            ${selection.sql}
            ON DUPLICATE KEY UPDATE
                ${mutableColumns.map(updateExpression).join(',\n                ')},
                updated_at = CURRENT_TIMESTAMP(3)
        `,
        parameters: selection.parameters,
    };
}

module.exports = {
    ALLOWED_SNAPSHOT_TABLES,
    WIDE_COLUMNS,
    buildWideSelectSql,
    buildWideUpsertSql,
};
