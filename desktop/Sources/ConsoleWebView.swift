import AppKit
import SwiftUI
import UniformTypeIdentifiers
import WebKit

struct ConsoleDestination: Equatable {
    let origin: URL

    static var bundled: ConsoleDestination? {
        guard let file = Bundle.main.url(forResource: "connection-url", withExtension: "txt"),
              let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= 2_048, let address = try? String(contentsOf: file, encoding: .utf8)
        else { return nil }
        return ConsoleDestination(address)
    }

    init?(_ value: String) {
        guard var url = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty, !host.contains(where: \.isWhitespace),
              url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              url.percentEncodedPath.isEmpty || url.percentEncodedPath == "/",
              url.port.map({ (1...65_535).contains($0) }) ?? true else { return nil }
        url.scheme = "https"
        url.host = host.lowercased()
        url.path = "/"
        if url.port == 443 { url.port = nil }
        guard let origin = url.url else { return nil }
        self.origin = origin
    }

    var entryURL: URL { origin.appendingPathComponent("login") }
    var statusURL: URL { origin.appendingPathComponent("api/auth/status") }

    func connectionFailure(_ error: Error) -> String {
        if let probe = error as? ConsoleProbeError { return probe.localizedDescription }
        return ConsoleDirectSettings.originIPv4(for: self) == nil
            ? "请检查云端地址、网络和 HTTPS 证书，然后重试。"
            : "此 Mac 无法直连管理台。请检查 Wi-Fi 或有线网络，以及「云端连接」里保存的服务器 IPv4 地址。"
    }

    func contains(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https"
            && url.host?.lowercased() == origin.host?.lowercased()
            && (url.port ?? 443) == (origin.port ?? 443)
            && url.user == nil && url.password == nil
    }

    func isLoginDocument(_ url: URL?) -> Bool {
        guard let url, contains(url), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return parts.percentEncodedPath == "/login" && parts.percentEncodedQuery == nil && parts.percentEncodedFragment == nil
    }

    func matchesSecurityOrigin(scheme: String, host: String, port: Int) -> Bool {
        let brackets = CharacterSet(charactersIn: "[]")
        return scheme == "https"
            && host.lowercased().trimmingCharacters(in: brackets) == origin.host?.lowercased().trimmingCharacters(in: brackets)
            && (port == 0 ? 443 : port) == (origin.port ?? 443)
    }

    func allowsWeatherPrompt(page: URL?, frame: URL?, isMainFrame: Bool, scheme: String, host: String, port: Int) -> Bool {
        func isConsolePage(_ url: URL?) -> Bool {
            guard let url, contains(url), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
            return ["/", "/admin"].contains(parts.percentEncodedPath) && parts.percentEncodedQuery == nil
        }
        return isMainFrame && isConsolePage(page) && isConsolePage(frame) && matchesSecurityOrigin(scheme: scheme, host: host, port: port)
    }
}

enum ConsoleProbeError: LocalizedError {
    case notMulti
    case redirected
    case serviceUnavailable

    var errorDescription: String? {
        switch self {
        case .notMulti: "此地址未启用多人账号。请确认宇伴云端已升级并开启多人模式。"
        case .redirected: "账号状态接口发生跳转。请填写宇伴管理台实际使用的 HTTPS 根地址。"
        case .serviceUnavailable: "云端账号服务暂时无法响应，请稍后重试。"
        }
    }
}

enum ConsoleProbe {
    private struct Status: Decodable { let multi: Bool }

    static func verify(_ destination: ConsoleDestination, transport: ConsoleTransport) async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = 12
        configuration.timeoutIntervalForResource = 15
        transport.configureSession(configuration)
        let session = URLSession(configuration: configuration, delegate: ProbeDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }

        var request = URLRequest(url: destination.statusURL)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw ConsoleProbeError.serviceUnavailable }
        guard http.url == destination.statusURL, !(300..<400).contains(http.statusCode) else {
            throw ConsoleProbeError.redirected
        }
        guard http.statusCode < 500 else { throw ConsoleProbeError.serviceUnavailable }
        guard http.statusCode == 200, http.mimeType == "application/json" else { throw ConsoleProbeError.notMulti }

        var body = Data()
        for try await byte in bytes {
            guard body.count < 4_096 else { throw ConsoleProbeError.notMulti }
            body.append(byte)
        }
        guard (try? JSONDecoder().decode(Status.self, from: body))?.multi == true else {
            throw ConsoleProbeError.notMulti
        }
    }

    private final class ProbeDelegate: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
            completionHandler(nil)
        }

        func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                        completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            let trust = challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust
            completionHandler(trust ? .performDefaultHandling : .rejectProtectionSpace, nil)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                        completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            urlSession(session, didReceive: challenge, completionHandler: completionHandler)
        }
    }
}

