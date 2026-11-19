import Foundation
import WebKit

struct ConsoleDirectSettings {
    private static let key = "consoleDirectRoute"

    static func originIPv4(for destination: ConsoleDestination, defaults: UserDefaults = .standard) -> String? {
        guard destination.origin.port == nil, let host = destination.origin.host,
              let rule = defaults.dictionary(forKey: key),
              rule["host"] as? String == host, let address = rule["ipv4"] as? String else { return nil }
        return address
    }

    static func save(_ address: String, for destination: ConsoleDestination, defaults: UserDefaults = .standard) {
        guard destination.origin.port == nil, let host = destination.origin.host else { return }
        if address.isEmpty {
            if originIPv4(for: destination, defaults: defaults) != nil { defaults.removeObject(forKey: key) }
        } else if #available(macOS 14, *), ExactRelay.isUsableOriginIPv4(address) {
            defaults.set(["host": host, "ipv4": address], forKey: key)
        }
    }
}

struct ConsoleTransport {
    var configureSession: @Sendable (URLSessionConfiguration) -> Void = { _ in }
    var configureWebStore: @MainActor @Sendable (WKWebsiteDataStore) -> Void = { _ in }

    static func prepare(for destination: ConsoleDestination) async throws -> ConsoleTransport {
        guard #available(macOS 14, *), let host = destination.origin.host,
              let address = ConsoleDirectSettings.originIPv4(for: destination) else { return ConsoleTransport() }
        let relay = try await ExactRelay.start(host: host, originIPv4: address)
        return ConsoleTransport(
            configureSession: { $0.proxyConfigurations = [relay.proxyConfiguration] },
            configureWebStore: { $0.proxyConfigurations = [relay.proxyConfiguration] }
        )
    }
}
