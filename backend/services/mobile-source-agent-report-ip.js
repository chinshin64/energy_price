'use strict';

const net = require('node:net');

const IPV4_MAPPED_PATTERN = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function ipv6Groups(address) {
    const halves = address.toLowerCase().split('::');
    if (halves.length > 2) return null;
    const parseHalf = half => {
        const groups = half ? half.split(':') : [];
        const embeddedIpv4 = groups.at(-1);
        if (!embeddedIpv4?.includes('.')) return groups;
        if (net.isIP(embeddedIpv4) !== 4) return null;
        const octets = embeddedIpv4.split('.').map(Number);
        return [
            ...groups.slice(0, -1),
            ((octets[0] << 8) | octets[1]).toString(16),
            ((octets[2] << 8) | octets[3]).toString(16),
        ];
    };
    const head = parseHalf(halves[0]);
    const tail = parseHalf(halves.length === 2 ? halves[1] : '');
    if (!head || !tail) return null;
    const missing = 8 - head.length - tail.length;
    if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
    return [
        ...head,
        ...Array(halves.length === 2 ? missing : 0).fill('0'),
        ...tail,
    ].map(group => Number.parseInt(group, 16));
}

function normalizeHexMappedIpv4(candidate) {
    const groups = ipv6Groups(candidate);
    if (!groups || groups.length !== 8
            || groups.slice(0, 5).some(group => group !== 0)
            || groups[5] !== 0xffff) {
        return null;
    }
    return [
        groups[6] >> 8,
        groups[6] & 0xff,
        groups[7] >> 8,
        groups[7] & 0xff,
    ].join('.');
}

function normalizeIpAddress(value) {
    if (typeof value !== 'string') return null;
    const candidate = value.trim();
    if (!candidate || candidate.includes(',') || candidate.includes('%')) return null;
    const mapped = IPV4_MAPPED_PATTERN.exec(candidate);
    if (mapped && net.isIP(mapped[1]) === 4) return mapped[1];
    const family = net.isIP(candidate);
    if (family === 4) return candidate;
    if (family === 6) {
        return normalizeHexMappedIpv4(candidate) || candidate.toLowerCase();
    }
    return null;
}

function isTrustedProxyPeer(req) {
    const peer = req?.socket?.remoteAddress;
    const trust = req?.app?.get?.('trust proxy fn');
    if (!peer || typeof trust !== 'function') return false;
    try {
        return Boolean(trust(peer, 0));
    } catch (error) {
        return false;
    }
}

function resolveAgentReportIp(req) {
    const connectionIp = normalizeIpAddress(req?.socket?.remoteAddress);
    if (!isTrustedProxyPeer(req)) return connectionIp;
    const cloudflareIp = normalizeIpAddress(req?.headers?.['cf-connecting-ip']);
    return cloudflareIp || connectionIp;
}

module.exports = {
    isTrustedProxyPeer,
    normalizeIpAddress,
    normalizeHexMappedIpv4,
    resolveAgentReportIp,
};