struct ConsoleWebView: NSViewRepresentable {
    private static let loginHandler = "yubanLoginCredential"
    let destination: ConsoleDestination
    let transport: ConsoleTransport
    let didOpenPage: () -> Void
    let reportFailure: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(destination, didOpenPage: didOpenPage, reportFailure: reportFailure) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        transport.configureWebStore(configuration.websiteDataStore)
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: Self.loginHandler)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        context.coordinator.webView = webView
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        context.coordinator.startAccountCheck(transport)
        webView.load(URLRequest(url: destination.entryURL))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.active = false
        coordinator.accountCheck?.cancel()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: loginHandler, contentWorld: .page)
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
        private let destination: ConsoleDestination
        private let didOpenPage: () -> Void
        private let reportFailure: (String) -> Void
        fileprivate var accountCheck: Task<Bool, Never>?
        private var acceptedLoginResponse = false
        private var loginDocument: UUID?
        weak var webView: WKWebView?
        var active = true

        init(_ destination: ConsoleDestination, didOpenPage: @escaping () -> Void, reportFailure: @escaping (String) -> Void) {
            self.destination = destination
            self.didOpenPage = didOpenPage
            self.reportFailure = reportFailure
        }

        // Fetch the login document and verify account mode in parallel. WebKit
        // cannot commit a document or run its scripts until verification passes.
        func startAccountCheck(_ transport: ConsoleTransport) {
            accountCheck = Task { [weak self, destination] in
                do {
                    try await ConsoleProbe.verify(destination, transport: transport)
                    return !Task.isCancelled
                } catch {
                    if !Task.isCancelled, let self, self.active { self.reportFailure(destination.connectionFailure(error)) }
                    return false
                }
            }
        }

        private func permitsCredentialMessage(_ message: WKScriptMessage, in controller: WKUserContentController) -> Bool {
            guard active, let webView, message.webView === webView,
                  controller === webView.configuration.userContentController,
                  message.name == ConsoleWebView.loginHandler, message.frameInfo.isMainFrame,
                  destination.isLoginDocument(webView.url), destination.isLoginDocument(message.frameInfo.request.url)
            else { return false }
            let origin = message.frameInfo.securityOrigin
            return destination.matchesSecurityOrigin(scheme: origin.protocol, host: origin.host, port: origin.port)
        }

        // Spell out the public macOS 27 selector so builds using earlier SDKs can also run on 27.
        @available(macOS 27.0, *)
        @objc(webView:requestGeolocationPermissionForOrigin:initiatedByFrame:decisionHandler:)
        func webView(_ webView: WKWebView, requestGeolocationPermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
            guard active, webView === self.webView, frame.webView === webView,
                  destination.allowsWeatherPrompt(page: webView.url, frame: frame.request.url, isMainFrame: frame.isMainFrame,
                                                  scheme: origin.protocol, host: origin.host, port: origin.port)
            else { return decisionHandler(.deny) }
            decisionHandler(.prompt)
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                                   replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
            let kind = ConsoleWebView.loginHandler
            guard let payload = message.body as? [String: Any], payload["kind"] as? String == kind,
                  let id = payload["id"] as? String, (1...96).contains(id.utf8.count),
                  id.range(of: #"\A[A-Za-z0-9._:-]+\z"#, options: .regularExpression) != nil else {
                return replyHandler(nil, "凭据请求无效。")
            }
            var reply: [String: Any] = ["kind": kind, "id": id, "ok": false]
            guard let document = loginDocument, permitsCredentialMessage(message, in: controller) else {
                return replyHandler(reply, nil)
            }

            switch payload["action"] as? String {
            case "load" where payload.count == 3:
                do {
                    let credential = try ConsoleLoginKeychain.load(for: destination.origin)
                    guard loginDocument == document, permitsCredentialMessage(message, in: controller) else { break }
                    reply["ok"] = true
                    if let credential {
                        reply["username"] = credential.username
                        reply["password"] = credential.password
                    }
                } catch { /* A locked or unreadable keychain leaves manual login available. */ }
            case "save" where payload.count == 5:
                if let username = payload["username"] as? String, let password = payload["password"] as? String,
                   let credential = ConsoleLoginCredential(username: username, password: password) {
                    reply["ok"] = ConsoleLoginKeychain.save(credential, for: destination.origin)
                }
            case "forget" where payload.count == 3:
                reply["ok"] = ConsoleLoginKeychain.forget(for: destination.origin)
            default: break
            }
            replyHandler(reply, nil)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            guard active, let url = navigationAction.request.url else { return decisionHandler(.cancel) }
            let clicked = navigationAction.navigationType == .linkActivated && navigationAction.sourceFrame.isMainFrame
            if navigationAction.targetFrame == nil { return decisionHandler(clicked ? .allow : .cancel) }
            guard navigationAction.targetFrame?.isMainFrame == true else { return decisionHandler(.cancel) }
            if destination.contains(url) {
                if !destination.isLoginDocument(url) { loginDocument = nil }
                return decisionHandler(.allow)
            }
            decisionHandler(.cancel)
            if clicked { openExternal(url) }
            else { reportFailure("管理台尝试跳转到另一个地址。请确认云端连接设置。") }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard active, navigationAction.navigationType == .linkActivated, navigationAction.sourceFrame.isMainFrame,
                  let url = navigationAction.request.url else { return nil }
            if destination.contains(url) { webView.load(navigationAction.request) }
            else { openExternal(url) }
            return nil
        }

        func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping @MainActor ([URL]?) -> Void) {
            guard active, frame.isMainFrame, let source = frame.request.url,
                  destination.contains(source), let window = webView.window else {
                return completionHandler(nil)
            }
            let panel = NSOpenPanel()
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = false
            panel.allowedContentTypes = [.plainText] + ["md", "markdown"].compactMap { UTType(filenameExtension: $0) }
            panel.prompt = "选择"
            panel.beginSheetModal(for: window) { [weak self] result in
                completionHandler(result == .OK && self?.active == true ? panel.urls : nil)
            }
        }

        private func openExternal(_ url: URL) {
            guard ["https", "http"].contains(url.scheme?.lowercased()), url.user == nil, url.password == nil else { return }
            NSWorkspace.shared.open(url)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            guard active, let url = navigationResponse.response.url, destination.contains(url) else {
                return .cancel
            }
            if navigationResponse.isForMainFrame {
                guard await accountCheck?.value == true, active else { return .cancel }
                let response = navigationResponse.response as? HTTPURLResponse
                acceptedLoginResponse = destination.isLoginDocument(url) && response?.mimeType == "text/html"
                    && response.map { (200..<300).contains($0.statusCode) } == true
                if let response, response.statusCode >= 400 {
                    reportFailure("管理台返回 HTTP \(response.statusCode)。请确认部署状态和连接地址。")
                    return .cancel
                }
            }
            return .allow
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            acceptedLoginResponse = false
            loginDocument = nil
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            loginDocument = active && acceptedLoginResponse ? UUID() : nil
            acceptedLoginResponse = false
            if active { didOpenPage() }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            handleNavigationFailure(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            handleNavigationFailure(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            if active { reportFailure("管理台页面意外关闭，请重试。") }
        }

        private func handleNavigationFailure(_ error: Error) {
            let failure = error as NSError
            if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return }
            if active { reportFailure("请检查连接地址、网络和 HTTPS 证书，然后重试。") }
        }

        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                     completionHandler: @escaping @MainActor (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            let space = challenge.protectionSpace
            if space.authenticationMethod == NSURLAuthenticationMethodServerTrust {
                return completionHandler(.performDefaultHandling, nil)
            }
            completionHandler(.cancelAuthenticationChallenge, nil)
            if active, space.authenticationMethod == NSURLAuthenticationMethodHTTPBasic, !space.isProxy(),
               space.host.lowercased() == destination.origin.host?.lowercased(),
               space.port == (destination.origin.port ?? 443) {
                reportFailure("此管理台仍要求旧版口令。请确认云端已开启多人账号。")
            }
        }
    }
}
