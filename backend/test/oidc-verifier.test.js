'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { OidcJwtVerifier } = require('../services/oidc-verifier');

const ISSUER = 'https://identity.example.test/tenant';
const AUDIENCE = 'blue-team-product';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'test-key-1',
    use: 'sig',
    alg: 'RS256'
};

function signJwt(claimOverrides = {}, headerOverrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', kid: publicJwk.kid, ...headerOverrides };
    const claims = {
        iss: ISSUER,
        sub: 'user-123',
        aud: AUDIENCE,
        iat: now,
        nbf: now - 1,
        exp: now + 300,
        roles: ['operator'],
        ...claimOverrides
    };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signingInput = `${encodedHeader}.${encodedClaims}`;
    const signature = crypto.sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url');
    return `${signingInput}.${signature}`;
}

function createVerifier(keys = [publicJwk]) {
    return new OidcJwtVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUri: 'https://identity.example.test/.well-known/jwks.json',
        algorithms: ['RS256'],
        fetch: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ keys })
        })
    });
}

test('校验 OIDC JWT 的签名、发行方、受众和时效', async () => {
    const result = await createVerifier().verify(signJwt());
    assert.equal(result.claims.sub, 'user-123');
    assert.equal(result.header.kid, publicJwk.kid);
});

test('拒绝错误受众、过期时间和不精确的发行方', async () => {
    const verifier = createVerifier();
    await assert.rejects(() => verifier.verify(signJwt({ aud: 'other-product' })), /audience/);
    await assert.rejects(() => verifier.verify(signJwt({ exp: 1 })), /expired/);
    await assert.rejects(() => verifier.verify(signJwt({ iss: `${ISSUER}/` })), /issuer/);
});

test('拒绝未允许算法、签名篡改和非签名用途密钥', async () => {
    const unsignedParts = signJwt({}, { alg: 'none' }).split('.');
    await assert.rejects(() => createVerifier().verify(unsignedParts.join('.')), /algorithm/);

    const signed = signJwt();
    const [header, payload, signature] = signed.split('.');
    const tamperedClaims = {
        ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
        sub: 'attacker'
    };
    const tampered = `${header}.${Buffer.from(JSON.stringify(tamperedClaims)).toString('base64url')}.${signature}`;
    await assert.rejects(() => createVerifier().verify(tampered), /signature/);

    await assert.rejects(
        () => createVerifier([{ ...publicJwk, use: 'enc' }]).verify(signed),
        /No matching/
    );
});

test('多个受众时要求 azp 精确匹配当前产品', async () => {
    await assert.rejects(
        () => createVerifier().verify(signJwt({ aud: [AUDIENCE, 'another'], azp: 'another' })),
        /authorized party/
    );
    const result = await createVerifier().verify(signJwt({
        aud: [AUDIENCE, 'another'],
        azp: AUDIENCE
    }));
    assert.equal(result.claims.azp, AUDIENCE);
});
