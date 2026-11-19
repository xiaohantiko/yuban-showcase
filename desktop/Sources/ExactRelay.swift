import Foundation
import Network

/// A credentialed CONNECT listener for one HTTPS origin. TLS remains between
/// URLSession/WebKit and the original server. Nothing here reads TLS contents.
@available(macOS 14.0, *)
final class ExactRelay: @unchecked Sendable {
    let proxyConfiguration: ProxyConfiguration
    private let server: Server

    private init(server: Server, port: NWEndpoint.Port) {
        self.server = server
        var proxy = ProxyConfiguration(httpCONNECTProxy: .hostPort(host: .ipv4(.loopback), port: port))
        proxy.matchDomains = [server.host]
        proxy.allowFailover = false
        proxy.applyCredential(username: server.username, password: server.password)
        self.proxyConfiguration = proxy
    }

    static func start(host: String, originIPv4: String) async throws -> ExactRelay {
        let server = try Server(host: host, originIPv4: originIPv4)
        return try await withTaskCancellationHandler {
            let port: NWEndpoint.Port = try await withCheckedThrowingContinuation { continuation in
                server.begin(continuation)
            }
            try Task.checkCancellation()
            return ExactRelay(server: server, port: port)
        } onCancel: {
            server.stop()
        }
    }

    static func isUsableOriginIPv4(_ raw: String) -> Bool {
        let parts = raw.split(separator: ".", omittingEmptySubsequences: false)
        let bytes = parts.compactMap { UInt8($0) }
        guard parts.count == 4, bytes.count == 4,
              zip(parts, bytes).allSatisfy({ String($0.1) == $0.0 }) else { return false }
        let (a, b) = (bytes[0], bytes[1])
        // A user may deliberately host on a private LAN. Unspecified, loopback,
        // link-local, benchmarking/fake-IP, multicast and reserved space cannot
        // be pinned as a remote unicast origin.
        return a != 0 && a != 127 && a < 224 && !(a == 169 && b == 254)
            && !(a == 198 && (b == 18 || b == 19))
    }

    /// Status for the ASCII request head, without its terminating CRLFCRLF.
    /// Keeping this independent from the socket lets CI exercise rejected
    /// requests without opening an upstream connection or using real credentials.
    static func connectStatus(header: String, host: String, basicToken: String) -> Int {
        ConnectHead.status(header, host: host, token: basicToken)
    }

    func stop() { server.stop() }
    deinit { server.stop() }
}

private enum ConnectHead {
    static func status(_ header: String, host: String, token: String) -> Int {
        guard header.utf8.count <= 8_188, !token.isEmpty else { return 400 }
        let lines = header.components(separatedBy: "\r\n")
        let request = lines[0].components(separatedBy: " ")
        let authority = host + ":443"
        guard request.count == 3, request[0] == "CONNECT",
              request[1].lowercased() == authority, ["HTTP/1.1", "HTTP/1.0"].contains(request[2]) else { return 403 }
        var authorization: String?
        var hostHeader: String?
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex,
                  line[..<colon].utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0)
                      || (48...57).contains($0) || $0 == 45 }) else { return 400 }
            let field = line[line.index(after: colon)...]
            guard field.utf8.allSatisfy({ $0 == 9 || (32...126).contains($0) }) else { return 400 }
            let value = field.trimmingCharacters(in: .whitespaces)
            switch line[..<colon].lowercased() {
            case "proxy-authorization":
                guard authorization == nil else { return 400 }
                authorization = value
            case "host":
                guard hostHeader == nil else { return 400 }
                hostHeader = value.lowercased()
            case "content-length":
                if value != "0" { return 400 }
            case "transfer-encoding":
                return 400
            default: break
            }
        }
        guard hostHeader == nil || hostHeader == authority || hostHeader == host else { return 403 }
        guard let auth = authorization, auth.count == token.count + 6,
              auth.prefix(6).lowercased() == "basic ", auth.dropFirst(6) == token else { return 407 }
        return 200
    }
}

private enum RelayError: Error {
    case invalidEndpoint, unavailable
}

