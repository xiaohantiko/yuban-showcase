import AppKit
import SwiftUI

private typealias ViewState<Value> = SwiftUI.State<Value>

@main
struct YubanConsoleApp: App {
    var body: some Scene {
        Window("宇伴", id: "console") {
            ConsoleWindow()
                .frame(minWidth: 680, minHeight: 520)
        }
        .defaultSize(width: 1150, height: 780)
        .windowToolbarStyle(.unified(showsTitle: true))
        .windowResizability(.contentMinSize)
    }
}

private struct ConsoleWindow: View {
    private enum ConnectionState {
        case needsAddress
        case checking
        case connected(ConsoleDestination)
        case failed(String)
    }

    @AppStorage("cloudConsoleOrigin") private var savedOrigin = ""
    @ViewState private var connection = ConnectionState.checking
    @ViewState private var connectionAttempt = UUID()
    @ViewState private var showsConnection = false

    private var connectionAddress: String {
        if !savedOrigin.isEmpty { return savedOrigin }
        return ConsoleDestination.bundled?.origin.absoluteString ?? ""
    }

    var body: some View {
        Group {
            switch connection {
            case .needsAddress:
                connectionNotice("连接云端管理台", "填写部署者提供的宇伴 HTTPS 地址，即可登录或注册。", systemImage: "cloud") {
                    Button("填写云端地址") { showsConnection = true }
                        .keyboardShortcut(.defaultAction)
                }
            case .checking:
                VStack(spacing: 12) {
                    ProgressView()
                    Text("正在检查云端账号服务…").foregroundStyle(.secondary)
                }
            case .connected(let destination):
                ConsoleWebView(destination: destination) { message in
                    if case .connected(let current) = connection, current == destination {
                        connection = .failed(message)
                    }
                }
            case .failed(let message):
                connectionNotice("无法打开管理台", message, systemImage: "cloud.slash") {
                    Button("修改云端地址") { showsConnection = true }
                    Button("重试") { connectionAttempt = UUID() }
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .task(id: connectionAttempt) { await openCloud(attempt: connectionAttempt) }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showsConnection = true
                } label: {
                    Label("云端连接", systemImage: "cloud")
                }
                .help("设置云端管理台地址")
                .keyboardShortcut("k", modifiers: [.command, .shift])
            }
        }
        .sheet(isPresented: $showsConnection) {
            ConnectionSheet(address: connectionAddress, savedDestination: ConsoleDestination(connectionAddress)) { destination in
                savedOrigin = destination.origin.absoluteString
                showsConnection = false
                connectionAttempt = UUID()
            }
        }
    }

    @MainActor
    private func openCloud(attempt: UUID) async {
        let address = connectionAddress
        guard let destination = ConsoleDestination(address) else {
            connection = address.isEmpty
                ? .needsAddress
                : .failed("已保存的地址无效。请重新填写宇伴管理台的 HTTPS 根地址。")
            return
        }
        connection = .checking
        do {
            try await ConsoleProbe.verify(destination)
            if !Task.isCancelled, connectionAttempt == attempt { connection = .connected(destination) }
        } catch {
            guard !Task.isCancelled, connectionAttempt == attempt else { return }
            let message = (error as? ConsoleProbeError)?.localizedDescription
                ?? "请检查云端地址、网络和 HTTPS 证书，然后重试。"
            connection = .failed(message)
        }
    }

    private func connectionNotice<Actions: View>(_ title: String, _ message: String, systemImage: String,
                                                   @ViewBuilder actions: () -> Actions) -> some View {
        VStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 32, weight: .light))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(title).font(.title2.weight(.semibold))
            Text(message)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 370)
            HStack(content: actions).padding(.top, 4)
        }
        .padding(22)
    }
}

private struct ConnectionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @FocusState private var addressFocused: Bool
    @ViewState var address: String
    let savedDestination: ConsoleDestination?
    let connect: (ConsoleDestination) -> Void
    @ViewState private var copyMessage: String?

    private var destination: ConsoleDestination? { ConsoleDestination(address) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("云端连接", systemImage: "cloud")
                .font(.title2.weight(.semibold))
            VStack(alignment: .leading, spacing: 6) {
                Text("管理台地址").font(.headline)
                TextField("https://yuban.example.com", text: $address)
                    .textFieldStyle(.roundedBorder)
                    .focused($addressFocused)
                    .accessibilityLabel("云端管理台 HTTPS 地址")
                    .onSubmit { if let destination { connect(destination) } }
                Text("填写宇伴管理台的 HTTPS 根地址。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let savedDestination, destination == savedDestination {
                VStack(alignment: .leading, spacing: 6) {
                    Button("复制旧版管理口令") { copyLegacyPassword(for: savedDestination.origin) }
                    Text(copyMessage ?? "只有认领原有管理台时才需要旧版口令。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            HStack {
                Spacer()
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("保存并连接") { if let destination { connect(destination) } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(destination == nil)
            }
            .padding(.top, 4)
        }
        .padding(26)
        .frame(width: 492)
        .onAppear { addressFocused = true }
    }

    private func copyLegacyPassword(for origin: URL) {
        guard let password = ConsoleKeychain.password(for: origin) else {
            copyMessage = "这台 Mac 没有保存此地址的旧版管理口令。"
            return
        }
        let pasteboard = NSPasteboard.general
        pasteboard.prepareForNewContents(with: .currentHostOnly)
        guard pasteboard.setString(password, forType: .string) else {
            copyMessage = "复制失败，请重试。"
            return
        }
        copyMessage = "已复制到本机剪贴板，请在一分钟内粘贴。"
        let changeCount = pasteboard.changeCount
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
            if pasteboard.changeCount == changeCount { pasteboard.clearContents() }
        }
    }
}
