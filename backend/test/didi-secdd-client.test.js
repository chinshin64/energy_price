'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    SecddSession,
    Vt,
    computeChallengeM,
    parseChallenge,
    parseSessionRule,
} = require('../../scripts/didi-secdd-client');
const {
    buildPlan,
    createNetworkSender,
    parseArgs,
    resolveOutputPath,
} = require('../../scripts/didi-batch-50');

test('Vt only replaces the trailing session field', () => {
    assert.equal(Vt('3|2.0.34||||||', 'session-a'), '3|2.0.34||||||session-a');
    assert.equal(Vt('3|2.0.34|f|a|1|2|c|', 'session-a'), '3|2.0.34|f|a|1|2|c|session-a');
    assert.equal(Vt('3|2.0.34||||||', ''), '3|2.0.34||||||');
});

test('challenge interpreter computes numeric and concatenated responses', () => {
    assert.equal(computeChallengeM('fb,fc,0', '2,3,4,0,8,2,1'), 15);
    assert.equal(computeChallengeM('fb,fc,1', '2,3,4,0,8,2,1'), '105');
    assert.throws(() => computeChallengeM('eval,fc,0', '2,3,4,0,8,2,1'), /invalid_secdd_func_def/);
});

test('session rule parser preserves scoped server state', () => {
    assert.deepEqual(
        parseSessionRule('domain=energy.xiaojukeji.com; path=/station-api; secch_sessionid=abc=123'),
        { domain: 'energy.xiaojukeji.com', path: '/station-api', secch_sessionid: 'abc=123' }
    );
    assert.equal(parseSessionRule('secch_sessionid=missing-scope'), null);
});

test('direct response rotates authentication and session without logging values', async () => {
    const session = new SecddSession({ now: () => 1_700_000_000_000 });
    const calls = [];
    const result = await session.request({
        buildSignedUrl: () => new URL('https://energy.xiaojukeji.com/station-api/homepage/stationList?wsgsig=fresh'),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        send: async (url, request) => {
            calls.push({ url: String(url), request });
            return {
                status: 200,
                headers: {
                    'secdd-authentication': 'a'.repeat(120),
                    'set-secch-sessionid': 'domain=energy.xiaojukeji.com; path=/station-api; secch_sessionid=s1',
                },
                bodyText: '{"code":10000}',
            };
        },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.headers['secdd-challenge'], '3|2.0.34||||||');
    assert.equal(calls[0].request.headers['secdd-authentication'], '1700000000');
    assert.equal(result.path, 'direct');
    assert.equal(result.authenticationLength, 120);
    assert.equal(result.sessionRuleCount, 1);
    assert.equal(JSON.stringify(result).includes('a'.repeat(120)), false);
});

test('522 response computes M, keeps chid, binds session, and retries once', async () => {
    const session = new SecddSession({ now: () => 1_700_000_000_000 });
    const calls = [];
    const buildUrls = [];
    const result = await session.request({
        buildSignedUrl: () => {
            const url = new URL(`https://energy.xiaojukeji.com/station-api/homepage/stationList?wsgsig=sign-${buildUrls.length + 1}`);
            buildUrls.push(String(url));
            return url;
        },
        method: 'POST',
        headers: {},
        body: '{}',
        send: async (url, request) => {
            calls.push({ url: String(url), request });
            if (calls.length === 1) {
                return {
                    status: 522,
                    headers: {
                        'secdd-authentication': 'b'.repeat(120),
                        'set-secch-sessionid': 'domain=energy.xiaojukeji.com; path=/station-api; secch_sessionid=session-522',
                    },
                    bodyText: JSON.stringify({
                        data: { func: 'f9', func_def: 'fb,fc,0', args: '2,3,4,0,8,2,1', chid: 'chid-9', ts: '1700000001' },
                    }),
                };
            }
            return { status: 200, headers: {}, bodyText: '{"code":10000}' };
        },
    });

    assert.equal(calls.length, 2);
    assert.notEqual(buildUrls[0], buildUrls[1]);
    assert.equal(
        calls[1].request.headers['secdd-challenge'],
        '3|2.0.34|f9|2,3,4,0,8,2,1|1700000001|15|chid-9|session-522'
    );
    assert.equal(calls[1].request.headers['secdd-authentication'], 'b'.repeat(120));
    assert.equal(result.path, '522_challenge_response');
    assert.equal(result.attemptCount, 2);
});

test('malformed 522 fails closed before a second request', async () => {
    assert.throws(
        () => parseChallenge({ status: 522, bodyText: '{"data":{"func":"f"}}' }),
        /incomplete_secdd_challenge/
    );
    const session = new SecddSession();
    let requestCount = 0;
    await assert.rejects(
        session.request({
            buildSignedUrl: () => new URL('https://energy.xiaojukeji.com/station-api/homepage/stationList?wsgsig=x'),
            method: 'POST', headers: {}, body: '{}',
            send: async () => {
                requestCount++;
                return { status: 522, headers: {}, bodyText: '{"data":{"func":"f"}}' };
            },
        }),
        /incomplete_secdd_challenge/
    );
    assert.equal(requestCount, 1);
});

test('Agent mode keeps a strict HTTP budget and isolated output files', async () => {
    const args = parseArgs(['node', 'script', '--agent-test', '--total', '4', '--agent-http-limit', '2', '--proxy-url', 'http://127.0.0.1:1']);
    assert.equal(args.agentTest, true);
    assert.equal(args.total, 4);
    assert.equal(args.agentHttpLimit, 2);
    assert.equal(args.writeDb, false);
    assert.deepEqual(buildPlan({ total: 1, city: '上海市' }), [
        { city: '上海市', seedName: '人民广场', lat: 31.2336, lng: 121.4691, pageNo: 1 },
    ]);
    assert.equal(resolveOutputPath(args, '20260714180000'), '/private/tmp/didi-batch-agent-test-20260714180000.json');

    const usage = { count: args.agentHttpLimit };
    const send = createNetworkSender(args, usage);
    await assert.rejects(
        send(new URL('https://example.test'), { method: 'GET', headers: {} }),
        /agent_test_http_request_limit_exceeded/
    );
    assert.equal(usage.count, args.agentHttpLimit);
});
