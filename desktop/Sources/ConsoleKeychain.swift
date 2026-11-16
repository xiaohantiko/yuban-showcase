import Foundation
import Security

enum ConsoleKeychain {
    static func password(for origin: URL) -> String? {
        var query = item(for: origin)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, let password = String(data: data, encoding: .utf8),
              !password.isEmpty else { return nil }
        return password
    }

    private static func item(for origin: URL) -> [String: Any] {
        // Use the Mac login keychain and its default app access controls.
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.yuban.public-console.cloud-login",
         kSecAttrAccount as String: origin.absoluteString]
    }
}

struct ConsoleLoginCredential: Codable {
    let username: String
    let password: String

    init?(username: String, password: String) {
        let name = username.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
        guard username.utf16.count <= 32,
              name.range(of: #"\A[\p{Han}A-Za-z0-9][\p{Han}A-Za-z0-9._-]{1,31}\z"#, options: .regularExpression) != nil,
              (8...128).contains(password.utf16.count),
              password.range(of: "[A-Za-z]", options: .regularExpression) != nil,
              password.range(of: "[0-9]", options: .regularExpression) != nil,
              password.range(of: #"[\p{C}\p{Zl}\p{Zp}]"#, options: .regularExpression) == nil else { return nil }
        self.username = name
        self.password = password
    }
}

enum ConsoleLoginKeychain {
    private enum ReadError: Error { case unavailable }

    private static func item(for origin: URL) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.yuban.public-console.account-login",
         kSecAttrAccount as String: origin.absoluteString]
    }

    static func load(for origin: URL) throws -> ConsoleLoginCredential? {
        var query = item(for: origin)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, data.count <= 2_048,
              let decoded = try? JSONDecoder().decode(ConsoleLoginCredential.self, from: data),
              let credential = ConsoleLoginCredential(username: decoded.username, password: decoded.password)
        else { throw ReadError.unavailable }
        return credential
    }

    static func save(_ credential: ConsoleLoginCredential, for origin: URL) -> Bool {
        guard let data = try? JSONEncoder().encode(credential) else { return false }
        let query = item(for: origin)
        let values = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }

        var newItem = query
        newItem[kSecValueData as String] = data
        let added = SecItemAdd(newItem as CFDictionary, nil)
        if added == errSecDuplicateItem {
            return SecItemUpdate(query as CFDictionary, values as CFDictionary) == errSecSuccess
        }
        return added == errSecSuccess
    }

    static func forget(for origin: URL) -> Bool {
        let status = SecItemDelete(item(for: origin) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
