'use strict';

const path = require('node:path');

function resolveDatabasePath(env = process.env, projectRoot = path.resolve(__dirname, '../..')) {
    const configured = String(env.DATABASE_PATH || '').trim();
    if (configured === ':memory:') return configured;
    return configured
        ? path.resolve(projectRoot, configured)
        : path.join(projectRoot, 'data', 'stations.db');
}

module.exports = { resolveDatabasePath };