private final class Server: @unchecked Sendable {
    let host: String
    let username = "console"
    let password = UUID().uuidString + UUID().uuidString
    let queue = DispatchQueue(label: "com.yuban.exact-origin")
    let origin: IPv4Address
    private let listener: NWListener
    private let monitors = [NWPathMonitor(requiredInterfaceType: .wifi), NWPathMonitor(requiredInterfaceType: .wiredEthernet)]
    private let kinds: [NWInterface.InterfaceType] = [.wifi, .wiredEthernet]
    private var paths = [NWInterface.InterfaceType: NWPath]()
    private var boundPort: NWEndpoint.Port?
    private var ready: CheckedContinuation<NWEndpoint.Port, Error>?
    private var stopped = false
    private var tunnels = [UUID: Tunnel]()

    init(host: String, originIPv4: String) throws {
        let hostname = host.lowercased()
        let labels = hostname.split(separator: ".", omittingEmptySubsequences: false)
        guard hostname.utf8.count <= 253, labels.count >= 2, labels.allSatisfy({ label in
            !label.isEmpty && label.utf8.count <= 63 && !label.hasPrefix("-") && !label.hasSuffix("-")
                && label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
        }), #available(macOS 14, *), ExactRelay.isUsableOriginIPv4(originIPv4),
            let ip = IPv4Address(originIPv4) else {
            throw RelayError.invalidEndpoint
        }
        self.host = hostname
        self.origin = ip
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        parameters.acceptLocalOnly = true
        self.listener = try NWListener(using: parameters)
    }

    func begin(_ result: CheckedContinuation<NWEndpoint.Port, Error>) {
        queue.async { [self] in
            guard !self.stopped else { result.resume(throwing: CancellationError()); return }
            self.ready = result
            for (monitor, kind) in zip(self.monitors, self.kinds) {
                monitor.pathUpdateHandler = { [weak self] path in
                    guard let self, !self.stopped else { return }
                    self.paths[kind] = path
                    self.finishStarting()
                }
                monitor.start(queue: self.queue)
            }
            self.listener.newConnectionHandler = { [weak self] connection in
                guard let self, !self.stopped, self.tunnels.count < 32,
                      case .hostPort(let host, _) = connection.endpoint, host == .ipv4(.loopback) else {
                    connection.cancel()
                    return
                }
                let id = UUID()
                let tunnel = Tunnel(id: id, client: connection, server: self)
                self.tunnels[id] = tunnel
                tunnel.begin()
            }
            self.listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    self.boundPort = self.listener.port
                    self.finishStarting()
                case .failed, .cancelled:
                    self.shutdown()
                default: break
                }
            }
            self.listener.start(queue: self.queue)
            self.queue.asyncAfter(deadline: .now() + 5) { [weak self] in
                if self?.ready != nil { self?.shutdown() }
            }
        }
    }

    // Only attempt interfaces the OS identifies as physical Ethernet or Wi-Fi.
    // An unsatisfied physical path is a failure; never open an unscoped socket.
    func physicalInterfaces() -> [NWInterface] {
        kinds.compactMap { kind in
            guard let path = paths[kind], path.status == .satisfied else { return nil }
            return path.availableInterfaces.first { $0.type == kind }
        }
    }

    private func finishStarting() {
        guard let continuation = ready, let port = boundPort, !physicalInterfaces().isEmpty else { return }
        ready = nil
        continuation.resume(returning: port)
    }

    func remove(_ id: UUID) { tunnels.removeValue(forKey: id) }

    func stop() { queue.async { self.shutdown() } }

    private func shutdown() {
        guard !stopped else { return }
        stopped = true
        ready?.resume(throwing: RelayError.unavailable)
        ready = nil
        listener.cancel()
        monitors.forEach { $0.cancel() }
        for tunnel in Array(tunnels.values) { tunnel.close() }
    }
}

private final class Tunnel: @unchecked Sendable {
    private let id: UUID
    private let client: NWConnection
    private unowned let server: Server
    private var upstream: NWConnection?
    private var collecting = Data()
    private var closed = false
    private var established = false
    private var finishedReads = 0
    private let separator = Data([13, 10, 13, 10])
    private let maxHeader = 8_192

    init(id: UUID, client: NWConnection, server: Server) {
        self.id = id
        self.client = client
        self.server = server
    }

