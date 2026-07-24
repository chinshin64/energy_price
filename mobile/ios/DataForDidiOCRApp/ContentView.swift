import SwiftUI
import StationOCRCore

struct ContentView: View {
    @StateObject private var model = CaptureViewModel()
    private let cardPresenter = StationCardPresenter()

    var body: some View {
        NavigationStack {
            List {
                Section("采集") {
                    Picker("城市", selection: Binding(
                        get: { model.selectedCity },
                        set: model.selectCity
                    )) {
                        ForEach(CaptureViewModel.cityOptions, id: \.self, content: Text.init)
                    }
                    Text(model.status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button(model.isCapturing ? "停止识别" : "开始识别") {
                        model.isCapturing ? model.stop() : model.start()
                    }
                    .tint(model.isCapturing ? .red : .orange)
                    if model.pendingCount > 0 {
                        Button("重试回传（\(model.pendingCount)）", action: model.retryPending)
                    }
                    if model.attentionCount > 0 {
                        Text("需人工处理：\(model.attentionCount)")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    if model.results.isEmpty {
                        Text("尚未识别到场站").foregroundStyle(.secondary)
                    }
                    ForEach(model.results) { item in
                        let card = cardPresenter.present(item)
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(card.nameText)
                                    .font(.headline)
                                    .foregroundStyle(card.isNameMissing ? .orange : .primary)
                                Spacer()
                                Text(card.stationTypeText)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Text(card.addressText)
                                .font(.subheadline)
                                .foregroundStyle(card.isAddressMissing ? .orange : .secondary)
                            Text(card.portText)
                            ForEach(Array(card.priceLines.enumerated()), id: \.offset) { _, line in
                                Text(line)
                            }
                            if let missingFieldsText = card.missingFieldsText {
                                Text(missingFieldsText)
                                    .font(.caption)
                                    .foregroundStyle(.orange)
                            }
                            HStack {
                                Text(card.sourceAgentText)
                                Spacer()
                                Text(card.syncText)
                                    .foregroundStyle(syncColor(card.syncTone))
                            }
                            .font(.caption)
                            Text(card.capturedAtText)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                    if !model.results.isEmpty {
                        Button("清空本地展示", role: .destructive, action: model.clearCompleted)
                    }
                } header: {
                    Text("当前已获取数据（\(model.results.count)）")
                }
            }
            .navigationTitle("信息自动识别")
        }
    }

    private func syncColor(_ tone: StationCardSyncTone) -> Color {
        switch tone {
        case .pending: .orange
        case .success: .green
        case .failure: .red
        }
    }
}
