'use strict';

/*
 * Sanitized SHOW CREATE TABLE contract captured from the production v4 schema.
 * Index names, AUTO_INCREMENT counters and database-specific metadata are omitted;
 * the migration only relies on the columns represented here.
 */
module.exports = Object.freeze({
    mobile_ocr_ingest_batches: `
        CREATE TABLE mobile_ocr_ingest_batches (
            id bigint unsigned NOT NULL AUTO_INCREMENT,
            ingest_id char(36) NOT NULL,
            platform varchar(64) NOT NULL,
            PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    mobile_ocr_station_snapshots: `
        CREATE TABLE mobile_ocr_station_snapshots (
            source_record_id bigint unsigned NOT NULL AUTO_INCREMENT,
            ingest_batch_id bigint unsigned NOT NULL,
            platform varchar(64) NOT NULL,
            city varchar(128) NOT NULL,
            station_id varchar(191) DEFAULT NULL,
            station_name varchar(512) NOT NULL,
            provider_name varchar(128) DEFAULT NULL,
            captured_at datetime(3) NOT NULL,
            PRIMARY KEY (source_record_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    mobile_ocr_fuel_offers: `
        CREATE TABLE mobile_ocr_fuel_offers (
            id bigint unsigned NOT NULL AUTO_INCREMENT,
            source_record_id bigint unsigned NOT NULL,
            grade_code varchar(32) NOT NULL,
            grade_label varchar(64) NOT NULL,
            display_price decimal(10,4) DEFAULT NULL,
            captured_at datetime(3) NOT NULL,
            PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
    mobile_ocr_fuel_quotes: `
        CREATE TABLE mobile_ocr_fuel_quotes (
            id bigint unsigned NOT NULL AUTO_INCREMENT,
            source_record_id bigint unsigned NOT NULL,
            quote_observation_id varchar(128) NOT NULL,
            grade_code varchar(32) NOT NULL,
            gross_discount decimal(12,2) DEFAULT NULL,
            service_fee decimal(12,2) DEFAULT NULL,
            payable_amount decimal(12,2) DEFAULT NULL,
            needs_review tinyint(1) NOT NULL DEFAULT 0,
            captured_at datetime(3) NOT NULL,
            PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `,
});