    func begin() {
        client.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready: self.readRequest()
            case .failed, .cancelled: self.close()
            default: break
            }
        }
        client.start(queue: server.queue)
        server.queue.asyncAfter(deadline: .now() + 12) { [weak self] in
            if self?.established == false { self?.close() }
        }
    }

    private func readRequest() {
        client.receive(minimumIncompleteLength: 1, maximumLength: maxHeader + 4096) { [weak self] data, _, eof, error in
            guard let self, !self.closed else { return }
            guard error == nil else { self.close(); return }
            if let data { self.collecting.append(data) }
            guard let end = self.collecting.range(of: self.separator) else {
                if self.collecting.count >= self.maxHeader || eof { self.replyAndClose("400 Bad Request") }
                else { self.readRequest() }
                return
            }
            guard end.upperBound <= self.maxHeader,
                  let header = String(data: self.collecting[..<end.lowerBound], encoding: .ascii) else {
                self.replyAndClose("400 Bad Request"); return
            }
            let early = Data(self.collecting[end.upperBound...])
            self.collecting.removeAll()
            let token = Data((self.server.username + ":" + self.server.password).utf8).base64EncodedString()
            switch ConnectHead.status(header, host: self.server.host, token: token) {
            case 200: break
            case 403: self.replyAndClose("403 Forbidden"); return
            case 407: self.replyAndClose("407 Proxy Authentication Required", authenticate: true); return
            default: self.replyAndClose("400 Bad Request"); return
            }
            self.connect(self.server.physicalInterfaces()[...], early: early, eof: eof)
        }
    }

    private func replyAndClose(_ status: String, authenticate: Bool = false) {
        let challenge = authenticate ? "Proxy-Authenticate: Basic realm=\"Yuban local relay\"\r\n" : ""
        let response = "HTTP/1.1 " + status + "\r\n" + challenge + "Content-Length: 0\r\nConnection: close\r\n\r\n"
        client.send(content: Data(response.utf8), contentContext: .finalMessage, isComplete: true,
                    completion: .contentProcessed { [weak self] _ in self?.close() })
    }

    private func connect(_ interfaces: ArraySlice<NWInterface>, early: Data, eof: Bool) {
        guard let interface = interfaces.first else { replyAndClose("502 Bad Gateway"); return }
        let parameters = NWParameters.tcp
        parameters.requiredInterface = interface
        parameters.preferNoProxies = true
        let origin = NWConnection(host: .ipv4(server.origin), port: .https, using: parameters)
        upstream = origin
        origin.stateUpdateHandler = { [weak self, weak origin] state in
            guard let self, let origin, !self.closed, self.upstream === origin else { return }
            switch state {
            case .ready:
                guard origin.currentPath?.usesInterfaceType(interface.type) == true else { self.close(); return }
                self.established = true
                self.client.send(content: Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8),
                                 completion: .contentProcessed { [weak self] error in
                    guard let self, !self.closed else { return }
                    guard error == nil else { self.close(); return }
                    self.pump(from: origin, to: self.client)
                    self.forward(early, eof: eof, from: self.client, to: origin)
                })
            case .failed, .waiting:
                if self.established { self.close(); return }
                self.upstream = nil
                origin.cancel()
                self.connect(interfaces.dropFirst(), early: early, eof: eof)
            case .cancelled: self.close()
            default: break
            }
        }
        origin.start(queue: server.queue)
    }

    private func pump(from: NWConnection, to: NWConnection) {
        from.receive(minimumIncompleteLength: 1, maximumLength: 32_768) { [weak self] data, _, eof, error in
            guard let self, !self.closed else { return }
            if error != nil { self.close(); return }
            self.forward(data, eof: eof, from: from, to: to)
        }
    }

    private func forward(_ data: Data?, eof: Bool, from: NWConnection, to: NWConnection) {
        let next: @Sendable (NWError?) -> Void = { [weak self] error in
            guard let self, !self.closed else { return }
            if error != nil { self.close(); return }
            if eof {
                to.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self] error in
                    guard let self, !self.closed else { return }
                    self.finishedReads += 1
                    if error != nil || self.finishedReads == 2 { self.close() }
                    else {
                        self.server.queue.asyncAfter(deadline: .now() + 300) { [weak self] in self?.close() }
                    }
                })
            } else { self.pump(from: from, to: to) }
        }
        if let data, !data.isEmpty { to.send(content: data, completion: .contentProcessed(next)) }
        else { next(nil) }
    }

    func close() {
        if closed { return }
        closed = true
        client.cancel()
        upstream?.cancel()
        server.remove(id)
    }
}
