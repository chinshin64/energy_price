import Foundation

enum AppConfiguration {
    static let sourceAgent = "ios-ocr-agent"
    static let clientVersion = "ios-ocr-2.0.0"
    private static let managedConfigurationKey = "com.apple.configuration.managed"
    private static let managedEndpointKey = "MobileIngestURL"

    static func endpoint(defaults: UserDefaults = .standard) -> URL? {
        guard let managed = defaults.dictionary(forKey: managedConfigurationKey),
              let rawValue = managed[managedEndpointKey] as? String else {
            return nil
        }
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : URL(string: value)
    }

    static func installId(defaults: UserDefaults = .standard) -> String {
        identifier(key: "collector.install-id", prefix: "ios-install", defaults: defaults)
    }

    static func deviceSessionId(defaults: UserDefaults = .standard) -> String {
        identifier(key: "collector.device-session-id", prefix: "ios-device-session", defaults: defaults)
    }

    static func selectedCity(defaults: UserDefaults = .standard) -> String {
        let city = defaults.string(forKey: "collector.city")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return city.isEmpty ? "城市待识别" : city
    }

    static func saveSelectedCity(_ city: String, defaults: UserDefaults = .standard) {
        let value = city.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty {
            defaults.removeObject(forKey: "collector.city")
        } else {
            defaults.set(value, forKey: "collector.city")
        }
    }

    private static func identifier(key: String, prefix: String, defaults: UserDefaults) -> String {
        if let existing = defaults.string(forKey: key), !existing.isEmpty { return existing }
        let value = "\(prefix)-\(UUID().uuidString.lowercased())"
        defaults.set(value, forKey: key)
        return value
    }
}
