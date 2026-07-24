package com.datafordidi.mobilecollector;

final class StationRecordMerger {
    private StationRecordMerger() {
    }

    static DidiLocalStationParser.StationRecord merge(
            DidiLocalStationParser.StationRecord target,
            DidiLocalStationParser.StationRecord incoming
    ) {
        if (target == null) return incoming;
        if (incoming == null) return target;
        if (target.address == null) target.address = incoming.address;
        if (target.priceFast == null) target.priceFast = incoming.priceFast;
        if (target.priceSlow == null) target.priceSlow = incoming.priceSlow;
        if (target.priceSuper == null) target.priceSuper = incoming.priceSuper;
        if (target.priceService == null) target.priceService = incoming.priceService;
        target.fastIdlePorts = Math.max(target.fastIdlePorts, incoming.fastIdlePorts);
        target.fastTotalPorts = Math.max(target.fastTotalPorts, incoming.fastTotalPorts);
        target.slowIdlePorts = Math.max(target.slowIdlePorts, incoming.slowIdlePorts);
        target.slowTotalPorts = Math.max(target.slowTotalPorts, incoming.slowTotalPorts);
        target.superIdlePorts = Math.max(target.superIdlePorts, incoming.superIdlePorts);
        target.superTotalPorts = Math.max(target.superTotalPorts, incoming.superTotalPorts);
        target.priceObserved |= incoming.priceObserved;
        target.portsObserved |= incoming.portsObserved;
        target.screenRowCount = Math.max(target.screenRowCount, incoming.screenRowCount);
        target.bandRowCount += incoming.bandRowCount;
        target.priceCandidateCount += incoming.priceCandidateCount;
        target.portCandidateCount += incoming.portCandidateCount;
        return target;
    }
}
