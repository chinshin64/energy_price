#!/usr/bin/env node
'use strict';

const BrowserSigner = require('../services/browser-signer');

function summarize(platform, result) {
    if (typeof result === 'string') {
        return {
            platform,
            success: result.length > 0,
            resultType: 'string',
            resultLength: result.length,
            format: platform === 'didi'
                ? (/^dd\d*-/i.test(result) ? 'wsgsig' : 'unknown')
                : (/^[a-f\d]+$/i.test(result) ? 'hex' : 'string')
        };
    }
    if (result && typeof result === 'object') {
        return {
            platform,
            success: true,
            resultType: 'object',
            fields: Object.keys(result).sort(),
            fieldLengths: Object.fromEntries(
                Object.entries(result).map(([key, value]) => [key, String(value ?? '').length])
            )
        };
    }
    return { platform, success: false, resultType: typeof result };
}

function buildValidationCases() {
    const timestampMs = Date.now();
    const timestampSeconds = String(Math.floor(timestampMs / 1000));
    const starChargeParams = {
        lat: 31.2304,
        lng: 121.4737,
        nonce: 'browser-signer-validation',
        page: 1,
        pagecount: 10,
        timestamp: timestampMs
    };
    return {
        didi: {
            contentType: 'application/json',
            paramsString: 'source=2&ttid=wx',
            body: {
                source: 2,
                pageNo: 1,
                pageSize: 10,
                lat: 34.261005,
                lng: 108.942336,
                userlat: 34.261005,
                userlng: 108.942336
            },
            noDomainCheck: true,
            signUpgrade: false
        },
        teld: { key: 'yBb6fQbbiHx3g6Me', sts: timestampSeconds },
        'star-charge': {
            signatureParams: starChargeParams,
            plaintext: Object.keys(starChargeParams)
                .map(key => `${key}=${encodeURIComponent(starChargeParams[key])}`)
                .join('&'),
            publicKey: '04BF7E8F5399634458895E49D71CD042C32BA22773EC929DCD8E9228BDF877F0929AAE8B12B7FCDF25D2BF63517CD23AC2737A9C78958BB0849C767DE4FC1A29CA',
            cipherMode: 0
        },
        kuaidian: {
            app_key: 'kd_prod_mp',
            app_terminal: 'mp',
            pageIndex: '1',
            timestamp: String(timestampMs),
            token: ''
        },
        tuanyou: {
            app_key: 'mp1.0',
            oilNo: '92',
            timestamp: String(timestampMs),
            token: ''
        },
        xdt: {
            data: { encryptData: 'browser-signer-validation' },
            initNonceStr: 'browser-signer-validation'
        }
    };
}

async function main() {
    const signer = new BrowserSigner();
    const results = [];
    try {
        const status = await signer.init();
        const cases = buildValidationCases();
        for (const platform of BrowserSigner.SUPPORTED_PLATFORMS) {
            if (!status.platforms[platform]?.available) {
                results.push({
                    platform,
                    success: false,
                    error: status.platforms[platform]?.error || 'unavailable'
                });
                continue;
            }
            try {
                results.push(summarize(platform, await signer.sign(platform, cases[platform])));
            } catch (error) {
                results.push({
                    platform,
                    success: false,
                    error: String(error.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 160)
                });
            }
        }
    } finally {
        await signer.close();
    }

    const success = results.length === BrowserSigner.SUPPORTED_PLATFORMS.length
        && results.every(result => result.success);
    process.stdout.write(`${JSON.stringify({
        success,
        mode: 'offline-browser-rendering',
        networkRequestsAllowed: false,
        results
    }, null, 2)}\n`);
    if (!success) process.exitCode = 1;
}

main().catch(error => {
    process.stderr.write(`${JSON.stringify({
        success: false,
        error: String(error.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 200)
    })}\n`);
    process.exitCode = 1;
});
