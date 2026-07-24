import CoreMedia
import Foundation
import ScreenCaptureKit
import Vision
import StationOCRCore

@available(iOS 27.0, *)
protocol FrameSource: AnyObject {
    func presentPicker()
    func stop() async
}

@available(iOS 27.0, *)
final class ScreenCaptureKitFrameSource: NSObject, FrameSource, SCStreamOutput, SCStreamDelegate, SCContentSharingPickerObserver {
    private let queue = DispatchQueue(label: "com.datafordidi.mobileocr.capture", qos: .userInitiated)
    private var stream: SCStream?
    private var lastCaptureAt = Date.distantPast
    private var isRecognizing = false
    private let onRows: @Sendable ([OCRRow]) -> Void
    private let onError: @Sendable (String) -> Void

    init(onRows: @escaping @Sendable ([OCRRow]) -> Void, onError: @escaping @Sendable (String) -> Void) {
        self.onRows = onRows
        self.onError = onError
    }

    func presentPicker() {
        let picker = SCContentSharingPicker.shared
        var configuration = SCContentSharingPickerConfiguration()
        configuration.allowedPickerModes = [.singleDisplay]
        picker.defaultConfiguration = configuration
        picker.add(self)
        picker.isActive = true
        picker.present()
    }

    func stop() async {
        try? await stream?.stopCapture()
        stream = nil
        SCContentSharingPicker.shared.remove(self)
        SCContentSharingPicker.shared.isActive = false
    }

    func contentSharingPicker(
        _ picker: SCContentSharingPicker,
        didUpdateWith filter: SCContentFilter,
        for stream: SCStream?
    ) {
        Task {
            do {
                if let stream {
                    try await stream.updateContentFilter(filter)
                    self.stream = stream
                    return
                }
                let configuration = SCStreamConfiguration()
                configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)
                configuration.queueDepth = 3
                configuration.showsCursor = false
                let newStream = SCStream(filter: filter, configuration: configuration, delegate: self)
                try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
                try await newStream.startCapture()
                self.stream = newStream
            } catch {
                onError("屏幕共享启动失败")
            }
        }
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        onError("用户取消了屏幕共享")
    }

    func contentSharingPickerStartDidFailWithError(_ error: Error) {
        onError("屏幕共享启动失败")
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onError("屏幕共享已停止")
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .screen,
              Date().timeIntervalSince(lastCaptureAt) >= 1.5,
              !isRecognizing,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastCaptureAt = Date()
        isRecognizing = true

        let request = VNRecognizeTextRequest { [weak self] request, _ in
            guard let self else { return }
            defer { self.isRecognizing = false }
            let rows = (request.results as? [VNRecognizedTextObservation] ?? []).compactMap {
                observation -> OCRRow? in
                guard let candidate = observation.topCandidates(1).first else { return nil }
                let box = observation.boundingBox
                return OCRRow(
                    text: candidate.string,
                    confidence: Double(candidate.confidence),
                    x: box.minX,
                    y: 1 - box.maxY,
                    width: box.width,
                    height: box.height
                )
            }
            self.onRows(rows)
        }
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false
        do {
            try VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up).perform([request])
        } catch {
            isRecognizing = false
            onError("当前帧识别失败")
        }
    }
}
