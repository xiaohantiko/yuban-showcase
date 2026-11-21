import Foundation

@main
struct DirectRouteTests {
    static func main() {
        checkWeatherPermission()
        guard #available(macOS 14, *) else {
            print("Direct routing requires macOS 14 or later.")
            return
        }
        checkSettings()
        checkAdmission()
        print("Passed console location permission, exact-origin settings and CONNECT admission checks.")
    }

    static func checkWeatherPermission() {
        let target = ConsoleDestination("https://example.com")!
        let console = "https://example.com/admin#companionship"
        func allows(page: String = console, frame: String = console, main: Bool = true,
                    scheme: String = "https", host: String = "example.com", port: Int = 0) -> Bool {
            target.allowsWeatherPrompt(page: URL(string: page), frame: URL(string: frame), isMainFrame: main,
                                       scheme: scheme, host: host, port: port)
        }
        precondition(allows())
        precondition(allows(page: "https://example.com/#companionship", frame: "https://example.com/", port: 443))
        precondition(!allows(main: false))
        precondition(!allows(scheme: "http") && !allows(host: "yuban.example.com") && !allows(port: 8443))
        var userURL = URLComponents(url: target.origin, resolvingAgainstBaseURL: false)!
        userURL.user = "example"
        for forbidden in ["http://example.com/", "https://yuban.example.com/", "https://example.com:8443/",
                          userURL.url!.absoluteString, "https://example.com/login", "https://example.com/admin?q=1", "about:blank"] {
            precondition(!allows(page: forbidden) && !allows(frame: forbidden))
        }
        if #available(macOS 27.0, *) {
            let selector = NSSelectorFromString("webView:requestGeolocationPermissionForOrigin:initiatedByFrame:decisionHandler:")
            precondition(ConsoleWebView.Coordinator.instancesRespond(to: selector))
        }
    }

    @available(macOS 14, *)
    static func checkSettings() {
        let suite = "com.yuban.route-tests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        let target = ConsoleDestination("https://example.com")!
        let same = ConsoleDestination("HTTPS://EXAMPLE.COM:443/")!
        let sibling = ConsoleDestination("https://example.invalid")!
        let subdomain = ConsoleDestination("https://yuban.example.com")!
        let otherPort = ConsoleDestination("https://example.com:8443")!
        let address = "192.0.2.44"
        func route(_ site: ConsoleDestination) -> String? {
            ConsoleDirectSettings.originIPv4(for: site, defaults: defaults)
        }

        precondition(route(target) == nil)
        for invalid in ["no-address", "0.0.0.0", "127.0.0.1", "169.254.1.1", "198.18.0.1", "224.0.0.1"] {
            ConsoleDirectSettings.save(invalid, for: target, defaults: defaults)
            precondition(route(target) == nil)
        }
        ConsoleDirectSettings.save(address, for: otherPort, defaults: defaults)
        precondition(route(otherPort) == nil && route(target) == nil)
        ConsoleDirectSettings.save(address, for: target, defaults: defaults)
        precondition(route(same) == address)
        precondition(route(sibling) == nil && route(subdomain) == nil && route(otherPort) == nil)
        ConsoleDirectSettings.save("", for: sibling, defaults: defaults)
        precondition(route(target) == address)
        ConsoleDirectSettings.save("", for: same, defaults: defaults)
        precondition(route(target) == nil)
    }

    @available(macOS 14, *)
    static func checkAdmission() {
        let host = "example.com"
        func token() -> String {
            Data(("console:" + UUID().uuidString).utf8).base64EncodedString()
        }
        let current = token()
        let previous = token()
        let credential = "Proxy-Authorization: Basic " + current
        func status(_ authority: String, _ fields: [String], method: String = "CONNECT") -> Int {
            let lines = ["\(method) \(authority) HTTP/1.1"] + fields
            return ExactRelay.connectStatus(header: lines.joined(separator: "\r\n"), host: host, basicToken: current)
        }

        let allowed = host + ":443"
        precondition(status(allowed, ["Host: " + allowed, credential]) == 200)
        precondition(status(allowed.uppercased(), ["Host: " + host, credential]) == 200)
        precondition(status(allowed, ["Host: " + allowed]) == 407)
        precondition(status(allowed, ["Proxy-Authorization: Basic " + previous]) == 407)
        precondition(status(allowed, [credential, credential]) == 400)
        precondition(status(allowed, ["Host: example.invalid", credential]) == 403)
        for authority in [host, host + ":80", host + ":8443", "sub." + allowed, "example.invalid:443"] {
            precondition(status(authority, [credential]) == 403)
        }
        precondition(status(allowed, [credential], method: "GET") == 403)
    }
}
